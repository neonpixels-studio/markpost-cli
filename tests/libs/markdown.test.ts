import {
  existsSync,
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
};

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  rmSync: vi.fn(),
}));

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
