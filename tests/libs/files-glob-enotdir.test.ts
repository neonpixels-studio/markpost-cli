// Node 22's fs.globSync throws ENOTDIR for a pattern whose path runs through a
// regular file; Node 24 returns no matches. Simulate the Node 22 behaviour so
// the guard is covered whichever Node runs the suite.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const globSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  globSync: globSyncMock,
}));

import { resolveMarkdownInputs } from '#src/libs/files.js';

const errnoError = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(code), { code });

describe('resolveMarkdownInputs glob errors', () => {
  beforeEach(() => {
    globSyncMock.mockReset();
  });

  it('treats an ENOTDIR from globSync as no matches', () => {
    globSyncMock.mockImplementation(() => {
      throw errnoError('ENOTDIR');
    });

    const { files, missing } = resolveMarkdownInputs(['does-not-exist/x.md']);

    expect(files).toEqual([]);
    expect(missing).toEqual(['does-not-exist/x.md']);
  });

  it('rethrows other globSync errors', () => {
    globSyncMock.mockImplementation(() => {
      throw errnoError('EIO');
    });

    expect(() => resolveMarkdownInputs(['does-not-exist/x.md'])).toThrow('EIO');
  });
});
