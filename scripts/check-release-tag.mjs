// Fails unless the pushed tag (vX.Y.Z or vX.Y.Z-<preid>.N) matches
// package.json's version, then reports the npm dist-tag to publish under:
// `latest` for X.Y.Z, the preid (e.g. `alpha`) for prereleases, so a
// prerelease can never land on `latest`.
//
// Usage: node scripts/check-release-tag.mjs <tag> [path/to/package.json]
// Writes `dist-tag=<tag>` to $GITHUB_OUTPUT when set.
import { appendFileSync, readFileSync } from 'node:fs';

const DEFAULT_PACKAGE_JSON = new URL('../package.json', import.meta.url);
const STABLE_DIST_TAG = 'latest';
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-([0-9A-Za-z.-]+))?$/;
// npm rejects dist-tags that parse as semver ranges, so a preid must be a word.
const PREID_PATTERN = /^[a-z]+$/;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readVersion(packageJsonPath) {
  const { version } = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  if (typeof version !== 'string') {
    fail(`package.json has no string "version" field.`);
  }

  return version;
}

function distTagFor(version) {
  const match = VERSION_PATTERN.exec(version);
  if (!match) {
    fail(
      `package.json version "${version}" must be X.Y.Z or X.Y.Z-<preid>.N (e.g. 0.1.0-alpha.0).`,
    );
  }

  const prerelease = match[1];
  if (prerelease === undefined) {
    return STABLE_DIST_TAG;
  }

  const preid = prerelease.split('.')[0];
  if (!PREID_PATTERN.test(preid)) {
    fail(
      `Prerelease "${prerelease}" must start with a lowercase word used as the npm dist-tag (e.g. alpha.0).`,
    );
  }

  return preid;
}

function writeOutput(distTag) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }

  appendFileSync(outputPath, `dist-tag=${distTag}\n`);
}

const tag = process.argv[2] ?? '';
const version = readVersion(process.argv[3] ?? DEFAULT_PACKAGE_JSON);
const distTag = distTagFor(version);

if (tag !== `v${version}`) {
  fail(`Tag "${tag}" does not match package.json version "v${version}".`);
}

writeOutput(distTag);
console.log(
  `Tag ${tag} matches package.json version; npm dist-tag: ${distTag}.`,
);
