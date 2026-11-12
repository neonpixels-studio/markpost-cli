// Guards the supply-chain properties of the tag-triggered release workflow.
// The YAML is checked as text (no YAML parser dependency) because the
// properties are simple, line-level invariants.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SHA_PATTERN = /^[0-9a-f]{40}$/;

const workflow = readFileSync(
  `${REPO_ROOT}.github/workflows/release.yml`,
  'utf-8',
);

// Splits the `jobs:` block into `{ name: body }` using the 2-space job keys.
function jobBodies(): Record<string, string> {
  const jobsBlock = workflow.split(/^jobs:\n/m)[1] ?? '';
  const bodies: Record<string, string> = {};
  const parts = jobsBlock.split(/^ {2}([a-z-]+):\n/m);
  for (let index = 1; index < parts.length; index += 2) {
    bodies[parts[index]] = parts[index + 1];
  }

  return bodies;
}

function runTagCheck(...args: string[]) {
  return runTagCheckWithEnv({}, ...args);
}

function runTagCheckWithEnv(env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync('node', ['scripts/check-release-tag.mjs', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: { ...process.env, GITHUB_OUTPUT: '', ...env },
  });
}

describe('release workflow', () => {
  it('triggers only on version tags', () => {
    expect(workflow).toMatch(/on:\n {2}push:\n {4}tags: \['v\*\.\*\.\*'\]/);
    expect(workflow).not.toMatch(
      /workflow_dispatch|pull_request|schedule:|branches:|release:/,
    );
  });

  it('pins every action to a full commit SHA', () => {
    const uses = [...workflow.matchAll(/uses:\s*(\S+)/g)].map(
      (match) => match[1],
    );
    expect(uses.length).toBeGreaterThan(0);
    for (const reference of uses) {
      expect(reference.split('@')[1]).toMatch(SHA_PATTERN);
    }
  });

  it('sets timeout-minutes on every job', () => {
    const bodies = jobBodies();
    expect(Object.keys(bodies).sort()).toEqual(['publish', 'verify']);
    for (const body of Object.values(bodies)) {
      expect(body).toMatch(/^ {4}timeout-minutes: \d+$/m);
    }
  });

  it('has minimal top-level permissions and a concurrency guard', () => {
    const header = workflow.split(/^jobs:/m)[0];
    expect(header).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(header).not.toMatch(/id-token/);
    expect(header).toMatch(/^concurrency:/m);
  });

  it('grants id-token: write only to the publish job', () => {
    const bodies = jobBodies();
    expect(bodies.publish).toMatch(/id-token: write/);
    expect(bodies.verify).not.toMatch(/id-token/);
    expect(bodies.publish).toMatch(/needs: verify/);
  });

  it('publishes with provenance and no long-lived token', () => {
    expect(jobBodies().publish).toMatch(/npm publish[^\n]*--provenance/);
    expect(workflow).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/);
  });

  it('publishes under the dist-tag computed by the verify job', () => {
    const bodies = jobBodies();
    expect(bodies.verify).toMatch(
      /dist-tag: \$\{\{ steps\.tag-check\.outputs\.dist-tag \}\}/,
    );
    expect(bodies.verify).toMatch(
      /id: tag-check\n\s+run: node scripts\/check-release-tag\.mjs/,
    );
    expect(bodies.publish).toMatch(/npm publish[^\n]*--tag "\$DIST_TAG"/);
    expect(bodies.publish).toMatch(
      /DIST_TAG: \$\{\{ needs\.verify\.outputs\.dist-tag \}\}/,
    );
  });

  it('checks the tag against package.json before installing dependencies', () => {
    const verify = jobBodies().verify;
    const tagCheck = verify.indexOf('scripts/check-release-tag.mjs');
    expect(tagCheck).toBeGreaterThan(-1);
    expect(tagCheck).toBeLessThan(verify.indexOf('npm ci'));
  });

  it('requires the tagged commit to be an ancestor of main', () => {
    expect(jobBodies().verify).toContain(
      'git merge-base --is-ancestor "$GITHUB_SHA" origin/main',
    );
  });

  it('does not run dependency install scripts in the publish job', () => {
    expect(jobBodies().publish).toContain('npm ci --ignore-scripts');
    expect(jobBodies().publish).not.toMatch(/npm ci\s*$/m);
  });

  it('runs lint, typecheck, test:ci and the pack smoke test', () => {
    const verify = jobBodies().verify;
    for (const command of [
      'npm run lint',
      'npm run typecheck',
      'npm run test:ci',
      'bash scripts/smoke-test-pack.sh',
    ]) {
      expect(verify).toContain(command);
    }
  });
});

describe('check-release-tag script', () => {
  const { version } = JSON.parse(
    readFileSync(`${REPO_ROOT}package.json`, 'utf-8'),
  );

  it('passes when the tag matches package.json', () => {
    expect(runTagCheck(`v${version}`).status).toBe(0);
  });

  it('fails when the tag does not match package.json', () => {
    const result = runTagCheck('v999.0.0');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not match');
  });

  it('fails when no tag is given', () => {
    expect(runTagCheck('').status).toBe(1);
    expect(runTagCheck().status).toBe(1);
  });
});

describe('check-release-tag dist-tag', () => {
  let workspace: string;
  let outputPath: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'markpost-release-tag-'));
    outputPath = join(workspace, 'github-output');
    writeFileSync(outputPath, '');
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  function checkVersion(version: string, tag = `v${version}`) {
    const packageJsonPath = join(workspace, 'package.json');
    writeFileSync(packageJsonPath, JSON.stringify({ version }));
    const result = runTagCheckWithEnv(
      { GITHUB_OUTPUT: outputPath },
      tag,
      packageJsonPath,
    );

    return { ...result, output: readFileSync(outputPath, 'utf-8') };
  }

  it('publishes a plain X.Y.Z release to latest', () => {
    const result = checkVersion('1.2.3');
    expect(result.status).toBe(0);
    expect(result.output).toBe('dist-tag=latest\n');
  });

  it('publishes an alpha prerelease to the alpha dist-tag', () => {
    const result = checkVersion('0.1.0-alpha.0');
    expect(result.status).toBe(0);
    expect(result.output).toBe('dist-tag=alpha\n');
  });

  it('uses the preid of any prerelease as the dist-tag', () => {
    expect(checkVersion('2.0.0-rc.3').output).toBe('dist-tag=rc\n');
  });

  it('rejects a prerelease whose preid is not a word', () => {
    const result = checkVersion('1.0.0-0');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('lowercase word');
    expect(result.output).toBe('');
  });

  it('rejects a version that is not semver', () => {
    const result = checkVersion('1.0');
    expect(result.status).toBe(1);
    expect(result.output).toBe('');
  });

  it('writes no output when the tag does not match', () => {
    const result = checkVersion('0.1.0-alpha.0', 'v0.1.0-alpha.1');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not match');
    expect(result.output).toBe('');
  });
});
