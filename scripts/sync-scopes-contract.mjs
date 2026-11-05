#!/usr/bin/env node
// Human-run tool: vendors the names of markpost's API token scope catalog
// (the `SCOPES` array in `shared/utils/scopes.ts`) into
// `src/types/vendor/markpost-scopes.generated.ts`, so `tokens create|update
// --scopes` can validate against markpost's real allowlist without a
// hand-maintained copy. Unlike the settings/source syncs, this vendored file
// lives under `src/` because the CLI needs it at runtime, not just in a
// drift test.
//
// `scopes.ts` can't be vendored verbatim (its `SCOPES` array is typed with a
// local `Scope` type and carries descriptions the CLI has no use for), so
// this extracts just each entry's `name` string literal.
//
// This intentionally does NOT run in CI or the test suite: it needs network
// access (or a local markpost checkout). Run it by hand whenever markpost's
// scope catalog changes, review the diff, then commit.
//
// Usage:
//   npm run sync:scopes-contract                     # clones markpost fresh (full history, blobless)
//   npm run sync:scopes-contract -- --from <path>    # copies from an existing local checkout
//   npm run sync:scopes-contract -- --from=<path>    # same, `=` form

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

import { parseFromPathArg } from './sync-contract.mjs';
import {
  assertPathIsCommitted,
  parseTypeScriptSource,
  readCommitHash,
  readSource,
  resolveSourceRepo,
  withMarkpostCheckout,
  writeManifest,
} from './lib/markpost-checkout.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');
const VENDOR_DIR = join(REPO_ROOT, 'src/types/vendor');
const VENDOR_FILE = join(VENDOR_DIR, 'markpost-scopes.generated.ts');
const MANIFEST_FILE = join(VENDOR_DIR, 'markpost-scopes.manifest.json');

const SCOPES_SOURCE_PATH = 'shared/utils/scopes.ts';
const SCOPES_DECLARATION_NAME = 'SCOPES';

const VENDOR_FILE_HEADER = `// GENERATED FILE — do not hand-edit.
//
// SCOPE_NAMES is the list of \`name\` values in the \`${SCOPES_DECLARATION_NAME}\`
// array of markpost's \`${SCOPES_SOURCE_PATH}\`, which is the source of truth
// for the token scope allowlist.
//
// Regenerate with \`npm run sync:scopes-contract\` (see
// README.md#scopes-contract-sync). Review the diff, then commit.
//
// See src/types/vendor/markpost-scopes.manifest.json for the exact commit
// this was synced from.

`;

// Unwraps `as const`, `satisfies X` and parens, however many are nested.
function unwrapTypeAssertions(expression) {
  let current = expression;

  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }

  return current;
}

function findScopesInitializer(sourceFile) {
  const declaration = sourceFile.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations)
    .find(
      (candidate) =>
        candidate.name.getText(sourceFile) === SCOPES_DECLARATION_NAME,
    );

  if (!declaration?.initializer) {
    return undefined;
  }

  return unwrapTypeAssertions(declaration.initializer);
}

function readScopeName(element) {
  if (!ts.isObjectLiteralExpression(element)) {
    return undefined;
  }

  const nameProperty = element.properties.find(
    (property) =>
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === 'name' &&
      ts.isStringLiteralLike(property.initializer),
  );

  return nameProperty?.initializer.text;
}

// Extracts the scope names from markpost's `SCOPES` array. Exported so
// tests/scripts/sync-scopes-contract.test.ts can exercise it without
// touching the network.
export function extractScopeNames(source) {
  const sourceFile = parseTypeScriptSource(SCOPES_SOURCE_PATH, source);
  const initializer = findScopesInitializer(sourceFile);

  if (!initializer || !ts.isArrayLiteralExpression(initializer)) {
    throw new Error(
      `${SCOPES_SOURCE_PATH} no longer declares ${SCOPES_DECLARATION_NAME} as an ` +
        'array literal — markpost renamed or restructured the scope catalog; ' +
        'update scripts/sync-scopes-contract.mjs to match',
    );
  }

  const names = initializer.elements.map((element) => readScopeName(element));

  if (names.length === 0 || names.some((name) => name === undefined)) {
    throw new Error(
      `${SCOPES_SOURCE_PATH}'s ${SCOPES_DECLARATION_NAME} array is empty or has an ` +
        'entry without a string-literal `name` — update ' +
        'scripts/sync-scopes-contract.mjs to match',
    );
  }

  if (new Set(names).size !== names.length) {
    throw new Error(
      `${SCOPES_SOURCE_PATH}'s ${SCOPES_DECLARATION_NAME} array lists the same scope name twice — fix it upstream before syncing`,
    );
  }

  return names;
}

export function renderScopesFile(names) {
  const lines = names.map((name) => `  ${JSON.stringify(name)},`);

  return [
    VENDOR_FILE_HEADER.trimEnd(),
    '',
    'export const SCOPE_NAMES = [',
    ...lines,
    '] as const;',
    '',
    'export type ScopeName = (typeof SCOPE_NAMES)[number];',
    '',
  ].join('\n');
}

function syncFrom(checkoutDir) {
  const names = extractScopeNames(readSource(checkoutDir, SCOPES_SOURCE_PATH));

  assertPathIsCommitted(checkoutDir, SCOPES_SOURCE_PATH);

  const sourceRepo = resolveSourceRepo(checkoutDir);
  const syncedFiles = [
    {
      path: SCOPES_SOURCE_PATH,
      sourceCommit: readCommitHash(checkoutDir, SCOPES_SOURCE_PATH),
    },
  ];

  mkdirSync(VENDOR_DIR, { recursive: true });
  writeFileSync(VENDOR_FILE, renderScopesFile(names));
  writeManifest(MANIFEST_FILE, sourceRepo, syncedFiles);
}

function main() {
  const fromPath = parseFromPathArg(process.argv.slice(2));

  withMarkpostCheckout(fromPath, 'markpost-scopes-contract-sync-', (dir) => {
    syncFrom(dir);
    console.log(`Synced ${VENDOR_FILE} from ${dir}`);
    console.log(
      'Review the diff, then run `npm run build` and `npm test` before committing.',
    );
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
