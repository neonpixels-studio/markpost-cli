#!/usr/bin/env node
// Human-run tool: vendors the frontmatter-serialization slice of markpost's
// `server/utils/markdown.ts` into
// `tests/libs/vendor/markpost-markdown-serialization.generated.ts` so the
// drift test can execute markpost's *real* `quoteYamlScalar` /
// `serializeTagsLine` / `serializeFrontmatter` / `assembleMarkdownDocument`
// against the CLI's hand-mirrored copy and fail the moment the two diverge.
//
// Only the pure serialization functions (and the two types they need) are
// pulled out — the rest of markdown.ts drags in turndown and other server-only
// code the CLI neither ships nor needs. The extracted slice is verbatim
// markpost source (types stripped by nothing; kept as-is), so the drift test
// compares against markpost's actual behavior, not a hand-transcribed guess.
//
// This intentionally does NOT run in CI or the test suite — it needs network
// access (or a local markpost checkout) to fetch the current source, and a
// network-dependent test is flaky and fails offline. Run it by hand whenever
// markpost's markdown serialization changes, review the diff, then commit.
//
// Usage:
//   npm run sync:markdown-serialization                     # shallow-clones markpost fresh
//   npm run sync:markdown-serialization -- --from <path>    # copies from an existing local checkout
//   npm run sync:markdown-serialization -- --from=<path>    # same, `=` form

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

import { parseFromPathArg } from './sync-contract.mjs';

const MARKPOST_REPO_URL = 'https://github.com/neonpixels-studio/markpost';
const SOURCE_RELATIVE_PATH = 'server/utils/markdown.ts';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');
const VENDOR_DIR = join(REPO_ROOT, 'tests/libs/vendor');
const VENDOR_FILE = join(VENDOR_DIR, 'markpost-markdown-serialization.generated.ts');
const MANIFEST_FILE = join(VENDOR_DIR, 'markpost-markdown-serialization.manifest.json');

// The declarations pulled out of markdown.ts, in the order they are emitted.
// Types first (so the functions that reference them resolve), then the four
// serialization functions. Every name here must exist in markpost's source —
// a rename or removal upstream fails the sync loudly, which is itself the
// drift signal worth surfacing.
const REQUIRED_TYPE_NAMES = ['FrontmatterObject', 'ParsedPayload'];
const REQUIRED_FUNCTION_NAMES = [
  'quoteYamlScalar',
  'serializeTagsLine',
  'serializeFrontmatter',
  'assembleMarkdownDocument',
];
// The public entry points the drift test imports; force `export` onto them if
// markpost ever stops exporting one, so the generated module stays importable.
const PUBLIC_FUNCTION_NAMES = ['serializeFrontmatter', 'assembleMarkdownDocument'];

const VENDOR_FILE_HEADER = `// GENERATED FILE — do not hand-edit.
//
// This is a verbatim copy of the frontmatter-serialization slice of markpost's
// \`${SOURCE_RELATIVE_PATH}\` (the pure \`quoteYamlScalar\`, \`serializeTagsLine\`,
// \`serializeFrontmatter\`, and \`assembleMarkdownDocument\` functions plus the
// two types they use). markpost is the source of truth; the CLI's
// \`src/libs/frontmatter.ts\` hand-mirrors it, so the drift test at
// \`tests/libs/frontmatter-drift.test.ts\` runs this copy against the mirror and
// fails if they stop producing byte-identical output.
//
// It lives under \`tests/\` so it never ships in the published \`dist/\`.
//
// Regenerate with \`npm run sync:markdown-serialization\`
// (see README.md#markdown-serialization-sync). Review the diff, then commit.
//
// Source: neonpixels-studio/markpost @ ${SOURCE_RELATIVE_PATH}
// See markpost-markdown-serialization.manifest.json for the exact commit.

/* eslint-disable */

`;

function findNamedDeclaration(sourceFile, name) {
  return sourceFile.statements.find((statement) => {
    const isType =
      ts.isTypeAliasDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement);
    const isFunction = ts.isFunctionDeclaration(statement);

    if (!isType && !isFunction) {
      return false;
    }

    return statement.name?.text === name;
  });
}

function isExported(declaration) {
  return (
    declaration.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    ) ?? false
  );
}

function declarationText(sourceFile, declaration, name) {
  const text = declaration.getText(sourceFile);

  if (!PUBLIC_FUNCTION_NAMES.includes(name) || isExported(declaration)) {
    return text;
  }

  return `export ${text}`;
}

