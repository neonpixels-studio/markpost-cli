// Unit-tests scripts/lib/markpost-checkout.mjs — the git-checkout helpers
// shared by sync-source-contract.mjs and sync-settings-contract.mjs. Uses a
// real local git repo in a temp dir (git init + commit) rather than mocking
// execFileSync, so these prove the actual git invocations behave as
// documented. No network access.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertCheckoutIsNotShallow,
  assertPathIsCommitted,
  readCommitHash,
  readSource,
  resolveSourceRepo,
  withMarkpostCheckout,
  writeManifest,
  // @ts-expect-error -- plain .mjs, not part of the typed src/ tree.
} from '../../scripts/lib/markpost-checkout.mjs';

let repoDir: string;

// Isolates every git invocation from the developer's global/system config
// (commit.gpgsign, init.defaultObjectFormat, etc.) — without this, a machine
// with commit signing enabled fails every test in this file on the baseline
// commit in beforeEach, for reasons entirely unrelated to the code under test.
function runGit(args: string[], cwd: string = repoDir) {
  execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
}

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'markpost-checkout-test-'));
  runGit(['init', '--quiet']);
  runGit(['config', 'user.email', 'test@example.com']);
  runGit(['config', 'user.name', 'Test']);
  // A baseline commit so `git log -- <path>` for a path that was never
  // committed reports "no history for this path" (empty stdout, exit 0)
  // rather than "this branch has no commits at all" (a git error) — the
  // former is the real-world case readCommitHash's error message documents.
  writeFileSync(join(repoDir, 'README.md'), 'baseline');
  runGit(['add', 'README.md']);
  runGit(['commit', '--quiet', '-m', 'baseline commit']);
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

