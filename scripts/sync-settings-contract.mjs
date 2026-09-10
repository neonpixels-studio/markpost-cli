#!/usr/bin/env node
// Human-run tool: vendors markpost's `CONFLICT_STRATEGIES` enum (from
// `server/utils/response.ts`) and the `user_settings` table's column
// defaults (from `server/db/schema.ts`) into
// `tests/types/vendor/markpost-settings-contract.generated.ts`, so
// `src/types/settings.types.ts` (CONFLICT_STRATEGIES,
// DEFAULT_CONFLICT_STRATEGY, DEFAULT_AUTO_DELETE, DEFAULT_AUTO_SYNC,
// DEFAULT_FRONTMATTER_ENABLED) can never silently drift from markpost's real
// settings contract again.
//
// Unlike sync-source-contract.mjs, neither source file can be vendored
// verbatim: response.ts pulls in unrelated record/pagination types, and
// schema.ts is a full drizzle table definition the CLI has no use for beyond
// four default values. So this extracts just the relevant declaration
// (CONFLICT_STRATEGIES) and just the relevant column defaults, the same way
// sync-markdown-serialization.mjs extracts a slice instead of a whole file.
//
// This intentionally does NOT run in CI or the test suite — it needs network
// access (or a local markpost checkout) to fetch the current contract, and a
// test that depends on network access is flaky and fails offline. Run it by
// hand whenever markpost's settings contract changes, review the diff it
// produces, then commit the result.
//
// Usage:
//   npm run sync:settings-contract                     # shallow-clones markpost fresh
//   npm run sync:settings-contract -- --from <path>    # copies from an existing local checkout
//   npm run sync:settings-contract -- --from=<path>    # same, `=` form

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
const VENDOR_FILE = join(VENDOR_DIR, 'markpost-settings-contract.generated.ts');
const MANIFEST_FILE = join(
  VENDOR_DIR,
  'markpost-settings-contract.manifest.json',
);

const CONFLICT_STRATEGIES_SOURCE_PATH = 'server/utils/response.ts';
const CONFLICT_STRATEGIES_DECLARATION_NAME = 'CONFLICT_STRATEGIES';

const SCHEMA_SOURCE_PATH = 'server/db/schema.ts';
const USER_SETTINGS_TABLE_VARIABLE = 'userSettings';
// The subset of `user_settings` columns settings.types.ts actually mirrors a
// default for (vaultDir/filenameTemplate/theme/accentColor are plain strings
// the CLI never falls back on — see the comment on UpdateSettingsInput).
const DEFAULT_COLUMN_NAMES = [
  'autoSync',
  'autoDelete',
  'frontmatter',
  'conflictStrategy',
];

const VENDOR_FILE_HEADER = `// GENERATED FILE — do not hand-edit.
//
// CONFLICT_STRATEGIES below is a verbatim copy of markpost's
// \`${CONFLICT_STRATEGIES_SOURCE_PATH}\` export of the same name.
// USER_SETTINGS_DEFAULTS is assembled from the \`.default(...)\` values on the
// matching columns of markpost's \`${USER_SETTINGS_TABLE_VARIABLE}\` table in
// \`${SCHEMA_SOURCE_PATH}\`. markpost is the source of truth for both;
// \`src/types/settings.types.ts\` mirrors them by hand, and the drift test at
// \`tests/types/settings.types.test.ts\` fails if that mirror stops matching
// this file.
//
// Regenerate with \`npm run sync:settings-contract\` (see
// README.md#source-and-settings-contract-sync). Review the diff, then commit.
//
// See tests/types/vendor/markpost-settings-contract.manifest.json for the
// exact commits this was synced from.

`;

function readSource(checkoutDir, sourceRelativePath) {
  const sourcePath = join(checkoutDir, sourceRelativePath);

  if (!existsSync(sourcePath)) {
    throw new Error(
      `No ${sourceRelativePath} found in ${checkoutDir} — is this a markpost checkout?`,
    );
  }

  return readFileSync(sourcePath, 'utf-8');
}

function parseSource(sourceRelativePath, source) {
  return ts.createSourceFile(
    sourceRelativePath,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
}

function isExported(statement) {
  return (
    statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    ) ?? false
  );
}

// Extracts `export const CONFLICT_STRATEGIES = [...] as const;` verbatim
// from response.ts, ignoring the rest of the file (pagination/record types
// the CLI has no stake in). Exported so
// tests/scripts/sync-settings-contract.test.ts can exercise it without
// touching the network.
export function extractConflictStrategiesDeclaration(source) {
  const sourceFile = parseSource(CONFLICT_STRATEGIES_SOURCE_PATH, source);

  const statement = sourceFile.statements.find(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (declaration) =>
          declaration.name.getText(sourceFile) ===
          CONFLICT_STRATEGIES_DECLARATION_NAME,
      ),
  );

  if (!statement) {
    throw new Error(
      `${CONFLICT_STRATEGIES_SOURCE_PATH} no longer declares ` +
        `${CONFLICT_STRATEGIES_DECLARATION_NAME} — markpost renamed or removed ` +
        'the conflict-strategy enum; update scripts/sync-settings-contract.mjs ' +
        'and src/types/settings.types.ts to match',
    );
  }

  const text = statement.getText(sourceFile);

  return isExported(statement) ? text : `export ${text}`;
}

// Walks a column builder chain (e.g. `boolean("auto_sync").notNull().default(true)`)
// looking for the call to `.default(...)`, however many modifier calls
// (`.notNull()`, `.primaryKey()`, ...) sit in between it and the base column
// constructor. Returns undefined if the chain has no `.default(...)` call.
function findDefaultCall(expression) {
  if (!ts.isCallExpression(expression)) {
    return undefined;
  }

  if (
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === 'default'
  ) {
    return expression;
  }

  if (ts.isPropertyAccessExpression(expression.expression)) {
    return findDefaultCall(expression.expression.expression);
  }

  return undefined;
}

