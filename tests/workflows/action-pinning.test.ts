// Every third-party action must be pinned to a full commit SHA with the
// version tag in a trailing comment, so a moved tag cannot change CI.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WORKFLOWS_DIRECTORY = fileURLToPath(
  new URL('../../.github/workflows/', import.meta.url),
);
const USES_PATTERN = /^\s*(?:-\s+)?uses:\s*['"]?([^'"\s]+)['"]?(.*)$/;
const SHA_REF_PATTERN = /^[^@\s]+@[0-9a-f]{40}$/;
const VERSION_COMMENT_PATTERN = /^\s+#\s*v?\d/;

interface ActionUse {
  file: string;
  line: number;
  reference: string;
  trailer: string;
}

function isLocalAction(reference: string): boolean {
  return reference.startsWith('./');
}

function listWorkflowFiles(): string[] {
  return readdirSync(WORKFLOWS_DIRECTORY).filter((name) =>
    /\.ya?ml$/.test(name),
  );
}

function readWorkflowLines(file: string): string[] {
  return readFileSync(join(WORKFLOWS_DIRECTORY, file), 'utf-8').split(/\r?\n/);
}

function parseActionUse(
  file: string,
  text: string,
  index: number,
): ActionUse | null {
  const match = USES_PATTERN.exec(text);
  if (!match || isLocalAction(match[1])) {
    return null;
  }

  return { file, line: index + 1, reference: match[1], trailer: match[2] };
}

function collectActionUses(): ActionUse[] {
  return listWorkflowFiles().flatMap((file) =>
    readWorkflowLines(file)
      .map((text, index) => parseActionUse(file, text, index))
      .filter((use): use is ActionUse => use !== null),
  );
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
