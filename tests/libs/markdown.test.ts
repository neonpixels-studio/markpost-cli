import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import slugify from '@sindresorhus/slugify';

import { config } from '@/libs/config.js';
import {
  buildWritePreview,
  ensureOutputDirectory,
  MAX_COLLISION_SUFFIX,
  readMarkdown,
  writeMarkdown,
} from '@/libs/markdown.js';
import type { WrittenRecordState } from '@/libs/markdown.js';
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
  // Each path carries its own identity, assigned fresh on every write so a
  // rewrite (rmSync + writeFileSync, the overwrite/refresh path) models a new
  // file with a new inode — distinct identities let a bug that stats or compares
  // the wrong path fail loudly instead of matching by accident. One shared device
  // id models a single-filesystem vault (the common case).
  const MODEL_DEVICE_ID = 1n;
  const identities = new Map<string, { dev: bigint; ino: bigint }>();
  let nextInode = 1n;

  const assignIdentity = (path: string): void => {
    identities.set(path, { dev: MODEL_DEVICE_ID, ino: nextInode });
    nextInode += 1n;
  };

  for (const path of takenPaths) {
    assignIdentity(path);
  }

  vi.mocked(writeFileSync).mockImplementation((path, _content, options) => {
    const flag =
      typeof options === 'object' && options !== null ? options.flag : undefined;

    if (flag === 'wx' && takenPaths.has(path as string)) {
      throw createFileAlreadyExistsError();
    }

    takenPaths.add(path as string);
    assignIdentity(path as string);
  });

  vi.mocked(rmSync).mockImplementation((path) => {
    takenPaths.delete(path as string);
    identities.delete(path as string);
  });

  // Back lstat from the same simulated disk: a taken path is an existing regular
  // file carrying its assigned identity, everything else is missing (undefined).
  // This is what makes the reuse path actually run in these tests — without it
  // lstat returns undefined and reuse never triggers, so the eviction/ownership
  // and identity guards would go untested.
  vi.mocked(lstatSync).mockImplementation((path) => {
    const identity = identities.get(path as string);

    if (!identity) {
      return undefined;
    }

    return identityStats(identity.dev, identity.ino);
  });
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
// entry, a Stats-like object otherwise. `nonFileStats` models a directory or
// symlink (isFile() false); `identityStats` models a regular file carrying the
// `dev`/`ino` the reuse-identity check reads.
const nonFileStats = { isFile: () => false } as unknown as ReturnType<
  typeof lstatSync
>;

// A regular-file stat carrying an explicit identity, for tests that swap the file
// at a tracked path between passes: a new inode (or device) models the different
// file a replacement drops there.
const identityStats = (deviceId: bigint, inode: bigint): ReturnType<
  typeof lstatSync
