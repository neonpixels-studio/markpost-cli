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

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

import {
  assertPathIsCommitted,
  cloneMarkpostInto,
  parseFromPathArg,
  readCommitHashForPath,
  resolveSourceRepo,
} from './lib/markpost-checkout.mjs';

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

  assertPathIsCommitted(checkoutDir, CONTRACT_RELATIVE_PATH);
  const sourceCommit = readCommitHashForPath(
    checkoutDir,
    CONTRACT_RELATIVE_PATH,
  );
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
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}

export { assertContractIsTypeOnly, parseFromPathArg };