function literalToJsValue(node, columnName) {
  if (node.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  }

  if (node.kind === ts.SyntaxKind.FalseKeyword) {
    return false;
  }

  if (ts.isStringLiteralLike(node)) {
    return node.text;
  }

  throw new Error(
    `${SCHEMA_SOURCE_PATH} column "${columnName}" has a .default(...) value ` +
      'that is neither a boolean nor a string literal — update ' +
      'scripts/sync-settings-contract.mjs to handle it',
  );
}

function findUserSettingsColumns(sourceFile) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }

    const declaration = statement.declarationList.declarations.find(
      (candidate) =>
        candidate.name.getText(sourceFile) === USER_SETTINGS_TABLE_VARIABLE,
    );

    if (
      !declaration?.initializer ||
      !ts.isCallExpression(declaration.initializer)
    ) {
      continue;
    }

    const [, columnsArgument] = declaration.initializer.arguments;

    if (columnsArgument && ts.isObjectLiteralExpression(columnsArgument)) {
      return columnsArgument;
    }
  }

  return undefined;
}

// Extracts the `.default(...)` value of each column in DEFAULT_COLUMN_NAMES
// from markpost's `userSettings` pgTable definition. Exported so
// tests/scripts/sync-settings-contract.test.ts can exercise it without
// touching the network.
export function extractUserSettingsDefaults(source) {
  const sourceFile = parseSource(SCHEMA_SOURCE_PATH, source);
  const columns = findUserSettingsColumns(sourceFile);

  if (!columns) {
    throw new Error(
      `${SCHEMA_SOURCE_PATH} has no \`${USER_SETTINGS_TABLE_VARIABLE} = pgTable(...)\` ` +
        'definition — markpost renamed or restructured the settings table; ' +
        'update scripts/sync-settings-contract.mjs to match',
    );
  }

  const missingColumns = [];
  const defaults = {};

  for (const columnName of DEFAULT_COLUMN_NAMES) {
    const property = columns.properties.find(
      (candidate) =>
        ts.isPropertyAssignment(candidate) &&
        candidate.name.getText(sourceFile) === columnName,
    );
    const defaultCall = property && findDefaultCall(property.initializer);

    if (!defaultCall || defaultCall.arguments.length === 0) {
      missingColumns.push(columnName);
      continue;
    }

    defaults[columnName] = literalToJsValue(
      defaultCall.arguments[0],
      columnName,
    );
  }

  if (missingColumns.length > 0) {
    throw new Error(
      `${SCHEMA_SOURCE_PATH}'s ${USER_SETTINGS_TABLE_VARIABLE} table is missing a ` +
        `.default(...) for column(s): ${missingColumns.join(', ')} — markpost ` +
        'renamed, removed, or stopped defaulting a column the CLI falls back ' +
        'on; update scripts/sync-settings-contract.mjs and ' +
        'src/types/settings.types.ts to match',
    );
  }

  return defaults;
}

function renderUserSettingsDefaults(defaults) {
  const lines = DEFAULT_COLUMN_NAMES.map(
    (columnName) => `  ${columnName}: ${JSON.stringify(defaults[columnName])},`,
  );

  return [
    'export const USER_SETTINGS_DEFAULTS = {',
    ...lines,
    '} as const;',
  ].join('\n');
}

function writeVendoredFile(conflictStrategiesDeclaration, defaults) {
  const body = [
    conflictStrategiesDeclaration,
    '',
    renderUserSettingsDefaults(defaults),
  ].join('\n');

  mkdirSync(VENDOR_DIR, { recursive: true });
  writeFileSync(VENDOR_FILE, `${VENDOR_FILE_HEADER}${body}\n`);
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

// Resolves everything that can fail (missing files, missing declarations,
// uncommitted changes) before writing anything, so a mid-sync failure can't
// leave the vendored file and the manifest's recorded commits disagreeing
// with each other.
function syncFrom(checkoutDir) {
  const responseSource = readSource(
    checkoutDir,
    CONFLICT_STRATEGIES_SOURCE_PATH,
  );
  const schemaSource = readSource(checkoutDir, SCHEMA_SOURCE_PATH);

  const conflictStrategiesDeclaration =
    extractConflictStrategiesDeclaration(responseSource);
  const defaults = extractUserSettingsDefaults(schemaSource);

  assertPathIsCommitted(checkoutDir, CONFLICT_STRATEGIES_SOURCE_PATH);
  assertPathIsCommitted(checkoutDir, SCHEMA_SOURCE_PATH);

  const sourceRepo = resolveSourceRepo(checkoutDir);
  const syncedFiles = [
    {
      path: CONFLICT_STRATEGIES_SOURCE_PATH,
      sourceCommit: readCommitHash(
        checkoutDir,
        CONFLICT_STRATEGIES_SOURCE_PATH,
      ),
    },
    {
      path: SCHEMA_SOURCE_PATH,
      sourceCommit: readCommitHash(checkoutDir, SCHEMA_SOURCE_PATH),
    },
  ];

  writeVendoredFile(conflictStrategiesDeclaration, defaults);
  writeManifest(sourceRepo, syncedFiles);
}

function main() {
  const fromPath = parseFromPathArg(process.argv.slice(2));

  withMarkpostCheckout(
    fromPath,
    'markpost-settings-contract-sync-',
    (checkoutDir) => {
      syncFrom(checkoutDir);
      console.log(`Synced ${VENDOR_FILE} from ${checkoutDir}`);
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