> => {
  return {
    isFile: () => true,
    dev: deviceId,
    ino: inode,
  } as unknown as ReturnType<typeof lstatSync>;
};

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
    // Reset readFileSync too: the reuse-refresh tests below stub it to model the
    // file's on-disk bytes, and clearAllMocks alone would leave that return
    // value in place for later tests.
    vi.mocked(readFileSync).mockReset();
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

  it('expands a leading ~ in the configured output directory before writing', () => {
    process.env.OUTPUT_DIRECTORY = '~/notes';

    writeMarkdown(mockRecord);

    expect(writeFileSync).toHaveBeenCalledWith(
      resolve(homedir(), 'notes', 'test-title.md'),
      mockRecord.content,
      EXCLUSIVE_WRITE_OPTIONS,
    );
  });

  it('expands $HOME in the persisted config value before creating the directory', () => {
    delete process.env.OUTPUT_DIRECTORY;
    vi.mocked(config.get).mockReturnValue('$HOME/notes');

    writeMarkdown(mockRecord);

    expect(mkdirSync).toHaveBeenCalledWith(resolve(homedir(), 'notes'), {
      recursive: true,
    });
    expect(writeFileSync).toHaveBeenCalledWith(
      resolve(homedir(), 'notes', 'test-title.md'),
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
      // still-pending next pass. Sharing writtenState across passes must reuse
      // its own file, never accumulate test-title-2.md, -3.md, ...
      mockWriteFileSyncRejectingExistingPaths();
      const basePath = resolve(outputDirectory, 'test-title.md');
      // Shared like the real processSeenSlugs/processWrittenPaths across passes.
      const seenSlugs = new Map<string, string>();
      const writtenState = new Map<string, WrittenRecordState>();

      const firstPath = writeMarkdown(mockRecord, 'suffix', seenSlugs, true, writtenState);
      const secondPath = writeMarkdown(mockRecord, 'suffix', seenSlugs, true, writtenState);
      const thirdPath = writeMarkdown(mockRecord, 'suffix', seenSlugs, true, writtenState);

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
      const writtenState = new Map<string, WrittenRecordState>();

      writeMarkdown(mockRecord, 'suffix', seenSlugs, true, writtenState);
      vi.mocked(writeFileSync).mockClear();
      const secondPath = writeMarkdown(mockRecord, 'suffix', seenSlugs, true, writtenState);

      expect(secondPath).toBe(basePath);
      expect(writeFileSync).not.toHaveBeenCalled();
    });

    it('writes a fresh file when the tracked path is no longer a regular file (directory or symlink)', () => {
      // The base path was replaced by a directory or a symlink between passes;
      // lstat reports a non-file, so reuse is refused rather than settling the
      // record against it or following a symlink out of the vault.
      mockWriteFileSyncRejectingExistingPaths();
      const basePath = resolve(outputDirectory, 'test-title.md');
      const writtenState = new Map<string, WrittenRecordState>();

      writeMarkdown(mockRecord, 'suffix', new Map(), true, writtenState);
      vi.mocked(lstatSync).mockImplementation((path) =>
        path === basePath ? nonFileStats : undefined,
      );
      const secondPath = writeMarkdown(mockRecord, 'suffix', new Map(), true, writtenState);

      // basePath is still taken on disk, so the record lands on a real suffixed
      // file instead of being silently settled against the non-file.
      expect(secondPath).toBe(resolve(outputDirectory, 'test-title-2.md'));
    });

    it('writes a fresh file when a different regular file was dropped at the tracked path, then recovers onto it', () => {
      // Issue #124: the record's own file is deleted and an unrelated regular
      // file is dropped at the same path between passes (a new inode). Reusing it
      // would settle — and under autoDelete, delete server-side — the record
      // against a file that is not its content: silent data loss. The identity
      // mismatch must refuse reuse so the record is written fresh first.
      mockWriteFileSyncRejectingExistingPaths();
      const basePath = resolve(outputDirectory, 'test-title.md');
      const suffixedPath = resolve(outputDirectory, 'test-title-2.md');
      const writtenState = new Map<string, WrittenRecordState>();

      writeMarkdown(mockRecord, 'suffix', new Map(), true, writtenState);
      vi.mocked(writeFileSync).mockClear();
      // basePath now holds a foreign file (same device, new inode); the fresh
      // suffixed file the record lands on gets its own identity so the record can
      // be tracked and reused next pass rather than silently untracked.
      vi.mocked(lstatSync).mockImplementation((path) => {
        if (path === basePath) {
          return identityStats(1n, 4242n);
        }

        if (path === suffixedPath) {
          return identityStats(1n, 7n);
        }

        return undefined;
      });
      const secondPath = writeMarkdown(
        mockRecord,
        'suffix',
        new Map(),
        true,
        writtenState,
      );

      // The record lands on a real suffixed file (basePath is still taken on
      // disk) rather than being settled against the foreign file, its own content
      // is written out, and it is now tracked against that new file.
      expect(secondPath).toBe(suffixedPath);
      expect(writeFileSync).toHaveBeenCalledWith(
        suffixedPath,
        mockRecord.content,
        EXCLUSIVE_WRITE_OPTIONS,
      );
      expect(writtenState.get(mockRecord.uuid)?.path).toBe(suffixedPath);

      // Third pass: the suffixed file is untouched, so the record reuses it rather
      // than dropping yet another test-title-3.md duplicate.
      const thirdPath = writeMarkdown(
        mockRecord,
        'suffix',
        new Map(),
        true,
        writtenState,
      );
      expect(thirdPath).toBe(suffixedPath);
    });

    it('refuses reuse when the inode matches but the device id differs', () => {
      // Inode numbers are unique only within one filesystem. If the vault sits on
      // (or contains) a mount that is remounted, or a replacement file arrives
      // from a different device, the inode number can collide with the tracked
      // one. The device id disambiguates: the record wrote {deviceId: 1n, inode: 1n}
      // (the first assigned identity); a same-inode file on device 2 is a
      // different file, so reuse must be refused.
      mockWriteFileSyncRejectingExistingPaths();
      const basePath = resolve(outputDirectory, 'test-title.md');
      const writtenState = new Map<string, WrittenRecordState>();

      writeMarkdown(mockRecord, 'suffix', new Map(), true, writtenState);
      vi.mocked(lstatSync).mockImplementation((path) =>
        path === basePath ? identityStats(2n, 1n) : undefined,
      );
      const secondPath = writeMarkdown(
        mockRecord,
        'suffix',
        new Map(),
        true,
        writtenState,
      );

      expect(secondPath).toBe(resolve(outputDirectory, 'test-title-2.md'));
    });

    it('still reuses the file after an in-place vault edit, which moves mtime but not device or inode', () => {
      // The regression guard for the whole design: an in-place edit (vim, echo >>)
      // changes the bytes and the mtime but keeps the same device and inode. That
      // must NOT count as a different file — matching on mtime (or on birthtime,
      // which libuv aliases to the edit-moving ctime on Linux) would wrongly refuse
      // reuse and drop a suffixed duplicate every pass. The edit itself is
      // preserved by the existing content-hash check (server unchanged here, so no
      // rewrite).
      mockWriteFileSyncRejectingExistingPaths();
      const basePath = resolve(outputDirectory, 'test-title.md');
      const writtenState = new Map<string, WrittenRecordState>();

      writeMarkdown(mockRecord, 'suffix', new Map(), true, writtenState);
      vi.mocked(writeFileSync).mockClear();
      // Same device + inode as the first write (mtime is irrelevant to the check
      // and not modelled); the user edited the bytes on disk.
      vi.mocked(lstatSync).mockImplementation((path) =>
        path === basePath ? identityStats(1n, 1n) : undefined,
      );
      vi.mocked(readFileSync).mockReturnValue('user edited this in Obsidian');
      const secondPath = writeMarkdown(
        mockRecord,
        'suffix',
        new Map(),
        true,
        writtenState,
      );

      // Reused (no suffixed duplicate) and the user's edit is left untouched.
      expect(secondPath).toBe(basePath);
      expect(writeFileSync).not.toHaveBeenCalled();
    });

    it('reuses the file when its identity is unchanged between passes', () => {
      // The complement of the rejection cases: an untouched file keeps its device
      // and inode, so reuse proceeds and no suffixed duplicate is dropped.
      mockWriteFileSyncRejectingExistingPaths();
      const basePath = resolve(outputDirectory, 'test-title.md');
      const writtenState = new Map<string, WrittenRecordState>();

      const firstPath = writeMarkdown(
        mockRecord,
        'suffix',
        new Map(),
        true,
        writtenState,
      );
      const secondPath = writeMarkdown(
        mockRecord,
        'suffix',
        new Map(),
        true,
        writtenState,
      );

      expect(firstPath).toBe(basePath);
      expect(secondPath).toBe(basePath);
      expect(writeFileSync).not.toHaveBeenCalledWith(
        resolve(outputDirectory, 'test-title-2.md'),
        expect.anything(),
        expect.anything(),
      );
    });

    it('stores the on-disk identity for a written record so a later pass can verify it', () => {
      mockWriteFileSyncRejectingExistingPaths();
      const writtenState = new Map<string, WrittenRecordState>();

      writeMarkdown(mockRecord, 'suffix', new Map(), true, writtenState);

      expect(writtenState.get(mockRecord.uuid)?.identity).toEqual({
        deviceId: 1n,
        inode: 1n,
      });
    });

    it('tracks a written record without an identity when the post-write stat fails, then reuses it via the existence fallback', () => {
      // A transient stat failure right after the write (a backup/indexing tool
      // briefly holding the path, a slow mount) means the identity can't be read.
      // The record is still tracked, just without an identity, so the reuse check
      // degrades to the existing-regular-file test next pass rather than dropping
      // tracking — which would spawn a suffixed duplicate.
      mockWriteFileSyncRejectingExistingPaths();
      const basePath = resolve(outputDirectory, 'test-title.md');
      const writtenState = new Map<string, WrittenRecordState>();

      // The disk model is installed (so the base path exists as a regular file),
      // but the post-write identity read is forced to fail once.
      vi.mocked(lstatSync).mockReturnValueOnce(undefined);
      const firstPath = writeMarkdown(
        mockRecord,
        'suffix',
        new Map(),
        true,
        writtenState,
      );

      expect(firstPath).toBe(basePath);
      expect(writtenState.get(mockRecord.uuid)?.path).toBe(basePath);
      expect(writtenState.get(mockRecord.uuid)?.identity).toBeUndefined();

      // Next pass: identity is unverified, so eligibility falls back to "is the
      // tracked path still a regular file?" — it is, so the record reuses it
      // instead of dropping test-title-2.md.
      vi.mocked(writeFileSync).mockClear();
      const secondPath = writeMarkdown(
        mockRecord,
        'suffix',
        new Map(),
        true,
        writtenState,
      );

      expect(secondPath).toBe(basePath);
      expect(writeFileSync).not.toHaveBeenCalled();

      // The reuse pass re-armed the guard by adopting the now-readable identity,
      // so it no longer stays open for this record's lifetime.
      expect(writtenState.get(mockRecord.uuid)?.identity).toEqual({
        deviceId: 1n,
        inode: 1n,
      });

      // Third pass: a foreign file (new inode) is now at the tracked path. With the
      // guard re-armed, reuse is refused and the record lands on a suffixed file
      // rather than being settled against the foreign file.
      vi.mocked(lstatSync).mockImplementation((path) =>
        path === basePath ? identityStats(1n, 8888n) : undefined,
      );
      const thirdPath = writeMarkdown(
        mockRecord,
        'suffix',
        new Map(),
        true,
        writtenState,
      );

      expect(thirdPath).toBe(resolve(outputDirectory, 'test-title-2.md'));
    });

    it('refuses to settle a skip-strategy record against a foreign file at the tracked path', () => {
      // Under `skip` a foreign file now occupies the base path. Reuse is refused
      // (identity mismatch), and `skip` will not clobber an existing file, so the
      // write is a no-op (null) and the record is left unsettled — safely still
      // pending on the server — rather than deleted server-side against a file
      // that is not its content (issue #124). This is `skip`'s normal
      // occupied-slug contract, not a new stall: the record recovers once the
      // foreign file is gone.
      mockWriteFileSyncRejectingExistingPaths();
      const basePath = resolve(outputDirectory, 'test-title.md');
      const writtenState = new Map<string, WrittenRecordState>();

      writeMarkdown(mockRecord, 'skip', new Map(), true, writtenState);
      vi.mocked(rmSync).mockClear();
      vi.mocked(lstatSync).mockImplementation((path) =>
        path === basePath ? identityStats(1n, 4242n) : undefined,
      );
      const secondPath = writeMarkdown(
        mockRecord,
        'skip',
        new Map(),
        true,
        writtenState,
      );

      // No path returned, so the caller does not settle the record; the foreign
      // file is left untouched — `skip` only ever attempts an exclusive create
      // (which fails EEXIST on the taken path) and never unlinks, so `rmSync` is
      // not called.
      expect(secondPath).toBeNull();
      expect(rmSync).not.toHaveBeenCalled();

      // Recovery: the user removes the foreign file, freeing the path. Next pass
      // the record writes fresh there and is tracked again — proving the refusal
      // was a transient occupied-slot skip, not a permanent stall.
      rmSync(basePath, { force: true });
      vi.mocked(lstatSync).mockReturnValue(undefined);
      const thirdPath = writeMarkdown(
        mockRecord,
        'skip',
        new Map(),
        true,
        writtenState,
      );

      expect(thirdPath).toBe(basePath);
      expect(writtenState.get(mockRecord.uuid)?.path).toBe(basePath);
    });

    it('clobbers a foreign file at the tracked path under the overwrite strategy, persisting the record', () => {
      // `overwrite` opts into the newest record winning the path. Reuse is refused
      // by the identity mismatch, but the fresh overwrite write still lands on the
      // base path and replaces the foreign file with the record's own content, so
      // the record is persisted before it settles — no data loss, consistent with
      // the strategy the user chose.
      mockWriteFileSyncRejectingExistingPaths();
      const basePath = resolve(outputDirectory, 'test-title.md');
      const writtenState = new Map<string, WrittenRecordState>();

      writeMarkdown(mockRecord, 'overwrite', new Map(), true, writtenState);
      vi.mocked(writeFileSync).mockClear();
      vi.mocked(lstatSync).mockImplementation((path) =>
        path === basePath ? identityStats(1n, 4242n) : undefined,
      );
      const secondPath = writeMarkdown(
        mockRecord,
        'overwrite',
        new Map(),
        true,
        writtenState,
      );

      expect(secondPath).toBe(basePath);
      expect(writeFileSync).toHaveBeenLastCalledWith(
        basePath,
        mockRecord.content,
        EXCLUSIVE_WRITE_OPTIONS,
      );
    });

    it('falls through to a fresh write when a different record claimed the tracked path after this record\'s file moved', () => {
      // A's file is moved out of the vault; next pass a different same-slug
      // record B claims the freed base path first. A's reuse must NOT overwrite
      // B (both are deleted server-side, so a clobber loses B everywhere).
      mockWriteFileSyncRejectingExistingPaths();
      const basePath = resolve(outputDirectory, 'test-title.md');
      const seenSlugs = new Map<string, string>();
      const writtenState = new Map<string, WrittenRecordState>();
      const recordA: Record = { ...mockRecord, uuid: 'a', title: 'Test Title' };
      const recordB: Record = { ...mockRecord, uuid: 'b', title: 'Test Title', content: 'B content' };

      writeMarkdown(recordA, 'suffix', seenSlugs, true, writtenState); // test-title.md
      rmSync(basePath, { force: true }); // user moves A's file out of the vault
      const bPath = writeMarkdown(recordB, 'suffix', seenSlugs, true, writtenState);
      const aRetryPath = writeMarkdown(recordA, 'suffix', seenSlugs, true, writtenState);

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
      const writtenState = new Map<string, WrittenRecordState>();
      const recordA: Record = { ...mockRecord, uuid: 'a', title: 'Test Title' };
      const recordB: Record = { ...mockRecord, uuid: 'b', title: 'Test Title' };
      const recordC: Record = { ...mockRecord, uuid: 'c', title: 'Test Title', content: 'C content' };

      writeMarkdown(recordA, 'suffix', seenSlugs, true, writtenState); // test-title.md
      writeMarkdown(recordB, 'suffix', seenSlugs, true, writtenState); // test-title-2.md
      rmSync(suffixedPath, { force: true }); // user deletes B's file from the vault
      const cPath = writeMarkdown(recordC, 'suffix', seenSlugs, true, writtenState);
      const bRetryPath = writeMarkdown(recordB, 'suffix', seenSlugs, true, writtenState);

      expect(cPath).toBe(suffixedPath);
      // B takes the next free suffix rather than reusing C's file.
      expect(bRetryPath).toBe(resolve(outputDirectory, 'test-title-3.md'));
    });

    it('writes into the current output directory when it changed between passes, not the tracked old one', () => {
      const newDirectory = '/mock/output-2';
      mockWriteFileSyncRejectingExistingPaths();
      const oldBasePath = resolve(outputDirectory, 'test-title.md');
      const newBasePath = resolve(newDirectory, 'test-title.md');
      const writtenState = new Map<string, WrittenRecordState>();
      // The old file is still a regular file on the simulated disk, so a naive
      // uuid-only reuse would target it; the directory guard must reject it.

      writeMarkdown(mockRecord, 'suffix', new Map(), true, writtenState);
      process.env.OUTPUT_DIRECTORY = newDirectory; // user changes the setting
      const secondPath = writeMarkdown(mockRecord, 'suffix', new Map(), true, writtenState);

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
      const writtenState = new Map<string, WrittenRecordState>();

      writeMarkdown(mockRecord, 'overwrite', seenSlugs, true, writtenState);
      const passOneHash = writtenState.get(mockRecord.uuid)?.contentHash;
      const updatedRecord: Record = { ...mockRecord, content: 'Updated body' };
      writeMarkdown(updatedRecord, 'overwrite', seenSlugs, true, writtenState);

      expect(writeFileSync).toHaveBeenLastCalledWith(
        basePath,
        'Updated body',
        EXCLUSIVE_WRITE_OPTIONS,
      );
      // The overwrite reuse also refreshes the stored hash, so a later pass
      // compares against the content it just wrote, not the original.
      expect(writtenState.get(mockRecord.uuid)?.contentHash).not.toBe(
        passOneHash,
      );
    });

    it('writes a fresh file when the tracked file was moved or deleted between passes', () => {
      mockWriteFileSyncRejectingExistingPaths();
      const basePath = resolve(outputDirectory, 'test-title.md');
      const writtenState = new Map<string, WrittenRecordState>();

      const firstPath = writeMarkdown(mockRecord, 'suffix', new Map(), true, writtenState);
      // The user moves the file out of the vault: existsSync stays false (the
      // beforeEach default) and the disk model no longer holds the base path.
      rmSync(basePath, { force: true });
      const secondPath = writeMarkdown(mockRecord, 'suffix', new Map(), true, writtenState);

      // The stale tracked entry is ignored, so the record recreates its file at
      // the now-free base path rather than being pushed to a suffix.
      expect(firstPath).toBe(basePath);
      expect(secondPath).toBe(basePath);
    });

    it('records the written path per uuid so the orchestrator can carry it across passes', () => {
      const writtenState = new Map<string, WrittenRecordState>();

      writeMarkdown(mockRecord, 'suffix', new Map(), true, writtenState);

      expect(writtenState.get(mockRecord.uuid)?.path).toBe(
        resolve(outputDirectory, 'test-title.md'),
      );
    });

    it('never tracks or reuses a record with an empty uuid', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const writtenState = new Map<string, WrittenRecordState>();
      const noUuidRecord: Record = { ...mockRecord, uuid: '' };

      writeMarkdown(noUuidRecord, 'suffix', new Map(), true, writtenState);

      expect(writtenState.size).toBe(0);
    });

    it('reuses a skip-strategy file without rewriting it, so a vault edit between passes survives', () => {
      mockWriteFileSyncRejectingExistingPaths();
      const basePath = resolve(outputDirectory, 'test-title.md');
      const writtenState = new Map<string, WrittenRecordState>();

      // Pass one writes the file (absent), tracking it.
      const firstPath = writeMarkdown(mockRecord, 'skip', new Map(), true, writtenState);
      vi.mocked(writeFileSync).mockClear();
      // Pass two: the record is still unsettled and re-fetched. Under `skip` the
      // reused file must not be rewritten (the user may have edited it), but the
      // path still returns so the record can settle rather than loop pending.
      const secondPath = writeMarkdown(mockRecord, 'skip', new Map(), true, writtenState);

      expect(firstPath).toBe(basePath);
      expect(secondPath).toBe(basePath);
      expect(writeFileSync).not.toHaveBeenCalled();
    });

    it('does not track a skip-strategy no-op (null write) for reuse', () => {
      mockWriteFileSyncRejectingExistingPaths([
        resolve(outputDirectory, 'test-title.md'),
      ]);
      const writtenState = new Map<string, WrittenRecordState>();

      expect(writeMarkdown(mockRecord, 'skip', new Map(), true, writtenState)).toBeNull();
      expect(writtenState.has(mockRecord.uuid)).toBe(false);
    });

    it('re-fetches a suffix-strategy file when the server content changed and the local file is untouched', () => {
      // Issue #102: a record edited server-side between passes must not be
      // settled against pass-one content — the reused file is rewritten with the
      // new version instead of silently stranding it.
      mockWriteFileSyncRejectingExistingPaths();
      const basePath = resolve(outputDirectory, 'test-title.md');
      const writtenState = new Map<string, WrittenRecordState>();

      // Pass one writes the original content, storing its hash as the baseline.
      writeMarkdown(mockRecord, 'suffix', new Map(), true, writtenState);
      // The file on disk is still exactly what pass one wrote (untouched).
      vi.mocked(readFileSync).mockReturnValue(mockRecord.content);
      vi.mocked(writeFileSync).mockClear();

      // Pass two: the same record re-fetched, but its content changed on the server.
      const updatedRecord: Record = {
        ...mockRecord,
        content: 'Server-updated body',
      };
      const secondPath = writeMarkdown(
        updatedRecord,
        'suffix',
        new Map(),
        true,
        writtenState,
      );

      expect(secondPath).toBe(basePath);
      expect(writeFileSync).toHaveBeenLastCalledWith(
        basePath,
        'Server-updated body',
        EXCLUSIVE_WRITE_OPTIONS,
      );
    });

    it('re-fetches a skip-strategy file when the server content changed and the local file is untouched', () => {
      mockWriteFileSyncRejectingExistingPaths();
      const basePath = resolve(outputDirectory, 'test-title.md');
      const writtenState = new Map<string, WrittenRecordState>();

      writeMarkdown(mockRecord, 'skip', new Map(), true, writtenState);
      vi.mocked(readFileSync).mockReturnValue(mockRecord.content);
      vi.mocked(writeFileSync).mockClear();

      const updatedRecord: Record = {
        ...mockRecord,
        content: 'Server-updated body',
      };
      const secondPath = writeMarkdown(
        updatedRecord,
        'skip',
        new Map(),
        true,
        writtenState,
      );

      expect(secondPath).toBe(basePath);
      expect(writeFileSync).toHaveBeenLastCalledWith(
        basePath,
        'Server-updated body',
        EXCLUSIVE_WRITE_OPTIONS,
      );
    });

    it('refreshes the stored content hash on a re-fetch so a later pass compares against the new baseline', () => {
      // After a reuse rewrite the baseline must track what is now on disk;
      // a stale pass-one baseline would suppress the next genuine server change.
      mockWriteFileSyncRejectingExistingPaths();
      const basePath = resolve(outputDirectory, 'test-title.md');
      const writtenState = new Map<string, WrittenRecordState>();

      writeMarkdown(mockRecord, 'suffix', new Map(), true, writtenState);
      const passOneHash = writtenState.get(mockRecord.uuid)?.contentHash;

      // Pass two rewrites with the new server content; the disk was untouched.
      vi.mocked(readFileSync).mockReturnValue(mockRecord.content);
      const passTwoRecord: Record = { ...mockRecord, content: 'Server body two' };
      writeMarkdown(passTwoRecord, 'suffix', new Map(), true, writtenState);

      // The baseline now reflects what pass two wrote, not the original content.
      expect(writtenState.get(mockRecord.uuid)?.contentHash).not.toBe(
        passOneHash,
      );

      // Pass three: a third server change, with the disk still holding pass two's
      // content (untouched since). The rewrite must fire against the refreshed
      // baseline — a stale pass-one baseline would leave the disk not matching it
      // and wrongly suppress the write.
      vi.mocked(readFileSync).mockReturnValue('Server body two');
      vi.mocked(writeFileSync).mockClear();
      const passThreeRecord: Record = {
        ...mockRecord,
        content: 'Server body three',
      };
      writeMarkdown(passThreeRecord, 'suffix', new Map(), true, writtenState);

      expect(writeFileSync).toHaveBeenLastCalledWith(
        basePath,
        'Server body three',
        EXCLUSIVE_WRITE_OPTIONS,
      );
    });

    it('detects a body-only server change on a frontmatter record, hashing the assembled document', () => {
      // Real synced records carry frontmatter, so the on-disk bytes are the full
      // assembled document (block + heading + body), not the raw content. The
      // baseline must hash those same bytes; an implementation that hashed
      // record.content instead would miss a body-only change here.
      mockWriteFileSyncRejectingExistingPaths();
      const basePath = resolve(outputDirectory, 'deploy.md');
      const writtenState = new Map<string, WrittenRecordState>();
      const syncedRecord: Record = {
        ...mockRecord,
        title: 'Deploy',
        content: 'Original body.',
        frontmatter: {
          title: 'Deploy',
          source: 'webhook/github',
          created: '2026-06-14T09:41:02Z',
          tags: ['ci'],
        },
      };

      writeMarkdown(syncedRecord, 'suffix', new Map(), true, writtenState);
      // The disk holds exactly the assembled document pass one wrote (untouched).
      const [, assembledDocument] = vi.mocked(writeFileSync).mock.calls[0];
      vi.mocked(readFileSync).mockReturnValue(assembledDocument as string);
      vi.mocked(writeFileSync).mockClear();

      const updatedRecord: Record = { ...syncedRecord, content: 'Updated body.' };
      writeMarkdown(updatedRecord, 'suffix', new Map(), true, writtenState);

      const [writtenPath, rewrittenDocument] =
        vi.mocked(writeFileSync).mock.lastCall ?? [];
      expect(writtenPath).toBe(basePath);
      expect(rewrittenDocument).toContain('Updated body.');
      expect(rewrittenDocument).toContain('title: Deploy');
    });

    it('preserves a suffix-strategy file the user edited in the vault even when the server content also changed', () => {
      // A genuine local edit still wins over a server change: the "don't clobber"
      // intent of suffix/skip is preserved.
      mockWriteFileSyncRejectingExistingPaths();
      const writtenState = new Map<string, WrittenRecordState>();

      writeMarkdown(mockRecord, 'suffix', new Map(), true, writtenState);
      // The user edited the file, so its bytes no longer match the baseline.
      vi.mocked(readFileSync).mockReturnValue('Edited in the vault');
      vi.mocked(writeFileSync).mockClear();

      const updatedRecord: Record = {
        ...mockRecord,
        content: 'Server-updated body',
      };
      writeMarkdown(updatedRecord, 'suffix', new Map(), true, writtenState);

      expect(writeFileSync).not.toHaveBeenCalled();
    });

    it('records a dropped server change when a suffix reuse keeps a locally edited file over a changed server revision', () => {
      // The vault edit wins, so the changed server revision is dropped — the uuid
      // is collected so the caller can warn and defer the server-side delete
      // (issue #110).
      mockWriteFileSyncRejectingExistingPaths();
      const writtenState = new Map<string, WrittenRecordState>();
      const droppedServerChanges = new Set<string>();

      writeMarkdown(mockRecord, 'suffix', new Map(), true, writtenState);
      vi.mocked(readFileSync).mockReturnValue('Edited in the vault');

      const updatedRecord: Record = {
        ...mockRecord,
        content: 'Server-updated body',
      };
      writeMarkdown(
        updatedRecord,
        'suffix',
        new Map(),
        true,
        writtenState,
        droppedServerChanges,
      );

      expect(droppedServerChanges.has(mockRecord.uuid)).toBe(true);
    });

    it('records a dropped server change under the skip strategy too', () => {
      mockWriteFileSyncRejectingExistingPaths();
      const writtenState = new Map<string, WrittenRecordState>();
      const droppedServerChanges = new Set<string>();

      writeMarkdown(mockRecord, 'skip', new Map(), true, writtenState);
      vi.mocked(readFileSync).mockReturnValue('Edited in the vault');

      const updatedRecord: Record = {
        ...mockRecord,
        content: 'Server-updated body',
      };
      writeMarkdown(
        updatedRecord,
        'skip',
        new Map(),
        true,
        writtenState,
        droppedServerChanges,
      );

      expect(droppedServerChanges.has(mockRecord.uuid)).toBe(true);
    });

    it('does not record a dropped server change when the server content is unchanged', () => {
      mockWriteFileSyncRejectingExistingPaths();
      const writtenState = new Map<string, WrittenRecordState>();
      const droppedServerChanges = new Set<string>();

      writeMarkdown(mockRecord, 'suffix', new Map(), true, writtenState);
      // The user edited the file, but the server content did not change — a local
      // edit alone is not a dropped server revision.
      vi.mocked(readFileSync).mockReturnValue('Edited in the vault');

      writeMarkdown(
        mockRecord,
        'suffix',
        new Map(),
        true,
        writtenState,
        droppedServerChanges,
      );

      expect(droppedServerChanges.size).toBe(0);
    });

    it('does not record a dropped server change when the local file is untouched (the reuse refreshes instead)', () => {
      mockWriteFileSyncRejectingExistingPaths();
      const writtenState = new Map<string, WrittenRecordState>();
      const droppedServerChanges = new Set<string>();

      writeMarkdown(mockRecord, 'suffix', new Map(), true, writtenState);
      // The disk still holds exactly what pass one wrote, so the reuse refreshes
      // it with the new server content rather than dropping anything.
      const [, assembledDocument] = vi.mocked(writeFileSync).mock.calls[0];
      vi.mocked(readFileSync).mockReturnValue(assembledDocument as string);

      const updatedRecord: Record = {
        ...mockRecord,
        content: 'Server-updated body',
      };
      writeMarkdown(
        updatedRecord,
        'suffix',
        new Map(),
        true,
        writtenState,
        droppedServerChanges,
      );

      expect(droppedServerChanges.size).toBe(0);
    });

    it('does not record a dropped server change under the overwrite strategy', () => {
      // overwrite always refreshes to the newest server content, so nothing is
      // ever dropped for it to warn about.
      mockWriteFileSyncRejectingExistingPaths();
      const writtenState = new Map<string, WrittenRecordState>();
      const droppedServerChanges = new Set<string>();

      writeMarkdown(mockRecord, 'overwrite', new Map(), true, writtenState);
      vi.mocked(readFileSync).mockReturnValue('Edited in the vault');

      const updatedRecord: Record = {
        ...mockRecord,
        content: 'Server-updated body',
      };
      writeMarkdown(
        updatedRecord,
        'overwrite',
        new Map(),
        true,
        writtenState,
        droppedServerChanges,
      );

      expect(droppedServerChanges.size).toBe(0);
    });

    it('does not rewrite a reused suffix file when the server content is unchanged', () => {
      mockWriteFileSyncRejectingExistingPaths();
      const writtenState = new Map<string, WrittenRecordState>();

      writeMarkdown(mockRecord, 'suffix', new Map(), true, writtenState);
      vi.mocked(readFileSync).mockReturnValue(mockRecord.content);
      vi.mocked(writeFileSync).mockClear();

      // Same record, same content — nothing changed on the server.
      writeMarkdown(mockRecord, 'suffix', new Map(), true, writtenState);

      expect(writeFileSync).not.toHaveBeenCalled();
    });

    it('leaves a reused suffix file untouched when the server changed but the on-disk file cannot be read', () => {
      // An unreadable file can't be confirmed as our own untouched output, so the
      // reuse leaves it alone rather than clobbering it.
      mockWriteFileSyncRejectingExistingPaths();
      const writtenState = new Map<string, WrittenRecordState>();

      writeMarkdown(mockRecord, 'suffix', new Map(), true, writtenState);
      vi.mocked(readFileSync).mockImplementation(() => {
        throw new Error('EACCES');
      });
      vi.mocked(writeFileSync).mockClear();

      const updatedRecord: Record = {
        ...mockRecord,
        content: 'Server-updated body',
      };
      writeMarkdown(updatedRecord, 'suffix', new Map(), true, writtenState);

      expect(writeFileSync).not.toHaveBeenCalled();
    });

    it('propagates a failed refresh write, then recreates the file fresh next pass', () => {
      // A refresh unlinks then exclusively recreates; if the recreate throws the
      // file is briefly gone, but the record recovers next pass by writing fresh.
      mockWriteFileSyncRejectingExistingPaths();
      const basePath = resolve(outputDirectory, 'test-title.md');
      const writtenState = new Map<string, WrittenRecordState>();

      writeMarkdown(mockRecord, 'suffix', new Map(), true, writtenState);
      vi.mocked(readFileSync).mockReturnValue(mockRecord.content);

      const updatedRecord: Record = {
        ...mockRecord,
        content: 'Server-updated body',
      };
      // The refresh's recreate throws, and rmSync has already removed the file.
      const writeError = new Error('EACCES');
      vi.mocked(writeFileSync).mockImplementationOnce(() => {
        throw writeError;
      });
      expect(() =>
        writeMarkdown(updatedRecord, 'suffix', new Map(), true, writtenState),
      ).toThrow(writeError);

      // Next pass: the tracked path is now missing (rmSync removed it and the
      // recreate failed), so reuse is rejected and the record writes fresh at the
      // base path rather than reusing a deleted file.
      vi.mocked(lstatSync).mockReturnValue(undefined);
      const recoveredPath = writeMarkdown(
        updatedRecord,
        'suffix',
        new Map(),
        true,
        writtenState,
      );

      expect(recoveredPath).toBe(basePath);
    });

    it('refreshes content into the pass-one filename when only the title changed server-side', () => {
      // Reuse is keyed by uuid, so a title change rewrites the new content
      // (heading + frontmatter) into the original file rather than renaming it to
      // the new slug — the existing "keep the original filename" reuse design.
      mockWriteFileSyncRejectingExistingPaths();
      const basePath = resolve(outputDirectory, 'deploy.md');
      const writtenState = new Map<string, WrittenRecordState>();
      const syncedRecord: Record = {
        ...mockRecord,
        title: 'Deploy',
        content: 'Shared body.',
        frontmatter: {
          title: 'Deploy',
          source: 'webhook/github',
          created: '2026-06-14T09:41:02Z',
          tags: ['ci'],
        },
      };

      writeMarkdown(syncedRecord, 'suffix', new Map(), true, writtenState);
      const [, assembledDocument] = vi.mocked(writeFileSync).mock.calls[0];
      vi.mocked(readFileSync).mockReturnValue(assembledDocument as string);
      vi.mocked(writeFileSync).mockClear();

      // Only the title changed server-side; the body is identical.
      const retitledRecord: Record = {
        ...syncedRecord,
        title: 'Rollback',
        frontmatter: { ...syncedRecord.frontmatter!, title: 'Rollback' },
      };
      const secondPath = writeMarkdown(
        retitledRecord,
        'suffix',
        new Map(),
        true,
        writtenState,
      );

      const [writtenPath, rewrittenDocument] =
        vi.mocked(writeFileSync).mock.lastCall ?? [];
      // The file keeps its pass-one name but now carries the new title.
      expect(secondPath).toBe(basePath);
      expect(writtenPath).toBe(basePath);
      expect(rewrittenDocument).toContain('title: Rollback');
      expect(rewrittenDocument).toContain('# Rollback');
    });

    it('treats a non-string readFileSync result as unreadable and does not refresh', () => {
      // readFileSync(path, 'utf-8') always yields a string in production, but a
      // non-string must be treated as unreadable rather than reaching hashContent.
      mockWriteFileSyncRejectingExistingPaths();
      const writtenState = new Map<string, WrittenRecordState>();

      writeMarkdown(mockRecord, 'suffix', new Map(), true, writtenState);
      vi.mocked(readFileSync).mockReturnValue(
        undefined as unknown as string,
      );
      vi.mocked(writeFileSync).mockClear();

      const updatedRecord: Record = {
        ...mockRecord,
        content: 'Server-updated body',
      };
      writeMarkdown(updatedRecord, 'suffix', new Map(), true, writtenState);

      expect(writeFileSync).not.toHaveBeenCalled();
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

describe('buildWritePreview', () => {
  const secondRecord: Record = { uuid: 'def-456', title: 'Test Title', content: 'Second body', createdAt: '2024-01-02T00:00:00Z' };

  beforeEach(() => {
    process.env.OUTPUT_DIRECTORY = outputDirectory;
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(writeFileSync).mockReset();
    vi.mocked(rmSync).mockReset();
    vi.mocked(mkdirSync).mockReset();
    vi.mocked(slugify).mockImplementation(actualSlugify);
    vi.mocked(config.get).mockReturnValue(undefined);
  });

  afterEach(() => {
    delete process.env.OUTPUT_DIRECTORY;
    vi.clearAllMocks();
  });

  it('throws when the output directory is not set', () => {
    delete process.env.OUTPUT_DIRECTORY;
    expect(() => buildWritePreview([mockRecord])).toThrow(
      'Output directory is not set!',
    );
  });

  // The whole point of a dry run: planning the write must touch nothing on disk.
  it('writes, removes, and creates nothing on disk', () => {
    buildWritePreview([mockRecord, secondRecord], 'suffix');

    expect(writeFileSync).not.toHaveBeenCalled();
    expect(rmSync).not.toHaveBeenCalled();
    expect(mkdirSync).not.toHaveBeenCalled();
  });

  it('reports a fresh write at the base path when nothing exists', () => {
    const [preview] = buildWritePreview([mockRecord], 'suffix');

    expect(preview).toEqual({
      record: mockRecord,
      path: resolve(outputDirectory, 'test-title.md'),
      action: 'write',
    });
  });

  // The dry-run seam must expand the home reference too, so the previewed path
  // matches where a real sync would write instead of a literal `~/` folder.
  it('expands a leading ~ in the previewed output directory', () => {
    process.env.OUTPUT_DIRECTORY = '~/notes';

    const [preview] = buildWritePreview([mockRecord], 'suffix');

    expect(preview.path).toBe(resolve(homedir(), 'notes', 'test-title.md'));
  });

  // Two records slugging to the same base must preview distinct suffixed
  // targets, exactly as the suffix strategy would land them.
  it('suffixes a within-batch collision without touching disk', () => {
    const previews = buildWritePreview([mockRecord, secondRecord], 'suffix');

    expect(previews.map((preview) => preview.path)).toEqual([
      resolve(outputDirectory, 'test-title.md'),
      resolve(outputDirectory, 'test-title-2.md'),
    ]);
    expect(previews.every((preview) => preview.action === 'write')).toBe(true);
  });

  it('walks past existing files on disk for the suffix strategy', () => {
    const basePath = resolve(outputDirectory, 'test-title.md');
    vi.mocked(existsSync).mockImplementation((path) => path === basePath);

    const [preview] = buildWritePreview([mockRecord], 'suffix');

    expect(preview.path).toBe(resolve(outputDirectory, 'test-title-2.md'));
    expect(preview.action).toBe('write');
  });

  it('reports an overwrite when the base file already exists', () => {
    const basePath = resolve(outputDirectory, 'test-title.md');
    vi.mocked(existsSync).mockImplementation((path) => path === basePath);

    const [preview] = buildWritePreview([mockRecord], 'overwrite');

    expect(preview).toEqual({
      record: mockRecord,
      path: basePath,
      action: 'overwrite',
    });
  });

  // A second same-slug record can't overwrite the file the first one already
  // claims this batch, so it downgrades to suffix — mirroring
  // resolveStrategyForSlug in the real writer.
  it('downgrades a same-slug overwrite collision to a suffixed write', () => {
    const previews = buildWritePreview([mockRecord, secondRecord], 'overwrite');

    expect(previews[0].path).toBe(resolve(outputDirectory, 'test-title.md'));
    expect(previews[1]).toEqual({
      record: secondRecord,
      path: resolve(outputDirectory, 'test-title-2.md'),
      action: 'write',
    });
  });

  it('reports a skip when the skip strategy finds an existing file', () => {
    const basePath = resolve(outputDirectory, 'test-title.md');
    vi.mocked(existsSync).mockImplementation((path) => path === basePath);

    const [preview] = buildWritePreview([mockRecord], 'skip');

    expect(preview).toEqual({
      record: mockRecord,
      path: basePath,
      action: 'skip',
    });
  });

  it('reports a fresh write for the skip strategy when nothing exists', () => {
    const [preview] = buildWritePreview([mockRecord], 'skip');

    expect(preview.action).toBe('write');
    expect(preview.path).toBe(resolve(outputDirectory, 'test-title.md'));
  });
});
