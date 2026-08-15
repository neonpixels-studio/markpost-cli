import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import slugify from '@sindresorhus/slugify';

import { config } from '@/libs/config.js';
import {
  ensureOutputDirectory,
  MAX_COLLISION_SUFFIX,
  readMarkdown,
  writeMarkdown,
} from '@/libs/markdown.js';
import { Record } from '@/types/records.types.js';

const EXCLUSIVE_WRITE_OPTIONS = { flag: 'wx' };

const createFileAlreadyExistsError = (): NodeJS.ErrnoException => {
  const error = new Error('EEXIST') as NodeJS.ErrnoException;
  error.code = 'EEXIST';
  return error;
};

// Simulates a filesystem holding a set of paths. The exclusive-create ('wx')
// write rejects with EEXIST for a taken path (suffix/skip and the overwrite
// strategy's recreate step); a successful write adds the path. `rmSync`
// removes the path first, modelling the overwrite strategy's unlink-then-
// recreate, so both calls share one simulated disk.
const mockWriteFileSyncRejectingExistingPaths = (
  existingPaths: Iterable<string> = [],
): void => {
  const takenPaths = new Set(existingPaths);

  vi.mocked(writeFileSync).mockImplementation((path, _content, options) => {
    const flag =
      typeof options === 'object' && options !== null ? options.flag : undefined;

    if (flag === 'wx' && takenPaths.has(path as string)) {
      throw createFileAlreadyExistsError();
    }

    takenPaths.add(path as string);
  });

  vi.mocked(rmSync).mockImplementation((path) => {
    takenPaths.delete(path as string);
  });

  // Back lstat from the same simulated disk: a taken path is an existing regular
  // file, everything else is missing (undefined). This is what makes the reuse
  // path actually run in these tests — without it lstat returns undefined and
  // reuse never triggers, so the eviction/ownership guards would go untested.
  vi.mocked(lstatSync).mockImplementation((path) =>
    takenPaths.has(path as string) ? regularFileStats : undefined,
  );
};

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  lstatSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  rmSync: vi.fn(),
}));

// lstatSync(path, { throwIfNoEntry: false }) returns undefined for a missing
// entry, a Stats-like object otherwise. These stand-ins expose just isFile(),
// the only method resolveReusableWrittenPath calls.
const regularFileStats = { isFile: () => true } as unknown as ReturnType<
  typeof lstatSync
>;
const nonFileStats = { isFile: () => false } as unknown as ReturnType<
  typeof lstatSync
>;

vi.mock('@/libs/config.js', () => ({
  config: { get: vi.fn() },
}));

// Spy on the real slugify implementation so most tests exercise real
// sanitization end-to-end, while a couple of tests below can override its
// return value to prove the independent path-containment guard in
// markdown.ts does not simply rely on slugify behaving itself.
vi.mock('@sindresorhus/slugify', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@sindresorhus/slugify')>();
  return {
    ...actual,
    default: vi.fn(actual.default),
  };
});

// Captured once so beforeEach can restore the real behavior explicitly.
// mockReturnValueOnce queues are self-draining, but relying on every test
// to consume its own override is fragile; restoring a known-good default
// every time removes that assumption entirely.
const { default: actualSlugify } = await vi.importActual<
  typeof import('@sindresorhus/slugify')
>('@sindresorhus/slugify');

const outputDirectory = '/mock/output';

const mockRecord: Record = {
  uuid: 'abc-123',
  title: 'Test Title',
  content: 'Test Content',
  createdAt: '2024-01-01T00:00:00Z',
};

