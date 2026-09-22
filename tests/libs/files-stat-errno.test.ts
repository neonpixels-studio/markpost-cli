import { statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveMarkdownInputs } from '@/libs/files.js';

// resolveMarkdownInputs discriminates a permission failure (EACCES/EPERM)
// from every other stat failure by reading `error.code`. EPERM is hard to
// trigger for real on POSIX (chmod 000 always raises EACCES, see
// files.test.ts's chmod-based locked-parent-directory tests), and an
// errno-less throw isn't reproducible via chmod at all, so this file mocks
// the fs interaction directly instead. It's a separate file so mocking
// `node:fs` here doesn't affect the real-filesystem tests in files.test.ts
// (each test file gets its own module registry). `vi.mock` is hoisted above
// these imports, so the static `statSync` import already resolves to the
// mock.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, statSync: vi.fn() };
});

const mockedStatSync = vi.mocked(statSync);

describe('resolveMarkdownInputs stat errno discrimination', () => {
  afterEach(() => {
    mockedStatSync.mockReset();
  });

  it('treats EPERM the same as EACCES: skipped, not missing', () => {
    const target = join('/mock', 'blocked.md');
    const permissionError = Object.assign(
      new Error('operation not permitted'),
      { code: 'EPERM' },
    );
    mockedStatSync.mockImplementation(() => {
      throw permissionError;
    });

    const { files, missing, skipped } = resolveMarkdownInputs([target]);

    expect(files).toEqual([]);
    expect(missing).toEqual([]);
    expect(skipped).toEqual([target]);
  });

  it('falls through to glob handling for a stat failure without an errno code', () => {
    const target = join('/mock', 'nope.md');
    mockedStatSync.mockImplementation(() => {
      throw new Error('boom');
    });

    const { files, missing, skipped } = resolveMarkdownInputs([target]);

    expect(files).toEqual([]);
    expect(skipped).toEqual([]);
    expect(missing).toEqual([target]);
  });
});
