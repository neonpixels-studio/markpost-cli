#!/usr/bin/env node
// Human-run tool: vendors the two hardcoded ingest-endpoint constants
// (`WEBHOOK_INGEST_BASE`, `EMAIL_DOMAIN`) out of markpost's
// `app/composables/useSources.ts` into
// `tests/libs/vendor/markpost-source-endpoints.generated.ts` so the drift
// test can compare the CLI's hand-mirrored copies in `src/commands/sources.ts`
// against markpost's real values and fail the moment they diverge.
//
// These are the exact URLs a user configures their webhook provider or email
// forwarder against — a silent mismatch here means a source the CLI prints
// simply doesn't work.
//
// This intentionally does NOT run in CI or the test suite — it needs network
// access (or a local markpost checkout) to fetch the current source, and a
// network-dependent test is flaky and fails offline. Run it by hand whenever
// markpost's ingest endpoints change, review the diff, then commit.
//
// Usage:
//   npm run sync:source-endpoints                     # shallow-clones markpost fresh
//   npm run sync:source-endpoints -- --from <path>    # copies from an existing local checkout
//   npm run sync:source-endpoints -- --from=<path>    # same, `=` form

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
  readCommitHash,
  resolveSourceRepo,
} from './lib/markpost-checkout.mjs';
import { parseFromPathArg } from './sync-contract.mjs';

const SOURCE_RELATIVE_PATH = 'app/composables/useSources.ts';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');
const VENDOR_DIR = join(REPO_ROOT, 'tests/libs/vendor');
const VENDOR_FILE = join(VENDOR_DIR, 'markpost-source-endpoints.generated.ts');
const MANIFEST_FILE = join(
  VENDOR_DIR,
  'markpost-source-endpoints.manifest.json',
);

// The two constants pulled out of useSources.ts. Both names must exist in
// markpost's source, and each must be a plain string literal — a rename,
// removal, or a switch to a computed/templated value upstream fails the sync
// loudly, which is itself the drift signal worth surfacing, rather than
// silently vendoring something that doesn't parse as a standalone constant.
const REQUIRED_CONSTANT_NAMES = ['WEBHOOK_INGEST_BASE', 'EMAIL_DOMAIN'];

const VENDOR_FILE_HEADER = `// GENERATED FILE — do not hand-edit.
//
// This is a copy of the two ingest-endpoint constants' string values from
// markpost's \`${SOURCE_RELATIVE_PATH}\` (\`WEBHOOK_INGEST_BASE\`,
// \`EMAIL_DOMAIN\`). markpost is the source of truth; the CLI's
// \`src/commands/sources.ts\` hand-mirrors them, so the drift test at
// \`tests/libs/source-endpoints-drift.test.ts\` compares this copy against the
// mirror and fails if they stop matching.
//
// It lives under \`tests/\` so it never ships in the published \`dist/\`.
//
// Regenerate with \`npm run sync:source-endpoints\`
// (see README.md#source-endpoint-sync). Review the diff, then commit.
//
// Source: neonpixels-studio/markpost @ ${SOURCE_RELATIVE_PATH}
// See markpost-source-endpoints.manifest.json for the exact commit.

/* eslint-disable */

`;

// Finds the `const NAME = ...` declarator for `name`, regardless of whether
// it shares a `const a = ..., b = ...;` statement with other declarators —
// returning the declarator (not the enclosing statement) means a sibling
// declarator alongside it is never accidentally vendored too. Only matches a
// `const` declaration list (not `let`/`var`) — a reassignable binding could
// hold a different value by the time anything reads it, so vendoring its
// initial initializer would silently record a value markpost may not
// actually be using.
function findConstantDeclarator(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    const isConstDeclaration =
      ts.isVariableStatement(statement) &&
      (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;

    if (!isConstDeclaration) {
      continue;
    }

    const declarator = statement.declarationList.declarations.find(
      (candidate) => candidate.name.getText(sourceFile) === name,
    );

    if (declarator) {
      return declarator;
    }
  }

  return undefined;
}

