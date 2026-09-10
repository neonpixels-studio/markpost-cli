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
  assertPathIsCommitted,
  readCommitHash,
  readSource,
  resolveSourceRepo,
  withMarkpostCheckout,
  writeManifest,
  // @ts-expect-error -- plain .mjs, not part of the typed src/ tree.
} from '../../scripts/lib/markpost-checkout.mjs';

let repoDir: string;

function runGit(args: string[]) {
  execFileSync('git', args, { cwd: repoDir, encoding: 'utf-8' });
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

describe('withMarkpostCheckout', () => {
  // A fake `cloneInto` (the same shape as cloneMarkpostInto) that never
  // touches the network — it just proves it was called with the temp dir
  // withMarkpostCheckout created, by writing a marker file into it.
  function fakeCloneInto(cloneDir: string) {
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
