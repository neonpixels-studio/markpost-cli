#!/usr/bin/env node
// Human-run tool: vendors markpost's `server/types/api.types.ts` into
// `src/types/vendor/markpost-api.types.ts` so the CLI's request/response
// types can never silently drift from markpost's real contract again.
//
// This intentionally does NOT run in CI or in the test suite — it needs
// network access (or a local markpost checkout) to fetch the current
// contract, and a test that depends on network access is flaky and fails
// offline. Run it by hand whenever markpost's API contract changes, review
// the diff it produces, then commit the result.
//
// Usage:
//   npm run sync:contract                     # shallow-clones markpost fresh
//   npm run sync:contract -- --from <path>    # copies from an existing local checkout
//   npm run sync:contract -- --from=<path>    # same, `=` form

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const MARKPOST_REPO_URL = 'https://github.com/neonpixels-studio/markpost';
const CONTRACT_RELATIVE_PATH = 'server/types/api.types.ts';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');
const VENDOR_DIR = join(REPO_ROOT, 'src/types/vendor');
const VENDOR_FILE = join(VENDOR_DIR, 'markpost-api.types.ts');
const MANIFEST_FILE = join(VENDOR_DIR, 'manifest.json');

const VENDOR_FILE_HEADER = `// GENERATED FILE — do not hand-edit.
//
// This is a vendored, verbatim copy of markpost's \`server/types/api.types.ts\`.
// markpost is the source of truth for the request/response contract; the CLI
// mirrors it here instead of re-deriving it by hand so the two can't quietly
// drift apart the way \`ApiData\` (attributes+errors on one object) did before.
//
// Regenerate with \`npm run sync:contract\` (see README.md#contract-sync).
// The drift test at tests/types/contract-drift.test.ts fails if this file's
// exports or the CLI's usage of them stop lining up.
//
// Source: neonpixels-studio/markpost @ ${CONTRACT_RELATIVE_PATH}
// See src/types/vendor/manifest.json for the exact commit this was synced from.

`;

// Accepts both `--from <path>` and `--from=<path>`. A typo'd flag (e.g.
// `--form`, or a near-miss like `--fromage`) must fail loudly rather than
// silently falling through to a network clone that overwrites the vendored
// file from upstream `main` instead of the checkout the caller actually
// meant, so this whitelists the exact `--from`/`--from=<path>` tokens (and
// the path value immediately after a bare `--from`) rather than anything
// merely prefixed with `--from`. This check runs unconditionally (not just
// on the no-`--from` path) so `--from ../markpost --dry-run` doesn't
// silently ignore the typo'd `--dry-run` and proceed.
function parseFromPathArg(argv) {
  const spaceFlagIndex = argv.indexOf('--from');
  // The index directly after a bare `--from` is its path value, not a
  // separate argument to validate — but only when `--from` is actually
  // present (`-1 + 1 === 0` would otherwise wrongly exempt argv[0]).
  const pathValueIndex = spaceFlagIndex === -1 ? undefined : spaceFlagIndex + 1;
  const unrecognized = argv.filter(
    (argument, index) =>
      argument !== '--from' &&
      !argument.startsWith('--from=') &&
      index !== pathValueIndex,
  );

  if (unrecognized.length > 0) {
    throw new Error(`Unrecognized argument(s): ${unrecognized.join(', ')}`);
  }

  // A duplicated `--from` (either form, or a mix of both) must not silently
  // pick one occurrence and drop the other — that's the same
  // wrong-checkout-gets-vendored risk the whitelist above exists to prevent.
  const fromOccurrences = argv.filter(
    (argument) => argument === '--from' || argument.startsWith('--from='),
  ).length;

  if (fromOccurrences > 1) {
    throw new Error('--from may only be given once');
  }

  const equalsFlag = argv.find((argument) => argument.startsWith('--from='));

  if (!equalsFlag && spaceFlagIndex === -1) {
    return undefined;
  }

  const fromPath = equalsFlag
    ? equalsFlag.slice('--from='.length)
    : argv[spaceFlagIndex + 1];

  if (!fromPath || fromPath.startsWith('--')) {
    throw new Error('--from requires a path to a local markpost checkout');
  }

  if (!existsSync(fromPath)) {
    throw new Error(`--from path does not exist: ${fromPath}`);
  }

  return fromPath;
}