// Strips wrappers that don't change the runtime value — `as const`,
// `satisfies SomeType`, and parentheses — so a value-preserving style change
// upstream (e.g. markpost adding `as const`) isn't reported as drift just
// because the initializer is no longer a bare string-literal node.
function unwrapValuePreservingExpression(expression) {
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

// Renders one constant as a standalone, always-exported declaration built
// from just its string value — never the declarator's raw source text — so a
// sibling declarator, a non-literal initializer (a template literal with
// interpolation, a call like `useRuntimeConfig()`), or an existing `export`
// keyword can't leak through as something this generated file can't stand
// alone without.
function renderConstantDeclaration(name, declarator) {
  const initializer = declarator.initializer;
  const valueExpression =
    initializer && unwrapValuePreservingExpression(initializer);

  if (!valueExpression || !ts.isStringLiteralLike(valueExpression)) {
    throw new Error(
      `${SOURCE_RELATIVE_PATH}'s ${name} is not a plain string literal — ` +
        'update scripts/sync-source-endpoints.mjs to handle its new shape ' +
        '(and confirm src/commands/sources.ts still mirrors it correctly)',
    );
  }

  return `export const ${name} = ${JSON.stringify(valueExpression.text)};`;
}

// Pulls the two ingest-endpoint constants out of useSources.ts as
// independently-rendered declarations. Exported so
// tests/scripts/sync-source-endpoints.test.ts can exercise the extraction
// without touching the network.
function extractEndpointConstants(source) {
  const sourceFile = ts.createSourceFile(
    SOURCE_RELATIVE_PATH,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  // Resolve each name's declarator once, up front, so the missing-name check
  // and the rendering step below both read from the same lookup instead of
  // re-walking the AST for every name a second time.
  const declaratorsByName = REQUIRED_CONSTANT_NAMES.map((name) => [
    name,
    findConstantDeclarator(sourceFile, name),
  ]);
  const missing = declaratorsByName
    .filter(([, declarator]) => !declarator)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `${SOURCE_RELATIVE_PATH} is missing expected constant(s): ${missing.join(', ')} — ` +
        'markpost renamed or removed part of the ingest-endpoint config; update ' +
        'scripts/sync-source-endpoints.mjs and src/commands/sources.ts to match',
    );
  }

  const declarations = declaratorsByName.map(([name, declarator]) =>
    renderConstantDeclaration(name, declarator),
  );

  return declarations.join('\n\n');
}

function readEndpointSource(checkoutDir) {
  const sourcePath = join(checkoutDir, SOURCE_RELATIVE_PATH);

  if (!existsSync(sourcePath)) {
    throw new Error(
      `No ${SOURCE_RELATIVE_PATH} found in ${checkoutDir} — is this a markpost checkout?`,
    );
  }

  return readFileSync(sourcePath, 'utf-8');
}

function writeVendoredConstants(constants) {
  mkdirSync(VENDOR_DIR, { recursive: true });
  writeFileSync(VENDOR_FILE, `${VENDOR_FILE_HEADER}${constants}\n`);
}

function writeManifest(sourceRepo, sourceCommit) {
  const manifest = {
    sourceRepo,
    sourceFile: SOURCE_RELATIVE_PATH,
    sourceCommit,
    exportedDeclarations: [...REQUIRED_CONSTANT_NAMES],
    syncedAt: new Date().toISOString(),
  };

  mkdirSync(VENDOR_DIR, { recursive: true });
  writeFileSync(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
}

// Resolve everything that can fail (missing source, uncommitted changes,
// extraction) before writing anything, so a mid-sync failure can't leave the
// vendored constants and the manifest's `sourceCommit` disagreeing with each other.
function syncFrom(checkoutDir) {
  const source = readEndpointSource(checkoutDir);
  const constants = extractEndpointConstants(source);

  assertPathIsCommitted(checkoutDir, SOURCE_RELATIVE_PATH);
  const sourceCommit = readCommitHash(checkoutDir, SOURCE_RELATIVE_PATH);
  const sourceRepo = resolveSourceRepo(checkoutDir);

  writeVendoredConstants(constants);
  writeManifest(sourceRepo, sourceCommit);
}

function main() {
  const fromPath = parseFromPathArg(process.argv.slice(2));
  const temporaryCloneDir = fromPath
    ? undefined
    : mkdtempSync(join(tmpdir(), 'markpost-source-endpoints-sync-'));

  try {
    if (temporaryCloneDir) {
      cloneMarkpostInto(temporaryCloneDir);
    }

    const checkoutDir = fromPath ?? temporaryCloneDir;

    syncFrom(checkoutDir);
    console.log(`Synced ${VENDOR_FILE} from ${checkoutDir}`);
    console.log('Review the diff, then run `npm test` before committing.');
  } finally {
    if (temporaryCloneDir) {
      rmSync(temporaryCloneDir, { recursive: true, force: true });
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}

export { extractEndpointConstants };
