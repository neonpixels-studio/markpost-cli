// Guards the supported Node range. `engines.node` gives users an install-time
// warning instead of a cryptic runtime error, and the CI matrix must test the
// declared floor or the claim is unverified.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const readRepoFile = (relativePath: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    'utf-8',
  );

const readEnginesNode = (): string | undefined =>
  JSON.parse(readRepoFile('package.json')).engines?.node;

// The lowest version in a range such as `^22.13.0 || >=24.0.0`.
const lowestVersion = (range: string): string => {
  const versions = [...range.matchAll(/(\d+)\.(\d+)\.(\d+)/g)].map((match) =>
    match.slice(1, 4).map(Number),
  );
  const [lowest] = versions.sort(
    (left, right) =>
      left[0] - right[0] || left[1] - right[1] || left[2] - right[2],
  );

  if (!lowest) {
    throw new Error(`No x.y.z version found in engines range "${range}"`);
  }

  return lowest.join('.');
};

const matrixNodeVersions = (workflow: string): string[] => {
  const line = workflow.match(/^\s*node:\s*\[(.*)\]\s*$/m);

  return (line?.[1] ?? '')
    .split(',')
    .map((version) => version.trim().replace(/['"]/g, ''))
    .filter(Boolean);
};

describe('supported Node range', () => {
  it('declares engines.node', () => {
    expect(readEnginesNode()).toMatch(/\d+\.\d+\.\d+/);
  });

  it('tests the engines.node floor in the CI matrix', () => {
    const floor = lowestVersion(readEnginesNode() ?? '');

    expect(
      matrixNodeVersions(readRepoFile('.github/workflows/ci.yml')),
    ).toContain(floor);
  });

  it('tests Windows in the CI matrix', () => {
    expect(readRepoFile('.github/workflows/ci.yml')).toMatch(
      /^\s*-\s*os:\s*windows-latest\s*$/m,
    );
  });

  it('lowestVersion picks the smallest version in a range', () => {
    expect(lowestVersion('^22.13.0 || >=24.0.0')).toBe('22.13.0');
    expect(lowestVersion('>=24.0.0 || ^20.9.1')).toBe('20.9.1');
    expect(() => lowestVersion('>=22')).toThrow('No x.y.z version');
  });
});
