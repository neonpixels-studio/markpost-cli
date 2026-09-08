// Guards against `npm publish` silently shipping a broken `markpost` binary.
// package.json declares `bin.markpost` as `./dist/index.js`, but `dist/` is
// gitignored and only produced by `npm run build`. Without a `files`
// allowlist that includes `dist` and a `prepack`/`prepublishOnly` hook that
// cleans and rebuilds it, `npm pack`/`npm publish` packs the repo's source
// tree instead and installers get a package with no working `dist/index.js`.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const PACKAGE_JSON_PATH = fileURLToPath(
  new URL('../package.json', import.meta.url),
);

function readPackageJson(): {
  bin?: Record<string, string> | string;
  files?: string[];
  scripts?: Record<string, string>;
} {
  return JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
}

// npm allows `bin` as either a map of command name -> path, or a bare string
// shorthand (one binary, named after the package) — both must be handled or
// this test breaks the moment someone uses the shorthand form.
function binTargets(
  bin: Record<string, string> | string | undefined,
): string[] {
  if (typeof bin === 'string') {
    return [bin];
  }

  return Object.values(bin ?? {});
}

// The top-level directory a bin target lives under, e.g. `./dist/index.js`
// -> `dist`. Deriving this from `bin` (rather than hardcoding `'dist'`) means
// the test keeps guarding the real invariant — "whatever bin points at is
// actually packed" — even if the build output directory is renamed.
function binRootDirectories(
  bin: Record<string, string> | string | undefined,
): string[] {
  const targets = binTargets(bin);

  return [
    ...new Set(
      targets.map((target) => target.replace(/^\.\//, '').split('/')[0]),
    ),
  ];
}

// Normalizes a `files` entry to the top-level directory it packs, so
// `'dist'`, `'dist/'`, `'/dist'`, and glob forms like `'dist/**'` all match
// the same way `npm pack` treats them. Negated entries (`'!dist/**/*.map'`)
// are excludes, not something that should ever satisfy the allowlist check,
// so they're dropped rather than normalized.
function normalizeFilesEntry(entry: string): string | undefined {
  if (entry.startsWith('!')) {
    return undefined;
  }

  return entry.replace(/^[./]+/, '').split('/')[0];
}

function packedTopLevelRoots(files: string[] | undefined): string[] {
  return (files ?? [])
    .map(normalizeFilesEntry)
    .filter((root): root is string => root !== undefined);
}

// Builds a regex requiring an actual removal of `binRoot` (`rm -rf dist`,
// `rimraf dist`, or `fs.rmSync('dist', ...)`), not just the directory name
// appearing anywhere in the script — a hook like `"echo dist && npm run
// build"` should fail this check, not satisfy it.
function cleanCommandPattern(binRoot: string): RegExp {
  const escapedRoot = binRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  return new RegExp(
    String.raw`(rm\s+-rf?\s+\.?/?${escapedRoot}\b|rimraf\s+\.?/?${escapedRoot}\b|rmSync\(\s*['"]\.?/?${escapedRoot}['"])`,
  );
}

describe('package.json publish configuration', () => {
  it('allowlists every bin target directory via the files field', () => {
    const packageJson = readPackageJson();
    const packedRoots = packedTopLevelRoots(packageJson.files);
    const binRoots = binRootDirectories(packageJson.bin);

    // A `bin` field that resolves to zero targets would make the loop below
    // assert nothing and pass vacuously — fail loudly instead.
    expect(binRoots.length).toBeGreaterThan(0);

    for (const binRoot of binRoots) {
      expect(packedRoots).toContain(binRoot);
    }
  });

  it('cleans and rebuilds every bin target directory before publish', () => {
    const packageJson = readPackageJson();
    const scripts = packageJson.scripts ?? {};
    const buildHook = scripts.prepack ?? scripts.prepublishOnly;
    const binRoots = binRootDirectories(packageJson.bin);

    expect(binRoots.length).toBeGreaterThan(0);
    expect(buildHook).toBeDefined();

    const hookScript = buildHook as string;
    const buildIndex = hookScript.indexOf('npm run build');

    expect(hookScript).toMatch(/\bnpm run build\b/);

    for (const binRoot of binRoots) {
      const cleanMatch = hookScript.match(cleanCommandPattern(binRoot));

      expect(cleanMatch).not.toBeNull();
      // The clean step must run *before* the build, or a stale file left
      // over from a deleted/renamed source module (tsc does not remove
      // outputs on its own) would still get packed.
      expect(cleanMatch!.index).toBeLessThan(buildIndex);
    }
  });

  // The two tests above check package.json's *configuration*; this checks
  // the actual result. `npm pack` runs the real prepack/build lifecycle, so
  // this catches drift the config checks can't: a broken build, an outDir
  // that no longer matches `bin`, or a `files` entry that's syntactically
  // present but doesn't match what the packer actually includes.
  // Runs the real build (tsc + tsc-alias) via the prepack hook, which is
  // slower than vitest's default 5s timeout on a cold run.
  const PACK_TEST_TIMEOUT_MS = 30_000;

  it(
    'actually includes every bin target in the packed tarball',
    () => {
      const packOutput = execFileSync('npm', ['pack', '--dry-run', '--json'], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
      });
      const [packResult] = JSON.parse(packOutput) as [
        { files: { path: string }[] },
      ];
      const packedPaths = new Set(packResult.files.map((file) => file.path));
      const packageJson = readPackageJson();

      for (const binTarget of binTargets(packageJson.bin)) {
        expect(packedPaths).toContain(binTarget.replace(/^\.\//, ''));
      }
    },
    PACK_TEST_TIMEOUT_MS,
  );
});
