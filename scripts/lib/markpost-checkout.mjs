// Shared git-checkout helpers for the markpost contract-sync scripts
// (scripts/sync-contract.mjs, scripts/sync-markdown-serialization.mjs,
// scripts/sync-source-contract.mjs, scripts/sync-settings-contract.mjs).
// Every sync script needs the same things — a fresh markpost checkout (or an
// explicit `--from` override), the commit that last touched the file it's
// vendoring, the repo its `origin` actually points at, reading a source file
// out of the checkout, and writing a manifest recording where a vendored copy
// came from — so this is the one place that logic lives instead of drifting
// copies in each script.
//
// scripts/sync-contract.mjs and scripts/sync-markdown-serialization.mjs
// predate this module and mostly keep their own copies (readContractSource/
// readMarkdownSource, their own manifest writers, their own clone/main
// plumbing) to avoid churning working, already-reviewed code — but both now
// import `resolveSourceRepo` from here rather than keep a second and third
// copy that skip the credential-stripping in `stripCredentials` below. Any
// *new* sync script should build on this module rather than add another
// copy of anything in it.
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
import ts from 'typescript';

export const MARKPOST_REPO_URL =
  'https://github.com/neonpixels-studio/markpost';

// Full history (`--filter=blob:none`, not `--depth 1`) so `readCommitHash`
// below can actually walk a path's log instead of every path reporting HEAD
// (the only commit a shallow clone has). Blobless keeps the clone cheap —
// only the commit graph and trees download eagerly, file contents fetch
// on demand for the paths actually read.
export function cloneMarkpostInto(cloneDir) {
  execFileSync(
    'git',
    ['clone', '--filter=blob:none', MARKPOST_REPO_URL, cloneDir],
    { stdio: 'inherit' },
  );
}

// Refuses to record provenance for a file with uncommitted local changes —
// otherwise the manifest's `sourceCommit` would claim a commit that doesn't
// actually contain what was just vendored.
export function assertPathIsCommitted(checkoutDir, relativePath) {
  const status = execFileSync(
    'git',
    ['status', '--porcelain', '--', relativePath],
    { cwd: checkoutDir, encoding: 'utf-8' },
  ).trim();

  if (!status) {
    return;
  }

  throw new Error(
    `${relativePath} has uncommitted changes in ${checkoutDir} — ` +
      'commit them first so the manifest records the commit the vendored copy actually came from',
  );
}

// A `--from` checkout can be an arbitrary local clone, including a shallow
// one — and in a shallow clone the grafted boundary commit shows every file
// as newly added, so `git log -1 -- <path>` reports HEAD for every path
// regardless of when it actually last changed, silently producing a false
// provenance claim instead of the loud failure `readCommitHash` otherwise
// guarantees. `cloneMarkpostInto` never produces a shallow clone itself
// (see its own comment), so this only ever fires for a caller-supplied
// `--from` directory.
export function assertCheckoutIsNotShallow(checkoutDir) {
  const isShallow = execFileSync(
    'git',
    ['rev-parse', '--is-shallow-repository'],
    { cwd: checkoutDir, encoding: 'utf-8' },
  ).trim();

  if (isShallow === 'true') {
    throw new Error(
      `${checkoutDir} is a shallow git clone — per-path commit history would ` +
        'be wrong for every file (every path would report HEAD). Run ' +
        '"git fetch --unshallow" in it, or omit --from to let the sync ' +
        'script clone fresh.',
    );
  }
}

// The commit that actually last touched `relativePath`, not just whatever
// HEAD happens to be — keeps the manifest diff stable across upstream
// commits that don't touch the vendored file. Requires a full-history
// checkout (see cloneMarkpostInto); a shallow clone has only one commit and
// would report it for every path regardless of when that path last changed.
// `git log` exits 0 with empty stdout when the path has no commits in this
// checkout (e.g. it's present but git-ignored, or this isn't the checkout's
// repo root) — that's exactly the case the manifest's provenance claim needs
// to fail on, not silently record as `sourceCommit: ""`.
export function readCommitHash(checkoutDir, relativePath) {
  const commitHash = execFileSync(
    'git',
    ['log', '-1', '--format=%H', '--', relativePath],
    { cwd: checkoutDir, encoding: 'utf-8' },
  ).trim();

  if (!commitHash) {
    throw new Error(
      `No commit history found for ${relativePath} in ${checkoutDir} — ` +
        'is this a markpost git checkout?',
    );
  }

  return commitHash;
}

