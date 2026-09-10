// Shared git-checkout helpers for the markpost contract-sync scripts
// (scripts/sync-source-contract.mjs, scripts/sync-settings-contract.mjs).
// Every sync script needs the same three things — a fresh markpost checkout
// (or an explicit `--from` override), the commit that last touched the file
// it's vendoring, and the repo its `origin` actually points at — so this is
// the one place that logic lives instead of drifting copies in each script.
//
// scripts/sync-contract.mjs and scripts/sync-markdown-serialization.mjs
// predate this module and keep their own copies; they aren't touched here to
// avoid churning working, already-reviewed code, but any *new* sync script
// should build on this one instead of adding a third/fourth copy.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const MARKPOST_REPO_URL =
  'https://github.com/neonpixels-studio/markpost';

export function cloneMarkpostInto(cloneDir) {
  execFileSync('git', ['clone', '--depth', '1', MARKPOST_REPO_URL, cloneDir], {
    stdio: 'inherit',
  });
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

// The commit that actually last touched `relativePath`, not just whatever
// HEAD happens to be — keeps the manifest diff stable across upstream
// commits that don't touch the vendored file. `git log` exits 0 with empty
// stdout when the path has no commits in this checkout (e.g. it's present
// but git-ignored, or this isn't the checkout's repo root) — that's exactly
// the case the manifest's provenance claim needs to fail on, not silently
// record as `sourceCommit: ""`.
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

// Resolves the checkout's real `origin` remote so a `--from` sync against a
// fork or a local branch records provenance the manifest can actually be
// verified against, instead of hardcoding `neonpixels-studio/markpost` for a
// commit that may not exist there. Falls back to the absolute local path
// when the checkout has no `origin` remote (e.g. a bare local clone).
export function resolveSourceRepo(checkoutDir) {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: checkoutDir,
      encoding: 'utf-8',
    }).trim();
  } catch {
    return resolve(checkoutDir);
  }
}

// Runs `syncFrom(checkoutDir)` against either an explicit `--from` checkout
// or a fresh temporary clone, and guarantees the temporary clone (never a
// caller-supplied `--from` directory) is removed afterwards even if
// `syncFrom` throws partway through.
export function withMarkpostCheckout(fromPath, temporaryDirPrefix, syncFrom) {
  const temporaryCloneDir = fromPath
    ? undefined
    : mkdtempSync(join(tmpdir(), temporaryDirPrefix));

  try {
    if (temporaryCloneDir) {
      cloneMarkpostInto(temporaryCloneDir);
    }

    const checkoutDir = fromPath ?? temporaryCloneDir;

    syncFrom(checkoutDir);

    return checkoutDir;
  } finally {
    if (temporaryCloneDir) {
      rmSync(temporaryCloneDir, { recursive: true, force: true });
    }
  }
}
