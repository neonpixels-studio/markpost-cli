// Shared git-checkout helpers for the markpost vendor-sync scripts
// (sync-contract.mjs, sync-markdown-serialization.mjs,
// sync-source-endpoints.mjs). Each script vendors a different slice of
// markpost's source, but "clone markpost, verify a path is committed, read
// the commit that last touched it, resolve the source remote, parse
// `--from`" is the same concern in all three — factored out here per the
// project's rule of three so a fix (e.g. to the uncommitted-changes check)
// lands in one place instead of three.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const MARKPOST_REPO_URL = 'https://github.com/neonpixels-studio/markpost';

// `--filter=blob:none` (rather than `--depth 1`) fetches full commit history
// but defers downloading file contents until something actually needs them —
// still a cheap clone, but with real history. A depth-1 clone has exactly one
// commit locally, so `git log -- <path>` can only ever report that commit for
// any path that exists in it, regardless of when the path actually last
// changed; readCommitHashForPath below depends on the fuller history to
// report a meaningful commit.
function cloneMarkpostInto(cloneDir) {
  execFileSync(
    'git',
    ['clone', '--filter=blob:none', MARKPOST_REPO_URL, cloneDir],
    { stdio: 'inherit' },
  );
}

function assertPathIsCommitted(checkoutDir, relativePath) {
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

// The commit that actually last touched the path, not just whatever HEAD
// happens to be — keeps the manifest diff stable across upstream commits
// that don't touch this path. `git log` exits 0 with empty stdout when the
// path has no commits in this checkout (e.g. the file is present but
// git-ignored, or this isn't the checkout's repo root) — that's exactly the
// case the manifest's provenance claim needs to fail on, not silently
// record as `sourceCommit: ""`.
function readCommitHashForPath(checkoutDir, relativePath) {
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

// Accepts both `--from <path>` and `--from=<path>`. A typo'd flag (e.g.
// `--form`, or a near-miss like `--fromage`) must fail loudly rather than
// silently falling through to a network clone that overwrites the vendored
// file from upstream `main` instead of the checkout the caller actually
// meant, so this whitelists the exact `--from`/`--from=<path>` tokens (and
// the path value immediately after a bare `--from`) rather than anything
// merely prefixed with `--from`. This check runs unconditionally (not just
// on the no-`--from` path) so `--from ../markpost --dry-run` doesn't
// silently ignore the typo'd `--dry-run` and proceed.
function parseFromPathArg(argv) {
  const spaceFlagIndex = argv.indexOf('--from');
  // The index directly after a bare `--from` is its path value, not a
  // separate argument to validate — but only when `--from` is actually
  // present (`-1 + 1 === 0` would otherwise wrongly exempt argv[0]).
  const pathValueIndex = spaceFlagIndex === -1 ? undefined : spaceFlagIndex + 1;
  const unrecognized = argv.filter(
    (argument, index) =>
      argument !== '--from' &&
      !argument.startsWith('--from=') &&
      index !== pathValueIndex,
  );

  if (unrecognized.length > 0) {
    throw new Error(`Unrecognized argument(s): ${unrecognized.join(', ')}`);
  }

  // A duplicated `--from` (either form, or a mix of both) must not silently
  // pick one occurrence and drop the other — that's the same
  // wrong-checkout-gets-vendored risk the whitelist above exists to prevent.
  const fromOccurrences = argv.filter(
    (argument) => argument === '--from' || argument.startsWith('--from='),
  ).length;

  if (fromOccurrences > 1) {
    throw new Error('--from may only be given once');
  }

  const equalsFlag = argv.find((argument) => argument.startsWith('--from='));

  if (!equalsFlag && spaceFlagIndex === -1) {
    return undefined;
  }

  const fromPath = equalsFlag
    ? equalsFlag.slice('--from='.length)
    : argv[spaceFlagIndex + 1];

  if (!fromPath || fromPath.startsWith('--')) {
    throw new Error('--from requires a path to a local markpost checkout');
  }

  if (!existsSync(fromPath)) {
    throw new Error(`--from path does not exist: ${fromPath}`);
  }

  return fromPath;
}

export {
  assertPathIsCommitted,
  cloneMarkpostInto,
  parseFromPathArg,
  readCommitHashForPath,
  resolveSourceRepo,
};
