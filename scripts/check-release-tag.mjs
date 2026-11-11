// Fails unless the pushed tag (vX.Y.Z) matches package.json's version.
import { readFileSync } from 'node:fs';

const tag = process.argv[2] ?? '';
const { version } = JSON.parse(readFileSync('package.json', 'utf-8'));

if (tag !== `v${version}`) {
  console.error(
    `Tag "${tag}" does not match package.json version "v${version}".`,
  );
  process.exit(1);
}
console.log(`Tag ${tag} matches package.json version.`);
