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
//   npm run sync:settings-contract                     # clones markpost fresh (full history, blobless)
//   npm run sync:settings-contract -- --from <path>    # copies from an existing local checkout
//   npm run sync:settings-contract -- --from=<path>    # same, `=` form

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

// Unwraps any of `as const`, `satisfies X`, and surrounding parens, however
// many are nested (e.g. `([...] as const) satisfies readonly string[]`) —
// all three are erased at compile time and don't change what the underlying
// expression actually is, so a plain array of string literals under any
// combination of them is still self-contained and safe to vendor verbatim.
function unwrapAsConstAssertion(expression) {
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

// The declaration is vendored as verbatim statement text (see
// extractConflictStrategiesDeclaration below), with nothing resolving its
// references the way a bundler would — so if markpost ever rewrites
// `CONFLICT_STRATEGIES` to reference another identifier (a shared constant,
// a spread, a function call) instead of being a plain array of string
// literals, a verbatim copy would compile to a `ReferenceError` in the
// vendored file with no signal pointing at the actual cause. Fail loudly at
// sync time instead.
function assertConflictStrategiesIsSelfContained(declaration) {
  const initializer =
    declaration.initializer && unwrapAsConstAssertion(declaration.initializer);
  const isArrayOfStringLiterals =
    initializer !== undefined &&
    ts.isArrayLiteralExpression(initializer) &&
    initializer.elements.every((element) => ts.isStringLiteralLike(element));

  if (!isArrayOfStringLiterals) {
    throw new Error(
      `${CONFLICT_STRATEGIES_SOURCE_PATH}'s ${CONFLICT_STRATEGIES_DECLARATION_NAME} ` +
        'is no longer a plain array of string literals (e.g. it now references ' +
        'another identifier, spreads another array, or is computed) — vendoring ' +
        'it verbatim would produce a vendored file with a dangling reference. ' +
        'Update scripts/sync-settings-contract.mjs to extract the referenced ' +
        'identifier(s) too.',
    );
  }
}

// Extracts `export const CONFLICT_STRATEGIES = [...] as const;` verbatim
// from response.ts, ignoring the rest of the file (pagination/record types
// the CLI has no stake in). Exported so
// tests/scripts/sync-settings-contract.test.ts can exercise it without
// touching the network.
export function extractConflictStrategiesDeclaration(source) {
  const sourceFile = parseTypeScriptSource(
    CONFLICT_STRATEGIES_SOURCE_PATH,
    source,
  );

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

  if (statement.declarationList.declarations.length !== 1) {
    throw new Error(
      `${CONFLICT_STRATEGIES_SOURCE_PATH} now declares ` +
        `${CONFLICT_STRATEGIES_DECLARATION_NAME} alongside another declarator in ` +
        'the same statement — vendoring the whole statement verbatim would carry ' +
        'that declarator along too. Update scripts/sync-settings-contract.mjs to ' +
        'extract just the one declaration.',
    );
  }

  const [declaration] = statement.declarationList.declarations;

  assertConflictStrategiesIsSelfContained(declaration);

  const text = statement.getText(sourceFile);

  return hasExportModifier(statement) ? text : `export ${text}`;
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

// drizzle's second `pgTable` argument is either the column object literal
// directly (`pgTable("x", { ... })`) or, in newer drizzle versions, a
// callback that returns one (`pgTable("x", (t) => ({ ... }))`, used to
// reference the table's own columns while defining them — e.g. for
// composite indexes). An arrow returning an object literal must parenthesize
// it (`=> ({...})`, never `=> {...}`, which parses as a block), so the
// object literal is always one `ParenthesizedExpression` unwrap away from
// the arrow's body.
function unwrapColumnsArgument(node) {
  if (ts.isArrowFunction(node)) {
    return unwrapColumnsArgument(node.body);
  }

  if (ts.isParenthesizedExpression(node)) {
    return unwrapColumnsArgument(node.expression);
  }

  return ts.isObjectLiteralExpression(node) ? node : undefined;
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
    const columns = columnsArgument && unwrapColumnsArgument(columnsArgument);

    if (columns) {
      return columns;
    }
  }

  return undefined;
}

// Extracts the `.default(...)` value of each column in DEFAULT_COLUMN_NAMES
// from markpost's `userSettings` pgTable definition. Exported so
// tests/scripts/sync-settings-contract.test.ts can exercise it without
// touching the network.
export function extractUserSettingsDefaults(source) {
  const sourceFile = parseTypeScriptSource(SCHEMA_SOURCE_PATH, source);
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
  writeManifest(MANIFEST_FILE, sourceRepo, syncedFiles);
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
