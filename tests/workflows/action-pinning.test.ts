// Every third-party action must be pinned to a full commit SHA with the
// version tag in a trailing comment, so a moved tag cannot change CI.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WORKFLOWS_DIRECTORY = fileURLToPath(
  new URL('../../.github/workflows/', import.meta.url),
);
const USES_PATTERN = /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/;
const SHA_REF_PATTERN = /^[^@\s]+@[0-9a-f]{40}$/;
const VERSION_COMMENT_PATTERN = /^\s+#\s*v?\d/;

interface ActionUse {
  file: string;
  line: number;
  reference: string;
  trailer: string;
}

function isFirstParty(reference: string): boolean {
  return reference.startsWith('./') || reference.startsWith('docker://');
}

function collectActionUses(): ActionUse[] {
  const uses: ActionUse[] = [];
  const files = readdirSync(WORKFLOWS_DIRECTORY).filter((name) =>
    /\.ya?ml$/.test(name),
  );
  for (const file of files) {
    const lines = readFileSync(`${WORKFLOWS_DIRECTORY}${file}`, 'utf-8').split(
      '\n',
    );
    lines.forEach((text, index) => {
      const match = USES_PATTERN.exec(text);
      if (!match || isFirstParty(match[1])) {
        return;
      }
      uses.push({
        file,
        line: index + 1,
        reference: match[1],
        trailer: match[2],
      });
    });
  }

  return uses;
}

describe('workflow action pinning', () => {
  const uses = collectActionUses();

  it('finds third-party actions to check', () => {
    expect(uses.length).toBeGreaterThan(0);
  });

  it('pins every third-party action to a full commit SHA', () => {
    const unpinned = uses
      .filter((use) => !SHA_REF_PATTERN.test(use.reference))
      .map((use) => `${use.file}:${use.line} ${use.reference}`);
    expect(unpinned).toEqual([]);
  });

  it('records the version tag in a trailing comment', () => {
    const missing = uses
      .filter((use) => !VERSION_COMMENT_PATTERN.test(use.trailer))
      .map((use) => `${use.file}:${use.line} ${use.reference}`);
    expect(missing).toEqual([]);
  });
});
