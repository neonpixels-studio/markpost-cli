// Creates and pushes the release tag (v<package.json version>) that triggers
// .github/workflows/release.yml. Reading the version here means the tag can't
// drift from package.json, which the workflow's tag check would reject.
//
// Usage: node scripts/release-tag.mjs [--dry-run] [path/to/package.json]
// --dry-run prints the git commands instead of running them.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const DEFAULT_PACKAGE_JSON = new URL('../package.json', import.meta.url);
const DRY_RUN_FLAG = '--dry-run';
const REMOTE = 'origin';

function readTag(packageJsonPath) {
  const { version } = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  if (typeof version !== 'string' || !version) {
    console.error('package.json has no "version" to tag.');
    process.exit(1);
  }

  return `v${version}`;
}

function gitCommands(tag) {
  return [
    ['tag', tag],
    ['push', REMOTE, tag],
  ];
}

const args = process.argv.slice(2);
const dryRun = args.includes(DRY_RUN_FLAG);
const packageJsonPath =
  args.find((arg) => arg !== DRY_RUN_FLAG) ?? DEFAULT_PACKAGE_JSON;
const tag = readTag(packageJsonPath);

for (const command of gitCommands(tag)) {
  if (dryRun) {
    console.log(`git ${command.join(' ')}`);
    continue;
  }

  execFileSync('git', command, { stdio: 'inherit' });
}
