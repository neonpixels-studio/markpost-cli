// The dependency-audit job must go through the allowlist-aware script, and
// every allowlisted advisory must stay pinned to one install path.
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPT_URL = new URL('../../.github/scripts/audit.sh', import.meta.url);
const WORKFLOW_URL = new URL(
  '../../.github/workflows/security.yml',
  import.meta.url,
);
const ENTRY_PATTERN = /^\s+"(GHSA-[\w-]+@node_modules\/[^"]+)"/gm;
const EXECUTABLE_BITS = 0o111;

describe('dependency-audit gate', () => {
  it('runs the allowlist-aware script in the workflow', () => {
    const workflow = readFileSync(WORKFLOW_URL, 'utf8');

    expect(workflow).toContain('run: .github/scripts/audit.sh');
    expect(workflow).not.toMatch(/run:\s*npm audit --audit-level=high/);
  });

  it('keeps the script executable', () => {
    const mode = statSync(fileURLToPath(SCRIPT_URL)).mode;

    expect(mode & EXECUTABLE_BITS).not.toBe(0);
  });

  it('only allowlists picomatch GHSA-fc5q at its single install path', () => {
    const script = readFileSync(SCRIPT_URL, 'utf8');
    const entries = [...script.matchAll(ENTRY_PATTERN)].map(
      (match) => match[1],
    );

    expect(entries).toEqual(['GHSA-fc5q-39xc-vjpf@node_modules/picomatch']);
  });
});