describe('writeMarkdown', () => {
  beforeEach(() => {
    process.env.OUTPUT_DIRECTORY = outputDirectory;
    vi.mocked(existsSync).mockReturnValue(false);
    // Reset rather than just clear call history: a couple of tests below
    // install a custom writeFileSync implementation to simulate on-disk
    // state, and clearAllMocks alone does not remove that implementation,
    // so it would otherwise leak into later tests. Same reasoning for
    // restoring slugify's real implementation here.
    vi.mocked(writeFileSync).mockReset();
    vi.mocked(rmSync).mockReset();
    // Reset to the "missing entry" default (undefined) so a per-test lstat
    // implementation can't leak into later tests via clearAllMocks.
    vi.mocked(lstatSync).mockReset();
    vi.mocked(slugify).mockImplementation(actualSlugify);
    vi.mocked(config.get).mockReturnValue(undefined);
  });

  afterEach(() => {
    delete process.env.OUTPUT_DIRECTORY;
    vi.clearAllMocks();
  });

  it('throws when neither OUTPUT_DIRECTORY nor the persisted config value is set', () => {
    delete process.env.OUTPUT_DIRECTORY;
    expect(() => writeMarkdown(mockRecord)).toThrow(
      'Output directory is not set!',
    );
  });

  it('falls back to the persisted config value when OUTPUT_DIRECTORY is not set', () => {
    delete process.env.OUTPUT_DIRECTORY;
    vi.mocked(config.get).mockReturnValue(outputDirectory);

    writeMarkdown(mockRecord);

    expect(config.get).toHaveBeenCalledWith('outputDirectory');
    expect(writeFileSync).toHaveBeenCalledWith(
      resolve(outputDirectory, 'test-title.md'),
      mockRecord.content,
      EXCLUSIVE_WRITE_OPTIONS,
    );
  });

  it('prefers OUTPUT_DIRECTORY over the persisted config value when both are set', () => {
    vi.mocked(config.get).mockReturnValue('/other/output');

    writeMarkdown(mockRecord);

    expect(writeFileSync).toHaveBeenCalledWith(
      resolve(outputDirectory, 'test-title.md'),
      mockRecord.content,
      EXCLUSIVE_WRITE_OPTIONS,
    );
  });

  it('calls mkdirSync when the output directory does not exist', () => {
    writeMarkdown(mockRecord);
    expect(mkdirSync).toHaveBeenCalledWith(outputDirectory, {
      recursive: true,
    });
  });

  it('does not call mkdirSync when the output directory already exists', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    writeMarkdown(mockRecord);
    expect(mkdirSync).not.toHaveBeenCalled();
  });

  it('calls writeFileSync with a slugified file path and the original content', () => {
    writeMarkdown(mockRecord);
    expect(writeFileSync).toHaveBeenCalledWith(
      resolve(outputDirectory, 'test-title.md'),
      mockRecord.content,
      EXCLUSIVE_WRITE_OPTIONS,
    );
  });

  it('returns the resolved path it wrote to', () => {
    const writtenPath = writeMarkdown(mockRecord);
    expect(writtenPath).toBe(resolve(outputDirectory, 'test-title.md'));
  });

  it('writes an assembled document with frontmatter when the record carries metadata', () => {
    const syncedRecord: Record = {
      ...mockRecord,
      title: 'Deploy',
      content: 'Commit shipped.',
      frontmatter: {
        title: 'Deploy',
        source: 'webhook/github',
        created: '2026-06-14T09:41:02Z',
        tags: ['ci'],
      },
    };

    writeMarkdown(syncedRecord);

    const [, writtenContent] = vi.mocked(writeFileSync).mock.calls[0];
    expect(writtenContent).toBe(
      '---\n' +
        'title: Deploy\n' +
        'source: webhook/github\n' +
        'created: 2026-06-14T09:41:02Z\n' +
        'tags: [ci]\n' +
        '---\n\n' +
        '# Deploy\n\n' +
        'Commit shipped.',
    );
  });

  it('writes the heading and body without a frontmatter block when frontmatter is disabled', () => {
    const syncedRecord: Record = {
      ...mockRecord,
      title: 'Deploy',
      content: 'Commit shipped.',
      frontmatter: {
        title: 'Deploy',
        source: 'webhook/github',
        created: '2026-06-14T09:41:02Z',
        tags: ['ci'],
      },
    };

    writeMarkdown(syncedRecord, 'suffix', new Map(), false);

    const [, writtenContent] = vi.mocked(writeFileSync).mock.calls[0];
    expect(writtenContent).toBe('# Deploy\n\nCommit shipped.');
  });

  it('keeps the write inside outputDirectory when the title contains path separators', () => {
    const maliciousRecord: Record = {
      ...mockRecord,
      title: '../../etc/passwd',
    };

    writeMarkdown(maliciousRecord);

    const [writtenPath] = vi.mocked(writeFileSync).mock.calls[0];
    expect(writtenPath).toBe(resolve(outputDirectory, 'etc-passwd.md'));
    expect(
      (writtenPath as string).startsWith(resolve(outputDirectory) + sep),
    ).toBe(true);
  });

  it('falls back to the record uuid when the title slugifies to an empty string', () => {
    const symbolOnlyRecord: Record = { ...mockRecord, title: '***' };

    writeMarkdown(symbolOnlyRecord);

    expect(writeFileSync).toHaveBeenCalledWith(
      resolve(outputDirectory, `${symbolOnlyRecord.uuid}.md`),
      symbolOnlyRecord.content,
      EXCLUSIVE_WRITE_OPTIONS,
    );
  });

  it('falls back to "untitled" when both the title and the uuid slugify to an empty string', () => {
    const emptySlugRecord: Record = { ...mockRecord, title: '***', uuid: '///' };

    writeMarkdown(emptySlugRecord);

    expect(writeFileSync).toHaveBeenCalledWith(
      resolve(outputDirectory, 'untitled.md'),
      emptySlugRecord.content,
      EXCLUSIVE_WRITE_OPTIONS,
    );
  });

  it('throws instead of writing outside outputDirectory even if slugify returns an unsafe value', () => {
    // slugify is expected to strip path separators and `..` segments, but
    // resolveWithinOutputDirectory is a second, independent guard and must
    // not rely on slugify behaving correctly. Force it to misbehave here.
    vi.mocked(slugify).mockReturnValueOnce('../escaped');

    expect(() => writeMarkdown(mockRecord)).toThrow(
      'Refusing to write outside output directory',
    );
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('writes both records to separate files when their titles collide', () => {
    mockWriteFileSyncRejectingExistingPaths();

    const firstRecord: Record = {
      ...mockRecord,
      uuid: 'first',
      title: 'Test Title',
    };
    const secondRecord: Record = {
      ...mockRecord,
      uuid: 'second',
      title: 'Test Title',
    };

    const firstWrittenPath = writeMarkdown(firstRecord);
    const secondWrittenPath = writeMarkdown(secondRecord);

    // The second write collides on its first attempt (same slug, same
    // path already taken by the first write) and retries with a suffix,
    // so writeFileSync is called with the base path twice: once for the
    // first record's successful write, once for the second record's
    // failed attempt before it falls through to the suffixed path.
    expect(firstWrittenPath).toBe(resolve(outputDirectory, 'test-title.md'));
    expect(secondWrittenPath).toBe(
      resolve(outputDirectory, 'test-title-2.md'),
    );
    expect(writeFileSync).toHaveBeenCalledWith(
      resolve(outputDirectory, 'test-title.md'),
      firstRecord.content,
      EXCLUSIVE_WRITE_OPTIONS,
    );
    expect(writeFileSync).toHaveBeenCalledWith(
      resolve(outputDirectory, 'test-title-2.md'),
      secondRecord.content,
      EXCLUSIVE_WRITE_OPTIONS,
    );
  });

  it('keeps incrementing the suffix past the first collision', () => {
    mockWriteFileSyncRejectingExistingPaths([
      resolve(outputDirectory, 'test-title.md'),
      resolve(outputDirectory, 'test-title-2.md'),
    ]);

    writeMarkdown(mockRecord);

    expect(writeFileSync).toHaveBeenCalledWith(
      resolve(outputDirectory, 'test-title-3.md'),
      mockRecord.content,
      EXCLUSIVE_WRITE_OPTIONS,
    );
  });

  it('gives up instead of looping forever once every slug variant is taken', () => {
    vi.mocked(writeFileSync).mockImplementation(() => {
      throw createFileAlreadyExistsError();
    });

    expect(() => writeMarkdown(mockRecord)).toThrow(
      'Too many filename collisions for "test-title"',
    );
    expect(vi.mocked(writeFileSync).mock.calls.length).toBeGreaterThan(1);
    expect(vi.mocked(writeFileSync).mock.calls.length).toBeLessThanOrEqual(
      MAX_COLLISION_SUFFIX,
    );
  });

  it('rethrows a non-collision error from writeFileSync instead of retrying', () => {
    const permissionError = new Error('EACCES') as NodeJS.ErrnoException;
    permissionError.code = 'EACCES';
    vi.mocked(writeFileSync).mockImplementation(() => {
      throw permissionError;
    });

    expect(() => writeMarkdown(mockRecord)).toThrow(permissionError);
    expect(writeFileSync).toHaveBeenCalledTimes(1);
  });

  it('defaults to the suffix strategy when no conflict strategy is given', () => {
    mockWriteFileSyncRejectingExistingPaths([
      resolve(outputDirectory, 'test-title.md'),
    ]);

    const writtenPath = writeMarkdown(mockRecord);

    expect(writtenPath).toBe(resolve(outputDirectory, 'test-title-2.md'));
  });

  describe('overwrite strategy', () => {
    it('removes any existing entry, then exclusively creates the base slug path', () => {
      const writtenPath = writeMarkdown(mockRecord, 'overwrite');

      expect(writtenPath).toBe(resolve(outputDirectory, 'test-title.md'));
      expect(rmSync).toHaveBeenCalledWith(
        resolve(outputDirectory, 'test-title.md'),
        { force: true },
      );
      expect(writeFileSync).toHaveBeenCalledTimes(1);
      expect(writeFileSync).toHaveBeenCalledWith(
        resolve(outputDirectory, 'test-title.md'),
        mockRecord.content,
        EXCLUSIVE_WRITE_OPTIONS,
      );
    });

    it('replaces an existing file at the slug path instead of suffix-renaming', () => {
      mockWriteFileSyncRejectingExistingPaths([
        resolve(outputDirectory, 'test-title.md'),
      ]);

      const writtenPath = writeMarkdown(mockRecord, 'overwrite');

      expect(writtenPath).toBe(resolve(outputDirectory, 'test-title.md'));
      expect(writeFileSync).not.toHaveBeenCalledWith(
        resolve(outputDirectory, 'test-title-2.md'),
        expect.anything(),
        expect.anything(),
      );
    });

    it('falls back to a suffix for a second same-slug record in one run so neither is clobbered', () => {
      mockWriteFileSyncRejectingExistingPaths();
      const seenSlugs = new Map<string, string>();
      const firstRecord: Record = {
        ...mockRecord,
        uuid: 'first',
        title: 'Test Title',
      };
      const secondRecord: Record = {
        ...mockRecord,
        uuid: 'second',
        title: 'Test Title',
      };

      const firstPath = writeMarkdown(firstRecord, 'overwrite', seenSlugs);
      const secondPath = writeMarkdown(secondRecord, 'overwrite', seenSlugs);

      expect(firstPath).toBe(resolve(outputDirectory, 'test-title.md'));
      expect(secondPath).toBe(resolve(outputDirectory, 'test-title-2.md'));
    });

    it('keeps suffixing subsequent same-slug records in one run', () => {
      mockWriteFileSyncRejectingExistingPaths();
      const seenSlugs = new Map<string, string>();

      const paths = ['first', 'second', 'third'].map((uuid) =>
        writeMarkdown({ ...mockRecord, uuid, title: 'Test Title' }, 'overwrite', seenSlugs),
      );

      expect(paths).toEqual([
        resolve(outputDirectory, 'test-title.md'),
        resolve(outputDirectory, 'test-title-2.md'),
        resolve(outputDirectory, 'test-title-3.md'),
      ]);
    });

    it('overwrites its own file when the same record is written again with a shared seenSlugs (autoSync retry), not a suffixed duplicate', () => {
      mockWriteFileSyncRejectingExistingPaths();
      // A record whose server delete/mark-synced failed is left pending and
      // re-fetched next pass. Sharing seenSlugs across passes must not downgrade
      // it to `suffix` — same uuid still owns its slug and overwrites in place.
      const seenSlugs = new Map<string, string>();
      const record: Record = { ...mockRecord, uuid: 'same', title: 'Test Title' };

      const firstPath = writeMarkdown(record, 'overwrite', seenSlugs);
      const secondPath = writeMarkdown(record, 'overwrite', seenSlugs);

      expect(firstPath).toBe(resolve(outputDirectory, 'test-title.md'));
      expect(secondPath).toBe(resolve(outputDirectory, 'test-title.md'));
      expect(writeFileSync).not.toHaveBeenCalledWith(
        resolve(outputDirectory, 'test-title-2.md'),
        expect.anything(),
        expect.anything(),
      );
    });

    it('never reassigns slug ownership, so the original owner still overwrites its own file after a different record suffixed', () => {
      mockWriteFileSyncRejectingExistingPaths();
      const seenSlugs = new Map<string, string>();
      const owner: Record = { ...mockRecord, uuid: 'owner', title: 'Test Title' };
      const other: Record = { ...mockRecord, uuid: 'other', title: 'Test Title' };

      writeMarkdown(owner, 'overwrite', seenSlugs); // test-title.md
      writeMarkdown(other, 'overwrite', seenSlugs); // suffixed to test-title-2.md
      const ownerRetryPath = writeMarkdown(owner, 'overwrite', seenSlugs);

      // If ownership were reassigned to `other`, the owner would be treated as a
      // different record and suffixed to test-title-3.md.
      expect(ownerRetryPath).toBe(resolve(outputDirectory, 'test-title.md'));
    });

    it('transfers ownership to whoever writes the base path when the prior owner\'s file was removed', () => {
      mockWriteFileSyncRejectingExistingPaths();
      const seenSlugs = new Map<string, string>();
      const owner: Record = { ...mockRecord, uuid: 'owner', title: 'Test Title' };
      const other: Record = { ...mockRecord, uuid: 'other', title: 'Test Title' };
      const basePath = resolve(outputDirectory, 'test-title.md');

      writeMarkdown(owner, 'overwrite', seenSlugs); // test-title.md, owned by owner
      rmSync(basePath, { force: true }); // user moves the file out of the vault
      // `other` is downgraded to suffix, but the base path is now free, so it
      // lands there and becomes the new owner.
      const otherPath = writeMarkdown(other, 'overwrite', seenSlugs);
      const ownerRetryPath = writeMarkdown(owner, 'overwrite', seenSlugs);

      expect(otherPath).toBe(basePath);
      expect(ownerRetryPath).toBe(resolve(outputDirectory, 'test-title-2.md'));
    });

    it('suffixes an empty-uuid record onto an already-owned slug so it cannot clobber the owner', () => {
      mockWriteFileSyncRejectingExistingPaths();
      const seenSlugs = new Map<string, string>();
      const owner: Record = { ...mockRecord, uuid: 'owner', title: 'Test Title' };
      const noUuid: Record = { ...mockRecord, uuid: '', title: 'Test Title' };

      writeMarkdown(owner, 'overwrite', seenSlugs); // test-title.md
      const noUuidPath = writeMarkdown(noUuid, 'overwrite', seenSlugs);

      expect(noUuidPath).toBe(resolve(outputDirectory, 'test-title-2.md'));
    });

    it('suffixes a suffixed write instead of claiming the base slug it never wrote', () => {
      // A file left by a previous run occupies test-title.md, so a suffix write
      // lands on test-title-2.md. It must not claim ownership of test-title.md;
      // otherwise a strategy switch to `overwrite` on its retry would truncate a
      // different record's file.
      mockWriteFileSyncRejectingExistingPaths([
        resolve(outputDirectory, 'test-title.md'),
      ]);
      const seenSlugs = new Map<string, string>();
      const suffixed: Record = {
        ...mockRecord,
        uuid: 'suffixed',
        title: 'Test Title',
      };
      const owner: Record = { ...mockRecord, uuid: 'owner', title: 'Test Title' };

      writeMarkdown(suffixed, 'suffix', seenSlugs); // test-title-2.md
      const ownerPath = writeMarkdown(owner, 'overwrite', seenSlugs);

      // `owner` is the first to write test-title.md, so it overwrites rather than
      // being pushed to a suffix by a phantom claim from `suffixed`.
      expect(ownerPath).toBe(resolve(outputDirectory, 'test-title.md'));
    });

    it('keys ownership by resolved path, so a mid-run outputDirectory change does not suppress overwrite in the new directory', () => {
      const otherDirectory = '/mock/output-2';
      // The new directory already holds a same-slug file from a previous run, so
      // a wrongly-suppressed overwrite would be visible as a suffix.
      mockWriteFileSyncRejectingExistingPaths([
        resolve(otherDirectory, 'test-title.md'),
      ]);
      const seenSlugs = new Map<string, string>();
      const owner: Record = { ...mockRecord, uuid: 'owner', title: 'Test Title' };
      const other: Record = { ...mockRecord, uuid: 'other', title: 'Test Title' };

      writeMarkdown(owner, 'overwrite', seenSlugs); // /mock/output/test-title.md
      process.env.OUTPUT_DIRECTORY = otherDirectory; // user changes the setting
      const otherPath = writeMarkdown(other, 'overwrite', seenSlugs);

      // Ownership was recorded for the old dir's path, so the new dir's base path
      // is unclaimed and `other` overwrites it. Keyed by bare slug, `other` would
      // be wrongly downgraded to test-title-2.md.
      expect(otherPath).toBe(resolve(otherDirectory, 'test-title.md'));
    });

    it('unlinks the path before writing so a symlink is removed, not followed', () => {
      const invocationOrder: string[] = [];
      vi.mocked(rmSync).mockImplementation(() => {
        invocationOrder.push('rm');
      });
      vi.mocked(writeFileSync).mockImplementation(() => {
        invocationOrder.push('write');
      });

      writeMarkdown(mockRecord, 'overwrite');

      expect(invocationOrder).toEqual(['rm', 'write']);
    });

    it('rethrows a write error from the recreate step', () => {
      const permissionError = new Error('EACCES') as NodeJS.ErrnoException;
      permissionError.code = 'EACCES';
      vi.mocked(writeFileSync).mockImplementation(() => {
        throw permissionError;
      });

      expect(() => writeMarkdown(mockRecord, 'overwrite')).toThrow(
        permissionError,
      );
    });
  });

  describe('skip strategy', () => {
    it('writes to the base slug path with the exclusive flag when it is free', () => {
      const writtenPath = writeMarkdown(mockRecord, 'skip');

      expect(writtenPath).toBe(resolve(outputDirectory, 'test-title.md'));
      expect(writeFileSync).toHaveBeenCalledWith(
        resolve(outputDirectory, 'test-title.md'),
        mockRecord.content,
        EXCLUSIVE_WRITE_OPTIONS,
      );
    });

    it('returns null and does not suffix-rename when the slug path is taken', () => {
      mockWriteFileSyncRejectingExistingPaths([
        resolve(outputDirectory, 'test-title.md'),
      ]);

      const writtenPath = writeMarkdown(mockRecord, 'skip');

      expect(writtenPath).toBeNull();
      expect(writeFileSync).toHaveBeenCalledTimes(1);
      expect(writeFileSync).not.toHaveBeenCalledWith(
        resolve(outputDirectory, 'test-title-2.md'),
        expect.anything(),
        expect.anything(),
      );
    });

    it('rethrows a non-collision error instead of returning null', () => {
      const permissionError = new Error('EACCES') as NodeJS.ErrnoException;
      permissionError.code = 'EACCES';
      vi.mocked(writeFileSync).mockImplementation(() => {
        throw permissionError;
      });

      expect(() => writeMarkdown(mockRecord, 'skip')).toThrow(permissionError);
    });

    it('does not claim slug ownership when it writes nothing, so a later overwrite record still owns the slug', () => {
      // A `skip` collision writes nothing (null). If it wrongly claimed the
      // slug, a genuinely different record would be forced onto `suffix` after
      // the user switches the strategy to `overwrite` between passes.
      mockWriteFileSyncRejectingExistingPaths([
        resolve(outputDirectory, 'test-title.md'),
      ]);
      const seenSlugs = new Map<string, string>();
      const skippedRecord: Record = { ...mockRecord, uuid: 'skipped' };
      const overwriteRecord: Record = {
        ...mockRecord,
        uuid: 'overwriter',
        title: 'Test Title',
      };

      expect(writeMarkdown(skippedRecord, 'skip', seenSlugs)).toBeNull();
      const overwritePath = writeMarkdown(
        overwriteRecord,
        'overwrite',
        seenSlugs,
      );

      expect(overwritePath).toBe(resolve(outputDirectory, 'test-title.md'));
    });
  });

  describe('written-vs-settled reuse', () => {
    it('reuses the same file across passes for a re-fetched unsettled record instead of dropping suffixed duplicates', () => {
      // The autoSync daemon re-fetches a record whose server settle failed as
      // still-pending next pass. Sharing writtenPaths across passes must reuse
      // its own file, never accumulate test-title-2.md, -3.md, ...
      mockWriteFileSyncRejectingExistingPaths();
      const basePath = resolve(outputDirectory, 'test-title.md');
      // Shared like the real processSeenSlugs/processWrittenPaths across passes.
      const seenSlugs = new Map<string, string>();
      const writtenPaths = new Map<string, string>();

      const firstPath = writeMarkdown(mockRecord, 'suffix', seenSlugs, true, writtenPaths);
      const secondPath = writeMarkdown(mockRecord, 'suffix', seenSlugs, true, writtenPaths);
      const thirdPath = writeMarkdown(mockRecord, 'suffix', seenSlugs, true, writtenPaths);

      expect(firstPath).toBe(basePath);
      expect(secondPath).toBe(basePath);
      expect(thirdPath).toBe(basePath);
      // Pass one writes the record's own base-path file...
      expect(writeFileSync).toHaveBeenCalledWith(
        basePath,
        mockRecord.content,
        EXCLUSIVE_WRITE_OPTIONS,
      );
      // ...and the regression this fixes: no suffixed duplicate is ever created.
      expect(writeFileSync).not.toHaveBeenCalledWith(
        resolve(outputDirectory, 'test-title-2.md'),
        expect.anything(),
        expect.anything(),
      );
    });

    it('does not rewrite a suffix-strategy file on reuse, so a vault edit between passes survives', () => {
      // `suffix` preserves existing files, so a note edited in Obsidian between
      // a failed settle and the next pass must not be clobbered by the retry.
      mockWriteFileSyncRejectingExistingPaths();
      const basePath = resolve(outputDirectory, 'test-title.md');
      const seenSlugs = new Map<string, string>();
      const writtenPaths = new Map<string, string>();

      writeMarkdown(mockRecord, 'suffix', seenSlugs, true, writtenPaths);
      vi.mocked(writeFileSync).mockClear();
      const secondPath = writeMarkdown(mockRecord, 'suffix', seenSlugs, true, writtenPaths);

      expect(secondPath).toBe(basePath);
      expect(writeFileSync).not.toHaveBeenCalled();
    });

    it('writes a fresh file when the tracked path is no longer a regular file (directory or symlink)', () => {
      // The base path was replaced by a directory or a symlink between passes;
      // lstat reports a non-file, so reuse is refused rather than settling the
      // record against it or following a symlink out of the vault.
      mockWriteFileSyncRejectingExistingPaths();
      const basePath = resolve(outputDirectory, 'test-title.md');
      const writtenPaths = new Map<string, string>();

      writeMarkdown(mockRecord, 'suffix', new Map(), true, writtenPaths);
      vi.mocked(lstatSync).mockImplementation((path) =>
        path === basePath ? nonFileStats : undefined,
      );
      const secondPath = writeMarkdown(mockRecord, 'suffix', new Map(), true, writtenPaths);

      // basePath is still taken on disk, so the record lands on a real suffixed
      // file instead of being silently settled against the non-file.
      expect(secondPath).toBe(resolve(outputDirectory, 'test-title-2.md'));
    });

    it('falls through to a fresh write when a different record claimed the tracked path after this record\'s file moved', () => {
      // A's file is moved out of the vault; next pass a different same-slug
      // record B claims the freed base path first. A's reuse must NOT overwrite
      // B (both are deleted server-side, so a clobber loses B everywhere).
      mockWriteFileSyncRejectingExistingPaths();
      const basePath = resolve(outputDirectory, 'test-title.md');
      const seenSlugs = new Map<string, string>();
      const writtenPaths = new Map<string, string>();
      const recordA: Record = { ...mockRecord, uuid: 'a', title: 'Test Title' };
      const recordB: Record = { ...mockRecord, uuid: 'b', title: 'Test Title', content: 'B content' };

      writeMarkdown(recordA, 'suffix', seenSlugs, true, writtenPaths); // test-title.md
      rmSync(basePath, { force: true }); // user moves A's file out of the vault
      const bPath = writeMarkdown(recordB, 'suffix', seenSlugs, true, writtenPaths);
      const aRetryPath = writeMarkdown(recordA, 'suffix', seenSlugs, true, writtenPaths);

      expect(bPath).toBe(basePath);
      // B's write evicts A's stale entry for the base path, so A no longer reuses
      // it and is pushed to a suffix instead of clobbering B's file.
      expect(aRetryPath).toBe(resolve(outputDirectory, 'test-title-2.md'));
    });

    it('falls through instead of reusing a suffixed path that another record now occupies', () => {
      // Pass 1: A → test-title.md, B → test-title-2.md; the delete fails so both
      // stay tracked. The user deletes B's file. Pass 2: a new record C claims
      // test-title-2.md. B must NOT reuse (and settle against) C's file — C's
      // write evicts B's stale suffixed-path entry (a suffixed path has no
      // seenSlugs owner, so eviction, not ownership lookup, is what catches it).
      mockWriteFileSyncRejectingExistingPaths();
      const suffixedPath = resolve(outputDirectory, 'test-title-2.md');
      const seenSlugs = new Map<string, string>();
      const writtenPaths = new Map<string, string>();
      const recordA: Record = { ...mockRecord, uuid: 'a', title: 'Test Title' };
      const recordB: Record = { ...mockRecord, uuid: 'b', title: 'Test Title' };
      const recordC: Record = { ...mockRecord, uuid: 'c', title: 'Test Title', content: 'C content' };

      writeMarkdown(recordA, 'suffix', seenSlugs, true, writtenPaths); // test-title.md
      writeMarkdown(recordB, 'suffix', seenSlugs, true, writtenPaths); // test-title-2.md
      rmSync(suffixedPath, { force: true }); // user deletes B's file from the vault
      const cPath = writeMarkdown(recordC, 'suffix', seenSlugs, true, writtenPaths);
      const bRetryPath = writeMarkdown(recordB, 'suffix', seenSlugs, true, writtenPaths);

      expect(cPath).toBe(suffixedPath);
      // B takes the next free suffix rather than reusing C's file.
      expect(bRetryPath).toBe(resolve(outputDirectory, 'test-title-3.md'));
    });

    it('writes into the current output directory when it changed between passes, not the tracked old one', () => {
      const newDirectory = '/mock/output-2';
      mockWriteFileSyncRejectingExistingPaths();
      const oldBasePath = resolve(outputDirectory, 'test-title.md');
      const newBasePath = resolve(newDirectory, 'test-title.md');
      const writtenPaths = new Map<string, string>();
      // The old file is still a regular file on the simulated disk, so a naive
      // uuid-only reuse would target it; the directory guard must reject it.

      writeMarkdown(mockRecord, 'suffix', new Map(), true, writtenPaths);
      process.env.OUTPUT_DIRECTORY = newDirectory; // user changes the setting
      const secondPath = writeMarkdown(mockRecord, 'suffix', new Map(), true, writtenPaths);

      // The stale old-directory entry is ignored; the record lands in the new
      // vault rather than being rewritten into the old one.
      expect(secondPath).toBe(newBasePath);
    });

    it('refreshes the reused file with the latest content under the overwrite strategy', () => {
      // `overwrite` opts into the newest record replacing the file, so reuse
      // rewrites rather than preserving stale content.
      mockWriteFileSyncRejectingExistingPaths();
      const basePath = resolve(outputDirectory, 'test-title.md');
      const seenSlugs = new Map<string, string>();
      const writtenPaths = new Map<string, string>();

      writeMarkdown(mockRecord, 'overwrite', seenSlugs, true, writtenPaths);
      const updatedRecord: Record = { ...mockRecord, content: 'Updated body' };
      writeMarkdown(updatedRecord, 'overwrite', seenSlugs, true, writtenPaths);

      expect(writeFileSync).toHaveBeenLastCalledWith(
        basePath,
        'Updated body',
        EXCLUSIVE_WRITE_OPTIONS,
      );
    });

    it('writes a fresh file when the tracked file was moved or deleted between passes', () => {
      mockWriteFileSyncRejectingExistingPaths();
      const basePath = resolve(outputDirectory, 'test-title.md');
      const writtenPaths = new Map<string, string>();

      const firstPath = writeMarkdown(mockRecord, 'suffix', new Map(), true, writtenPaths);
      // The user moves the file out of the vault: existsSync stays false (the
      // beforeEach default) and the disk model no longer holds the base path.
      rmSync(basePath, { force: true });
      const secondPath = writeMarkdown(mockRecord, 'suffix', new Map(), true, writtenPaths);

      // The stale tracked entry is ignored, so the record recreates its file at
      // the now-free base path rather than being pushed to a suffix.
      expect(firstPath).toBe(basePath);
      expect(secondPath).toBe(basePath);
    });

    it('records the written path per uuid so the orchestrator can carry it across passes', () => {
      const writtenPaths = new Map<string, string>();

      writeMarkdown(mockRecord, 'suffix', new Map(), true, writtenPaths);

      expect(writtenPaths.get(mockRecord.uuid)).toBe(
        resolve(outputDirectory, 'test-title.md'),
      );
    });

    it('never tracks or reuses a record with an empty uuid', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const writtenPaths = new Map<string, string>();
      const noUuidRecord: Record = { ...mockRecord, uuid: '' };

      writeMarkdown(noUuidRecord, 'suffix', new Map(), true, writtenPaths);

      expect(writtenPaths.size).toBe(0);
    });

    it('reuses a skip-strategy file without rewriting it, so a vault edit between passes survives', () => {
      mockWriteFileSyncRejectingExistingPaths();
      const basePath = resolve(outputDirectory, 'test-title.md');
      const writtenPaths = new Map<string, string>();

      // Pass one writes the file (absent), tracking it.
      const firstPath = writeMarkdown(mockRecord, 'skip', new Map(), true, writtenPaths);
      vi.mocked(writeFileSync).mockClear();
      // Pass two: the record is still unsettled and re-fetched. Under `skip` the
      // reused file must not be rewritten (the user may have edited it), but the
      // path still returns so the record can settle rather than loop pending.
      const secondPath = writeMarkdown(mockRecord, 'skip', new Map(), true, writtenPaths);

      expect(firstPath).toBe(basePath);
      expect(secondPath).toBe(basePath);
      expect(writeFileSync).not.toHaveBeenCalled();
    });

    it('does not track a skip-strategy no-op (null write) for reuse', () => {
      mockWriteFileSyncRejectingExistingPaths([
        resolve(outputDirectory, 'test-title.md'),
      ]);
      const writtenPaths = new Map<string, string>();

      expect(writeMarkdown(mockRecord, 'skip', new Map(), true, writtenPaths)).toBeNull();
      expect(writtenPaths.has(mockRecord.uuid)).toBe(false);
    });
  });
});