// Strips any embedded userinfo (`https://x-access-token:<token>@github.com/...`)
// before a remote URL is recorded anywhere — a checkout cloned by CI tooling
// or a credential-embedding helper would otherwise leak that token straight
// into a committed manifest, where a one-line JSON diff is easy to skim past
// in review. scp-style URLs (`git@host:org/repo`) fail `new URL(...)` and
// have no userinfo to strip, so they pass through unchanged.
function stripCredentials(remoteUrl) {
  try {
    const parsed = new URL(remoteUrl);

    parsed.username = '';
    parsed.password = '';

    return parsed.toString();
  } catch {
    return remoteUrl;
  }
}

// Resolves the checkout's real `origin` remote so a `--from` sync against a
// fork or a local branch records provenance the manifest can actually be
// verified against, instead of hardcoding `neonpixels-studio/markpost` for a
// commit that may not exist there. Falls back to the absolute local path
// when the checkout has no `origin` remote (e.g. a bare local clone).
export function resolveSourceRepo(checkoutDir) {
  try {
    const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: checkoutDir,
      encoding: 'utf-8',
    }).trim();

    return stripCredentials(remoteUrl);
  } catch {
    return resolve(checkoutDir);
  }
}

// Reads `relativePath` out of a markpost checkout, failing with a
// friendly "is this a markpost checkout?" message rather than a raw ENOENT
// when the path is missing (e.g. `--from` pointed at the wrong directory).
export function readSource(checkoutDir, relativePath) {
  const sourcePath = join(checkoutDir, relativePath);

  if (!existsSync(sourcePath)) {
    throw new Error(
      `No ${relativePath} found in ${checkoutDir} — is this a markpost checkout?`,
    );
  }

  return readFileSync(sourcePath, 'utf-8');
}

// Shared by every sync script's AST-based assertions/extractors
// (assertFileHasNoImports, assertRequiredExportsPresent,
// extractConflictStrategiesDeclaration, extractUserSettingsDefaults) so each
// parses its input once instead of re-parsing the same source per assertion.
export function parseTypeScriptSource(relativePath, source) {
  return ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
}

// True for any top-level statement carrying an `export` modifier
// (`export const foo = ...`, `export function foo() {}`, `export type Foo
// = ...`, `export interface Foo {}`). Shared by the sync scripts' extractors
// so "is this declaration exported" has one implementation instead of a
// copy per script.
export function hasExportModifier(statement) {
  return (
    statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    ) ?? false
  );
}

// Writes a sync manifest recording which repo and commit(s) a vendored copy
// came from, creating the vendor directory if needed. `syncedFiles` is an
// array of `{ path, sourceCommit }` — one entry per source file the calling
// script vendored from.
export function writeManifest(manifestFile, sourceRepo, syncedFiles) {
  const manifest = {
    sourceRepo,
    sourceFiles: syncedFiles,
    syncedAt: new Date().toISOString(),
  };

  mkdirSync(dirname(manifestFile), { recursive: true });
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
}

// Runs `syncFrom(checkoutDir)` against either an explicit `--from` checkout
// or a fresh temporary clone, and guarantees the temporary clone (never a
// caller-supplied `--from` directory) is removed afterwards even if
// `syncFrom` throws partway through. Returns whatever `syncFrom` returns.
// Rejects a shallow checkout (see assertCheckoutIsNotShallow) before calling
// `syncFrom` — this only ever fires for a `--from` directory, since
// `cloneInto`'s own clone is always full-history.
//
// `cloneInto` defaults to the real network clone but is overridable so
// tests/scripts/markpost-checkout.test.ts can exercise the temp-dir
// lifecycle (creation, and cleanup on both success and throw) with a fake
// that never touches the network — the same "isolate external services"
// reasoning as apiFetch in src/libs/api.ts.
export function withMarkpostCheckout(
  fromPath,
  temporaryDirPrefix,
  syncFrom,
  cloneInto = cloneMarkpostInto,
) {
  const temporaryCloneDir = fromPath
    ? undefined
    : mkdtempSync(join(tmpdir(), temporaryDirPrefix));

  try {
    if (temporaryCloneDir) {
      cloneInto(temporaryCloneDir);
    }

    const checkoutDir = fromPath ?? temporaryCloneDir;

    assertCheckoutIsNotShallow(checkoutDir);

    return syncFrom(checkoutDir);
  } finally {
    if (temporaryCloneDir) {
      rmSync(temporaryCloneDir, { recursive: true, force: true });
    }
  }
}
