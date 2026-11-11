// Fails unless the pushed tag (vX.Y.Z) matches package.json's version.
import { readFileSync } from 'node:fs';

const tag = process.argv[2] ?? '';
const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
);

if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(
    `package.json version "${version}" must be a plain X.Y.Z release (prereleases are not published by this workflow).`,
  );
  process.exit(1);
}

if (tag !== `v${version}`) {
  console.error(
    `Tag "${tag}" does not match package.json version "v${version}".`,
  );
  process.exit(1);
}
console.log(`Tag ${tag} matches package.json version.`);