describe('ensureOutputDirectory', () => {
  beforeEach(() => {
    process.env.OUTPUT_DIRECTORY = outputDirectory;
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(config.get).mockReturnValue(undefined);
  });

  afterEach(() => {
    delete process.env.OUTPUT_DIRECTORY;
    vi.clearAllMocks();
  });

  it('throws when neither OUTPUT_DIRECTORY nor the persisted config value is set', () => {
    delete process.env.OUTPUT_DIRECTORY;
    expect(() => ensureOutputDirectory()).toThrow('Output directory is not set!');
  });

  it('creates the directory once and skips mkdirSync when it already exists', () => {
    // First call: directory missing, so it's created.
    const firstResult = ensureOutputDirectory();
    expect(firstResult).toBe(outputDirectory);
    expect(mkdirSync).toHaveBeenCalledTimes(1);

    // Second call after the directory now exists: the up-front creation stands,
    // so no second mkdirSync (the idempotence the writeMarkdown comment relies
    // on when it re-invokes this per record).
    vi.mocked(existsSync).mockReturnValue(true);
    ensureOutputDirectory();
    expect(mkdirSync).toHaveBeenCalledTimes(1);
  });
});

describe('readMarkdown', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('throws when the file does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(() => readMarkdown('./notes/missing.md')).toThrow(
      'File not found: ./notes/missing.md',
    );
  });

  it('derives the title from the filename without its extension', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(mockRecord.content);

    const result = readMarkdown('./notes/Test Title.md');

    expect(result.title).toBe('Test Title');
  });

  it('reads the file content as utf-8', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(mockRecord.content);

    const result = readMarkdown('./notes/Test Title.md');

    expect(readFileSync).toHaveBeenCalledWith(
      './notes/Test Title.md',
      'utf-8',
    );
    expect(result.content).toBe(mockRecord.content);
  });

  it('strips the frontmatter block and heading from a previously-pulled file so the push carries only the body', () => {
    const pulledDocument =
      '---\n' +
      'title: Deploy\n' +
      'source: webhook/github\n' +
      'created: 2026-06-14T09:41:02Z\n' +
      'tags: [ci]\n' +
      '---\n\n' +
      '# Deploy\n\n' +
      'Commit shipped.';
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(pulledDocument);

    const result = readMarkdown('./notes/deploy.md');

    expect(result.content).toBe('Commit shipped.');
  });
});
