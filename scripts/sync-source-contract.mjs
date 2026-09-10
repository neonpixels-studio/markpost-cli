#!/usr/bin/env node
// Human-run tool: vendors markpost's `shared/utils/sourceTypes.ts` and
// `shared/utils/webhookSecrets.ts` into `tests/types/vendor/` so
// `src/types/sources.types.ts` (SOURCE_TYPES, MANUAL_SECRET_PROVIDERS,
// SECRET_BACKED_PROVIDERS, ROTATABLE_PROVIDERS) can never silently drift from
// markpost's real source-type and webhook-secret-classification contracts
// again. Before this script, both lists were hand-mirrored with a test that
// only hardcoded today's values — the exact class of bug that shipped in
// markpost-cli#78 (this file listed a source type, `rss`, that markpost had
// already dropped).
//
// This intentionally does NOT run in CI or the test suite — it needs network
// access (or a local markpost checkout) to fetch the current contract, and a
// test that depends on network access is flaky and fails offline. Run it by
// hand whenever markpost's source-type or webhook-secret contract changes,
// review the diff it produces, then commit the result.
//
// Usage:
//   npm run sync:source-contract                     # shallow-clones markpost fresh
//   npm run sync:source-contract -- --from <path>    # copies from an existing local checkout
//   npm run sync:source-contract -- --from=<path>    # same, `=` form

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

import { parseFromPathArg } from './sync-contract.mjs';
import {
  assertPathIsCommitted,
  readCommitHash,
  resolveSourceRepo,
  withMarkpostCheckout,
} from './lib/markpost-checkout.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');
const VENDOR_DIR = join(REPO_ROOT, 'tests/types/vendor');
const MANIFEST_FILE = join(
  VENDOR_DIR,
  'markpost-source-contract.manifest.json',
);

// Both files are vendored verbatim (not extracted piecemeal like the
// markdown-serialization slice) because each is already the *entire*
// contract — every export in them is something sources.types.ts mirrors —
// and each is self-contained (see assertFileHasNoImports below), so a
// whole-file copy stays trivially compilable in isolation.
const VENDORED_FILES = [
  {
    sourceRelativePath: 'shared/utils/sourceTypes.ts',
    vendorFileName: 'markpost-source-types.generated.ts',
    description: "markpost's canonical source-type list",
  },
  {
    sourceRelativePath: 'shared/utils/webhookSecrets.ts',
    vendorFileName: 'markpost-webhook-secrets.generated.ts',
    description: "markpost's webhook-secret provider classification",
  },
];

function vendorFileHeader(sourceRelativePath, description) {
  return `// GENERATED FILE — do not hand-edit.
//
// This is a vendored, verbatim copy of markpost's \`${sourceRelativePath}\`
// (${description}). markpost is the source of truth; \`src/types/sources.types.ts\`
// mirrors it by hand, and the drift test at
// \`tests/types/sources.types.test.ts\` fails if that mirror stops matching
// this file.
//
// Regenerate with \`npm run sync:source-contract\` (see
// README.md#source-and-settings-contract-sync). Review the diff, then commit.
//
// Source: neonpixels-studio/markpost @ ${sourceRelativePath}
// See tests/types/vendor/markpost-source-contract.manifest.json for the
// exact commit this was synced from.

`;
}

// The vendored copy is plain, import-free source dropped straight into
// tests/types/vendor/ with no bundler resolving its module graph — a future
// markpost change that adds an import (even a type-only one) would silently
// leave a broken vendored file behind with only a follow-up compile error to
// explain why. Fail loudly at sync time instead, the same way
// assertContractIsTypeOnly in sync-contract.mjs guards its own vendored file.
export function assertFileHasNoImports(source, sourceRelativePath) {
  const sourceFile = ts.createSourceFile(
    sourceRelativePath,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    ts.ScriptKind.TS,
  );

  const importStatements = sourceFile.statements.filter((statement) =>
    ts.isImportDeclaration(statement),
  );

  if (importStatements.length > 0) {
    throw new Error(
      `${sourceRelativePath} now has an import — it can no longer be vendored ` +
        'verbatim as a standalone file. Update scripts/sync-source-contract.mjs ' +
        'to extract just the relevant declarations instead (see ' +
        'scripts/sync-markdown-serialization.mjs for that pattern).',
    );
  }
}

function readSource(checkoutDir, sourceRelativePath) {
  const sourcePath = join(checkoutDir, sourceRelativePath);

  if (!existsSync(sourcePath)) {
    throw new Error(
      `No ${sourceRelativePath} found in ${checkoutDir} — is this a markpost checkout?`,
    );
  }

  return readFileSync(sourcePath, 'utf-8');
}

function writeVendoredFile(vendorFileName, header, source) {
  mkdirSync(VENDOR_DIR, { recursive: true });
  writeFileSync(join(VENDOR_DIR, vendorFileName), `${header}${source}`);
}

function writeManifest(sourceRepo, syncedFiles) {
  const manifest = {
    sourceRepo,
    sourceFiles: syncedFiles,
    syncedAt: new Date().toISOString(),
  };

  mkdirSync(VENDOR_DIR, { recursive: true });
  writeFileSync(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
}

// Resolves everything that can fail (missing files, non-type-only... i.e.
// non-import-free content, uncommitted changes) before writing anything, so
// a mid-sync failure can't leave one vendored file updated and the other
// stale, or a manifest that disagrees with what's on disk.
function syncFrom(checkoutDir) {
  const sourceRepo = resolveSourceRepo(checkoutDir);
  const syncedFiles = [];

  for (const {
    sourceRelativePath,
    vendorFileName,
    description,
  } of VENDORED_FILES) {
    const source = readSource(checkoutDir, sourceRelativePath);

    assertFileHasNoImports(source, sourceRelativePath);
    assertPathIsCommitted(checkoutDir, sourceRelativePath);

    const sourceCommit = readCommitHash(checkoutDir, sourceRelativePath);

    writeVendoredFile(
      vendorFileName,
      vendorFileHeader(sourceRelativePath, description),
      source,
    );
    syncedFiles.push({ path: sourceRelativePath, sourceCommit });
  }

  writeManifest(sourceRepo, syncedFiles);
}

function main() {
  const fromPath = parseFromPathArg(process.argv.slice(2));

  withMarkpostCheckout(
    fromPath,
    'markpost-source-contract-sync-',
    (checkoutDir) => {
      syncFrom(checkoutDir);
      console.log(`Synced ${VENDOR_DIR} from ${checkoutDir}`);
      console.log(
        'Review the diff, then run `npm run build` and `npm test` before committing.',
      );
    },
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