function cloneMarkpostInto(cloneDir) {
  execFileSync('git', ['clone', '--depth', '1', MARKPOST_REPO_URL, cloneDir], {
    stdio: 'inherit',
  });
}

function assertContractIsCommitted(checkoutDir) {
  const status = execFileSync(
    'git',
    ['status', '--porcelain', '--', CONTRACT_RELATIVE_PATH],
    { cwd: checkoutDir, encoding: 'utf-8' },
  ).trim();

  if (!status) {
    return;
  }

  throw new Error(
    `${CONTRACT_RELATIVE_PATH} has uncommitted changes in ${checkoutDir} — ` +
      'commit them first so manifest.json records the commit the vendored file actually came from',
  );
}

// The commit that actually last touched the contract file, not just
// whatever HEAD happens to be — keeps the manifest diff stable across
// upstream commits that don't touch `server/types/api.types.ts`. `git log`
// exits 0 with empty stdout when the path has no commits in this checkout
// (e.g. the file is present but git-ignored, or this isn't the checkout's
// repo root) — that's exactly the case the manifest's provenance claim
// needs to fail on, not silently record as `sourceCommit: ""`.
function readCommitHash(checkoutDir) {
  const commitHash = execFileSync(
    'git',
    ['log', '-1', '--format=%H', '--', CONTRACT_RELATIVE_PATH],
    { cwd: checkoutDir, encoding: 'utf-8' },
  ).trim();

  if (!commitHash) {
    throw new Error(
      `No commit history found for ${CONTRACT_RELATIVE_PATH} in ${checkoutDir} — ` +
        'is this a markpost git checkout?',
    );
  }

  return commitHash;
}

// Resolves the checkout's real `origin` remote so a `--from` sync against a
// fork or a local branch records provenance the manifest can actually be
// verified against, instead of hardcoding `neonpixels-studio/markpost` for a commit
// that may not exist there. Falls back to the absolute local path when the
// checkout has no `origin` remote (e.g. a bare local clone).
function resolveSourceRepo(checkoutDir) {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: checkoutDir,
      encoding: 'utf-8',
    }).trim();
  } catch {
    return resolve(checkoutDir);
  }
}

function readContractSource(checkoutDir) {
  const contractSourcePath = join(checkoutDir, CONTRACT_RELATIVE_PATH);

  if (!existsSync(contractSourcePath)) {
    throw new Error(
      `No ${CONTRACT_RELATIVE_PATH} found in ${checkoutDir} — is this a markpost checkout?`,
    );
  }

  return readFileSync(contractSourcePath, 'utf-8');
}

// True for an `import` statement that carries no runtime value: either the
// whole clause is `import type ...`, or (for a named-imports clause) every
// individual specifier carries its own inline `type` modifier, e.g.
// `import { type Foo } from './shared'`.
function isTypeOnlyImport(statement) {
  const importClause = statement.importClause;

  // A bare `import './shared';` has no clause at all — it's a
  // side-effecting import by definition, never type-only.
  if (!importClause) {
    return false;
  }

  if (importClause.isTypeOnly) {
    return true;
  }

  // A default binding (`import Foo, { type Bar } from ...`) is always a
  // runtime value, regardless of whether every *named* specifier alongside
  // it is type-only — check this before the named-bindings branch below, or
  // `Foo` slips through as long as `Bar` carries an inline `type` modifier.
  if (importClause.name) {
    return false;
  }

  if (
    importClause.namedBindings &&
    ts.isNamedImports(importClause.namedBindings)
  ) {
    return importClause.namedBindings.elements.every(
      (element) => element.isTypeOnly,
    );
  }

  return false;
}

