import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT_PATH = join(REPO_ROOT, 'scripts/release-tag.mjs');
// Keeps the developer's global config (commit signing, etc.) out of the
// throwaway repos, matching the other git-backed script tests.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'markpost-release-tag-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function writePackageJson(directory: string, contents: object): string {
  const packageJsonPath = join(directory, 'package.json');
  writeFileSync(packageJsonPath, JSON.stringify(contents));

  return packageJsonPath;
}

function runReleaseTag(args: string[], cwd: string = REPO_ROOT) {
  return spawnSync('node', [SCRIPT_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    env: GIT_ENV,
  });
}

function runGit(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: GIT_ENV });
}

describe('release-tag script', () => {
  it('is wired up as npm run release:tag', () => {
    const { scripts } = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'),
    );

    expect(scripts['release:tag']).toBe('node scripts/release-tag.mjs');
  });

  it('derives the tag from package.json in a dry run', () => {
    const packageJsonPath = writePackageJson(workspace, {
      version: '0.1.0-alpha.1',
    });

    const result = runReleaseTag(['--dry-run', packageJsonPath]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      'git tag v0.1.0-alpha.1\ngit push origin v0.1.0-alpha.1\n',
    );
  });

  it('fails without a version and runs no git commands', () => {
    const packageJsonPath = writePackageJson(workspace, {});

    const result = runReleaseTag(['--dry-run', packageJsonPath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no "version"');
    expect(result.stdout).toBe('');
  });

  it('creates the tag and pushes it to origin', () => {
    const remoteDir = join(workspace, 'remote.git');
    const cloneDir = join(workspace, 'clone');
    runGit(['init', '--quiet', '--bare', remoteDir], workspace);
    runGit(['clone', '--quiet', remoteDir, cloneDir], workspace);
    runGit(['config', 'user.email', 'test@example.com'], cloneDir);
    runGit(['config', 'user.name', 'Test'], cloneDir);
    const packageJsonPath = writePackageJson(cloneDir, { version: '1.2.3' });
    runGit(['add', 'package.json'], cloneDir);
    runGit(['commit', '--quiet', '-m', 'release 1.2.3'], cloneDir);

    const result = runReleaseTag([packageJsonPath], cloneDir);

    expect(result.status).toBe(0);
    const head = runGit(['rev-parse', 'HEAD'], cloneDir).trim();
    expect(runGit(['rev-parse', 'v1.2.3^{commit}'], remoteDir).trim()).toBe(
      head,
    );
  });
});