// Pulls the serialization slice out of markdown.ts as verbatim source text.
// Exported so tests/scripts/sync-markdown-serialization.test.ts can exercise
// the extraction without touching the network.
function extractSerializationSlice(source) {
  const sourceFile = ts.createSourceFile(
    SOURCE_RELATIVE_PATH,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  const orderedNames = [...REQUIRED_TYPE_NAMES, ...REQUIRED_FUNCTION_NAMES];
  const missing = [];
  const declarations = orderedNames.map((name) => {
    const declaration = findNamedDeclaration(sourceFile, name);

    if (!declaration) {
      missing.push(name);
      return '';
    }

    return declarationText(sourceFile, declaration, name);
  });

  if (missing.length > 0) {
    throw new Error(
      `${SOURCE_RELATIVE_PATH} is missing expected declaration(s): ${missing.join(', ')} — ` +
        'markpost renamed or removed part of the serialization slice; update ' +
        'scripts/sync-markdown-serialization.mjs and src/libs/frontmatter.ts to match',
    );
  }

  return declarations.join('\n\n');
}

function cloneMarkpostInto(cloneDir) {
  execFileSync('git', ['clone', '--depth', '1', MARKPOST_REPO_URL, cloneDir], {
    stdio: 'inherit',
  });
}

function assertSourceIsCommitted(checkoutDir) {
  const status = execFileSync(
    'git',
    ['status', '--porcelain', '--', SOURCE_RELATIVE_PATH],
    { cwd: checkoutDir, encoding: 'utf-8' },
  ).trim();

  if (!status) {
    return;
  }

  throw new Error(
    `${SOURCE_RELATIVE_PATH} has uncommitted changes in ${checkoutDir} — ` +
      'commit them first so the manifest records the commit the vendored slice actually came from',
  );
}

function readCommitHash(checkoutDir) {
  const commitHash = execFileSync(
    'git',
    ['log', '-1', '--format=%H', '--', SOURCE_RELATIVE_PATH],
    { cwd: checkoutDir, encoding: 'utf-8' },
  ).trim();

  if (!commitHash) {
    throw new Error(
      `No commit history found for ${SOURCE_RELATIVE_PATH} in ${checkoutDir} — ` +
        'is this a markpost git checkout?',
    );
  }

  return commitHash;
}

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

function readMarkdownSource(checkoutDir) {
  const sourcePath = join(checkoutDir, SOURCE_RELATIVE_PATH);

  if (!existsSync(sourcePath)) {
    throw new Error(
      `No ${SOURCE_RELATIVE_PATH} found in ${checkoutDir} — is this a markpost checkout?`,
    );
  }

  return readFileSync(sourcePath, 'utf-8');
}

function writeVendoredSlice(slice) {
  mkdirSync(VENDOR_DIR, { recursive: true });
  writeFileSync(VENDOR_FILE, `${VENDOR_FILE_HEADER}${slice}\n`);
}

function writeManifest(sourceRepo, sourceCommit) {
  const manifest = {
    sourceRepo,
    sourceFile: SOURCE_RELATIVE_PATH,
    sourceCommit,
    exportedDeclarations: [...REQUIRED_TYPE_NAMES, ...REQUIRED_FUNCTION_NAMES],
    syncedAt: new Date().toISOString(),
  };

  mkdirSync(VENDOR_DIR, { recursive: true });
  writeFileSync(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
}

// Resolve everything that can fail (missing source, uncommitted changes,
// extraction) before writing anything, so a mid-sync failure can't leave the
// vendored slice and the manifest's `sourceCommit` disagreeing with each other.
function syncFrom(checkoutDir) {
  const source = readMarkdownSource(checkoutDir);
  const slice = extractSerializationSlice(source);

  assertSourceIsCommitted(checkoutDir);
  const sourceCommit = readCommitHash(checkoutDir);
  const sourceRepo = resolveSourceRepo(checkoutDir);

  writeVendoredSlice(slice);
  writeManifest(sourceRepo, sourceCommit);
}

function main() {
  const fromPath = parseFromPathArg(process.argv.slice(2));
  const temporaryCloneDir = fromPath
    ? undefined
    : mkdtempSync(join(tmpdir(), 'markpost-markdown-sync-'));

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { extractSerializationSlice };
