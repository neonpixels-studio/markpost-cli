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
//   npm run sync:source-contract                     # clones markpost fresh (full history, blobless)
//   npm run sync:source-contract -- --from <path>    # copies from an existing local checkout
//   npm run sync:source-contract -- --from=<path>    # same, `=` form

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

import { parseFromPathArg } from './sync-contract.mjs';
import {
  assertPathIsCommitted,
  hasExportModifier,
  parseTypeScriptSource,
  readCommitHash,
  readSource,
  resolveSourceRepo,
  withMarkpostCheckout,
  writeManifest,
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
// whole-file copy stays trivially compilable in isolation. `requiredExports`
// is what the drift test (tests/types/sources.types.test.ts) actually
// imports from the vendored copy — checked at sync time so a markpost rename
// fails here, with a pointer to what changed, instead of surfacing later as
// an opaque "does not provide an export named" module error.
const VENDORED_FILES = [
  {
    sourceRelativePath: 'shared/utils/sourceTypes.ts',
    vendorFileName: 'markpost-source-types.generated.ts',
    description: "markpost's canonical source-type list",
    requiredExports: ['SOURCE_TYPES'],
  },
  {
    sourceRelativePath: 'shared/utils/webhookSecrets.ts',
    vendorFileName: 'markpost-webhook-secrets.generated.ts',
    description: "markpost's webhook-secret provider classification",
    requiredExports: [
      'MANUAL_SECRET_PROVIDER_IDS',
      'SECRET_BACKED_PROVIDER_IDS',
      'ROTATABLE_PROVIDER_IDS',
    ],
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
// Takes an already-parsed `sourceFile` (see parseTypeScriptSource) so
// resolveFilesToSync below parses each file once, not once per assertion.
export function assertFileHasNoImports(sourceFile, sourceRelativePath) {
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

// A local re-export (`const SOURCE_TYPES = [...]; export { SOURCE_TYPES };`)
// is just as valid and verbatim-vendorable as an inline `export const` — it
// has no `moduleSpecifier` (that's `export { x } from './other'`, which
// re-exports someone else's declaration and wouldn't be self-contained here).
function namesFromLocalReExport(statement) {
  if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier) {
    return [];
  }

  if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
    return [];
  }

  return statement.exportClause.elements.map((element) => element.name.text);
}

function exportedTopLevelNames(sourceFile) {
  const inlineExportNames = sourceFile.statements
    .filter(
      (statement) =>
        hasExportModifier(statement) &&
        (ts.isVariableStatement(statement) ||
          ts.isFunctionDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement)),
    )
    .flatMap((statement) => {
      if (ts.isVariableStatement(statement)) {
        return statement.declarationList.declarations.map((declaration) =>
          declaration.name.getText(sourceFile),
        );
      }

      return statement.name ? [statement.name.getText(sourceFile)] : [];
    });

  const localReExportNames = sourceFile.statements.flatMap(
    namesFromLocalReExport,
  );

  return [...inlineExportNames, ...localReExportNames];
}

// Confirms every name the drift test imports from the vendored file is still
// exported, so a markpost rename/removal fails here — naming exactly what
// changed — instead of as an opaque module-resolution error inside
// tests/types/sources.types.test.ts. Takes an already-parsed `sourceFile`,
// same reasoning as assertFileHasNoImports above.
export function assertRequiredExportsPresent(
  sourceFile,
  sourceRelativePath,
  requiredExports,
) {
  const actualExports = new Set(exportedTopLevelNames(sourceFile));
  const missingExports = requiredExports.filter(
    (exportName) => !actualExports.has(exportName),
  );

  if (missingExports.length > 0) {
    throw new Error(
      `${sourceRelativePath} no longer exports: ${missingExports.join(', ')} — ` +
        'markpost renamed or removed part of the contract; update ' +
        'scripts/sync-source-contract.mjs and src/types/sources.types.ts to match',
    );
  }
}

function writeVendoredFile(vendorFileName, header, source) {
  mkdirSync(VENDOR_DIR, { recursive: true });
  writeFileSync(join(VENDOR_DIR, vendorFileName), `${header}${source}`);
}

// Validates and reads everything for every file first, only writing once
// every file has cleared validation — a failure on the second file (e.g. a
// new import) must not leave the first file's vendored copy updated while
// the manifest (written last, after the loop) still describes the old state.
// This relies on `Array.prototype.map` being eager and synchronous: a throw
// partway through never returns a partial array, so `syncFrom`'s write loop
// below can only ever run once every entry has already cleared validation.
// Exported so tests/scripts/sync-source-contract.test.ts can exercise that
// guarantee directly, without touching the real vendor directory the way an
// end-to-end run of `syncFrom` itself would.
export function resolveFilesToSync(checkoutDir) {
  return VENDORED_FILES.map(
    ({ sourceRelativePath, vendorFileName, description, requiredExports }) => {
      const source = readSource(checkoutDir, sourceRelativePath);
      const sourceFile = parseTypeScriptSource(sourceRelativePath, source);

      assertFileHasNoImports(sourceFile, sourceRelativePath);
      assertRequiredExportsPresent(
        sourceFile,
        sourceRelativePath,
        requiredExports,
      );
      assertPathIsCommitted(checkoutDir, sourceRelativePath);

      return {
        sourceRelativePath,
        vendorFileName,
        source,
        header: vendorFileHeader(sourceRelativePath, description),
        sourceCommit: readCommitHash(checkoutDir, sourceRelativePath),
      };
    },
  );
}

function syncFrom(checkoutDir) {
  const resolvedFiles = resolveFilesToSync(checkoutDir);
  const sourceRepo = resolveSourceRepo(checkoutDir);

  for (const { vendorFileName, header, source } of resolvedFiles) {
    writeVendoredFile(vendorFileName, header, source);
  }

  writeManifest(
    MANIFEST_FILE,
    sourceRepo,
    resolvedFiles.map(({ sourceRelativePath, sourceCommit }) => ({
      path: sourceRelativePath,
      sourceCommit,
    })),
  );
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