// The vendored file gets compiled straight into the published CLI's `dist`,
// so nothing today stops a future runtime statement or side-effecting
// import in markpost's contract file from riding along silently — the diff
// review is the only guard, and it's human. Refuse to vendor anything but
// type-only declarations (type aliases, interfaces, type-only imports and
// re-exports) so that gap fails loudly at sync time instead.
function assertContractIsTypeOnly(contractSource) {
  // `setParentNodes: true` so each statement's `.getStart()` below can
  // resolve its position without needing the source file passed explicitly.
  const sourceFile = ts.createSourceFile(
    CONTRACT_RELATIVE_PATH,
    contractSource,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  const runtimeStatements = sourceFile.statements.filter((statement) => {
    if (
      ts.isTypeAliasDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement)
    ) {
      return false;
    }

    if (ts.isImportDeclaration(statement)) {
      return !isTypeOnlyImport(statement);
    }

    // `export type { Foo } from './shared'` and `export * from './shared'`
    // (with `isTypeOnly` set) are both fully erased at compile time, same
    // as a type-only import.
    if (ts.isExportDeclaration(statement)) {
      return !statement.isTypeOnly;
    }

    return true;
  });

  if (runtimeStatements.length > 0) {
    throw new Error(
      `${CONTRACT_RELATIVE_PATH} contains non-type declaration(s) at line(s) ` +
        `${runtimeStatements
          .map(
            (statement) =>
              sourceFile.getLineAndCharacterOfPosition(statement.getStart())
                .line + 1,
          )
          .join(', ')} — refusing to vendor a file that isn't type-only`,
    );
  }
}

function writeVendoredContract(contractSource) {
  assertContractIsTypeOnly(contractSource);

  mkdirSync(VENDOR_DIR, { recursive: true });
  writeFileSync(VENDOR_FILE, `${VENDOR_FILE_HEADER}${contractSource}`);
}

function writeManifest(sourceRepo, sourceCommit) {
  const manifest = {
    sourceRepo,
    sourceFile: CONTRACT_RELATIVE_PATH,
    sourceCommit,
    syncedAt: new Date().toISOString(),
  };

  mkdirSync(VENDOR_DIR, { recursive: true });
  writeFileSync(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
}

// Resolves everything that can fail (missing contract file, uncommitted
// changes to it, `git rev-parse`) before writing anything, so a mid-sync
// failure can't leave the vendored file and the manifest's `sourceCommit`
// out of sync with each other, or a claimed provenance the checkout doesn't
// actually match. Checks the contract file first so a non-markpost
// directory gets the friendly "is this a markpost checkout?" message
// instead of a raw git error.
function syncFrom(checkoutDir) {
  const contractSource = readContractSource(checkoutDir);

  assertContractIsCommitted(checkoutDir);
  const sourceCommit = readCommitHash(checkoutDir);
  const sourceRepo = resolveSourceRepo(checkoutDir);

  writeVendoredContract(contractSource);
  writeManifest(sourceRepo, sourceCommit);
}

function main() {
  const fromPath = parseFromPathArg(process.argv.slice(2));
  // Own the temp directory here (not inside a clone helper) so the `finally`
  // below covers a clone that fails partway through, not just a successful one.
  const temporaryCloneDir = fromPath
    ? undefined
    : mkdtempSync(join(tmpdir(), 'markpost-contract-sync-'));

  try {
    if (temporaryCloneDir) {
      cloneMarkpostInto(temporaryCloneDir);
    }

    const checkoutDir = fromPath ?? temporaryCloneDir;

    syncFrom(checkoutDir);
    console.log(`Synced ${VENDOR_FILE} from ${checkoutDir}`);
    console.log(
      'Review the diff, then run `npm run build` and `npm test` before committing.',
    );
  } finally {
    if (temporaryCloneDir) {
      rmSync(temporaryCloneDir, { recursive: true, force: true });
    }
  }
}

// Only run when executed directly (`node scripts/sync-contract.mjs` /
// `npm run sync:contract`), not when imported — this module is imported by
// tests/scripts/sync-contract.test.ts to unit-test the pure parsing and
// validation logic below without touching the network. `pathToFileURL`
// (rather than a raw `file://` template) percent-encodes `process.argv[1]`
// the same way `import.meta.url` already is, so this still matches on a
// checkout path containing a space or other reserved character.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { assertContractIsTypeOnly, parseFromPathArg };