describe('readCommitHash', () => {
  it('returns the commit that last touched the given path', () => {
    writeFileSync(join(repoDir, 'tracked.ts'), 'export const a = 1;');
    runGit(['add', 'tracked.ts']);
    runGit(['commit', '--quiet', '-m', 'add tracked.ts']);

    const commitHash = readCommitHash(repoDir, 'tracked.ts');

    expect(commitHash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('throws when the path has no commit history', () => {
    expect(() => readCommitHash(repoDir, 'no-such-file.ts')).toThrow(
      /No commit history found/,
    );
  });
});

describe('assertPathIsCommitted', () => {
  it('does not throw for a path with no uncommitted changes', () => {
    writeFileSync(join(repoDir, 'tracked.ts'), 'export const a = 1;');
    runGit(['add', 'tracked.ts']);
    runGit(['commit', '--quiet', '-m', 'add tracked.ts']);

    expect(() => assertPathIsCommitted(repoDir, 'tracked.ts')).not.toThrow();
  });

  it('throws when the path has uncommitted changes', () => {
    writeFileSync(join(repoDir, 'tracked.ts'), 'export const a = 1;');
    runGit(['add', 'tracked.ts']);
    runGit(['commit', '--quiet', '-m', 'add tracked.ts']);
    writeFileSync(join(repoDir, 'tracked.ts'), 'export const a = 2;');

    expect(() => assertPathIsCommitted(repoDir, 'tracked.ts')).toThrow(
      /has uncommitted changes/,
    );
  });
});

describe('resolveSourceRepo', () => {
  it('falls back to the absolute checkout path when there is no origin remote', () => {
    expect(resolveSourceRepo(repoDir)).toBe(repoDir);
  });

  it('returns the origin remote URL when one is configured', () => {
    runGit(['remote', 'add', 'origin', 'https://github.com/example/repo.git']);

    expect(resolveSourceRepo(repoDir)).toBe(
      'https://github.com/example/repo.git',
    );
  });

  // Regression coverage: a checkout cloned via a credential-embedding helper
  // must not leak that token into anything resolveSourceRepo returns, since
  // callers commit this value straight into a manifest.
  it('strips embedded userinfo from the origin remote URL', () => {
    runGit([
      'remote',
      'add',
      'origin',
      'https://x-access-token:secret-token@github.com/example/repo.git',
    ]);

    const resolvedRepo = resolveSourceRepo(repoDir);

    expect(resolvedRepo).not.toContain('secret-token');
    expect(resolvedRepo).toBe('https://github.com/example/repo.git');
  });
});

describe('readSource', () => {
  it('reads the file at the given path', () => {
    writeFileSync(join(repoDir, 'tracked.ts'), 'export const a = 1;');

    expect(readSource(repoDir, 'tracked.ts')).toBe('export const a = 1;');
  });

  it('throws a friendly error when the path does not exist', () => {
    expect(() => readSource(repoDir, 'missing.ts')).toThrow(
      /is this a markpost checkout/,
    );
  });
});

describe('writeManifest', () => {
  it('writes a manifest recording the repo and synced files', () => {
    const manifestFile = join(repoDir, 'manifest.json');

    writeManifest(manifestFile, 'https://github.com/example/repo.git', [
      { path: 'shared/utils/sourceTypes.ts', sourceCommit: 'abc123' },
    ]);

    const manifest = JSON.parse(readFileSync(manifestFile, 'utf-8'));

    expect(manifest.sourceRepo).toBe('https://github.com/example/repo.git');
    expect(manifest.sourceFiles).toEqual([
      { path: 'shared/utils/sourceTypes.ts', sourceCommit: 'abc123' },
    ]);
    expect(manifest.syncedAt).toEqual(expect.any(String));
  });
});

describe('assertCheckoutIsNotShallow', () => {
  it('does not throw for a full-history checkout', () => {
    expect(() => assertCheckoutIsNotShallow(repoDir)).not.toThrow();
  });

  it('throws for a shallow checkout', () => {
    const shallowCloneDir = mkdtempSync(
      join(tmpdir(), 'markpost-checkout-shallow-'),
    );

    try {
      // `--depth` is silently ignored for a plain local-path clone; the
      // `file://` form is required to actually produce a shallow clone.
      runGit([
        'clone',
        '--quiet',
        '--depth',
        '1',
        `file://${repoDir}`,
        shallowCloneDir,
      ]);

      expect(() => assertCheckoutIsNotShallow(shallowCloneDir)).toThrow(
        /shallow git clone/,
      );
    } finally {
      rmSync(shallowCloneDir, { recursive: true, force: true });
    }
  });

  // Regression coverage: a directory that isn't a git repo at all (e.g.
  // --from pointed at the wrong path) is a different problem than
  // shallow-ness — it must surface the same friendly "is this a markpost
  // checkout?" wording as readSource, not a raw git error.
  it('throws a friendly error for a directory that is not a git repo', () => {
    const notARepoDir = mkdtempSync(
      join(tmpdir(), 'markpost-checkout-not-a-repo-'),
    );

    try {
      expect(() => assertCheckoutIsNotShallow(notARepoDir)).toThrow(
        /is this a markpost checkout/,
      );
    } finally {
      rmSync(notARepoDir, { recursive: true, force: true });
    }
  });
});

describe('withMarkpostCheckout', () => {
  // A fake `cloneInto` (the same shape as cloneMarkpostInto) that never
  // touches the network — it just `git init`s the temp dir (so the
  // shallow-checkout guard has a real repo to inspect) and proves it was
  // called with the temp dir withMarkpostCheckout created, by writing a
  // marker file into it.
  function fakeCloneInto(cloneDir: string) {
    runGit(['init', '--quiet'], cloneDir);
    writeFileSync(join(cloneDir, 'cloned.marker'), 'cloned');
  }

  it('passes the --from directory through as the checkout dir, without cloning', () => {
    const cloneIntoSpy = vi.fn();

    const checkoutDirSeen = withMarkpostCheckout(
      repoDir,
      'markpost-checkout-test-',
      (checkoutDir: string) => checkoutDir,
      cloneIntoSpy,
    );

    expect(checkoutDirSeen).toBe(repoDir);
    expect(cloneIntoSpy).not.toHaveBeenCalled();
  });

  it('returns the callback result', () => {
    const result = withMarkpostCheckout(
      repoDir,
      'markpost-checkout-test-',
      () => 'sync result',
    );

    expect(result).toBe('sync result');
  });

  it('clones into a fresh temp dir when no --from is given, and cleans it up on success', () => {
    let checkoutDirSeenByCallback = '';

    withMarkpostCheckout(
      undefined,
      'markpost-checkout-test-',
      (checkoutDir: string) => {
        checkoutDirSeenByCallback = checkoutDir;
        expect(existsSync(join(checkoutDir, 'cloned.marker'))).toBe(true);
      },
      fakeCloneInto,
    );

    expect(checkoutDirSeenByCallback).not.toBe('');
    expect(existsSync(checkoutDirSeenByCallback)).toBe(false);
  });

  // Regression coverage: the whole point of the try/finally is that a
  // mid-sync failure still cleans up the temp clone it created.
  it('cleans up the temp clone even when the callback throws', () => {
    let checkoutDirSeenByCallback = '';

    expect(() =>
      withMarkpostCheckout(
        undefined,
        'markpost-checkout-test-',
        (checkoutDir: string) => {
          checkoutDirSeenByCallback = checkoutDir;
          throw new Error('sync failed');
        },
        fakeCloneInto,
      ),
    ).toThrow('sync failed');

    expect(checkoutDirSeenByCallback).not.toBe('');
    expect(existsSync(checkoutDirSeenByCallback)).toBe(false);
  });

  it('does not attempt to remove a caller-supplied --from directory on throw', () => {
    expect(() =>
      withMarkpostCheckout(repoDir, 'markpost-checkout-test-', () => {
        throw new Error('sync failed');
      }),
    ).toThrow('sync failed');

    expect(existsSync(repoDir)).toBe(true);
  });
});
