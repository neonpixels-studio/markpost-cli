import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Spinner } from 'yocto-spinner';

import { Record } from '@/types/records.types.js';
import { UserSettings, ConflictStrategy } from '@/types/settings.types.js';
import { SettingsReadResult } from '@/libs/settings.js';
import {
  MARK_ABORTED,
  MARK_FAILED,
  MARK_SYNCED,
  MARK_TIMED_OUT,
  MarkSyncedOutcome,
  MarkSyncedResult,
} from '@/libs/records.js';
import type { WrittenRecordState } from '@/libs/markdown.js';

vi.mock('@/libs/config.js', () => ({
  checkConfig: vi.fn().mockResolvedValue(true),
}));
// Keep the real module's exports (notably the MARK_* outcome constants and
// PENDING_STATUS) so the tests compare against the same literals production
// code does; only the network-touching functions are stubbed.
vi.mock('@/libs/records.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/libs/records.js')>()),
  fetchAllRecords: vi.fn(),
  deleteRecords: vi.fn(),
  markRecordsSynced: vi.fn(),
}));
vi.mock('@/libs/markdown.js', () => ({
  writeMarkdown: vi.fn(),
  ensureOutputDirectory: vi.fn(),
  buildWritePreview: vi.fn(),
}));
vi.mock('@/libs/settings.js', () => ({ fetchSettings: vi.fn() }));
// Run the sync once synchronously instead of arming a real timer: the
// scheduling decision itself is covered in tests/libs/scheduler.test.ts.
vi.mock('@/libs/scheduler.js', () => ({
  runSyncWithAutoSchedule: vi.fn(async (runSync: () => Promise<boolean>) => {
    await runSync();
  }),
}));
vi.mock('@/commands/push.js', () => ({
  runPushCommand: vi.fn(),
  USAGE: 'Usage: markpost push <path...>',
}));
vi.mock('@/commands/get.js', () => ({
  runGetCommand: vi.fn(),
  USAGE: 'Usage: markpost get <uuid>',
}));
vi.mock('@/commands/sources.js', () => ({
  runSourcesCommand: vi.fn(),
  USAGE: 'Usage: markpost sources <list|create|update|delete> [uuid]',
}));
vi.mock('@/commands/records.js', () => ({
  runRecordsCommand: vi.fn(),
  USAGE: 'Usage: markpost records <list>',
}));
vi.mock('@/commands/config.js', () => ({
  runConfigCommand: vi.fn(),
  USAGE: 'Usage: markpost config <get|set|path> [key] [value]',
}));
vi.mock('yocto-spinner', () => ({ default: vi.fn() }));
vi.mock('cli-spinners', () => ({ default: { dots: {} } }));
vi.mock('chalk', () => ({
  default: {
    redBright: vi.fn((s: unknown) => s),
    dim: vi.fn((s: unknown) => s),
    yellow: vi.fn((s: unknown) => s),
  },
}));

const mockRecord: Record = {
  uuid: 'abc-123',
  title: 'Test Title',
  content: 'Test Content',
  createdAt: '2024-01-01T00:00:00Z',
};

// The bulk mark-synced call resolves one outcome per input record in order.
// These build that `MarkSyncedResult` for the mocked `markRecordsSynced` so
// index-level tests drive the settle/report logic without re-deriving chunking
// (chunk boundaries and the timeout abort are covered in tests/libs/records.test.ts).
// `markResultBy` maps each item's uuid to an outcome; `markResultAll` is the
// common "every record shares one outcome" shorthand. Both always report every
// record attempted (`stoppedBy: null`, full-length outcomes) — an abort produces
// a SHORTER outcomes array, so timeout/abort cases use an explicit
// `mockResolvedValue({ outcomes: [...], stoppedBy: MARK_TIMED_OUT })` instead.
const markResultBy =
  (outcomeFor: (uuid: string) => MarkSyncedOutcome) =>
  async (
    items: { uuid: string; filePath: string }[],
  ): Promise<MarkSyncedResult> => ({
    outcomes: items.map((item) => outcomeFor(item.uuid)),
    stoppedBy: null,
  });

const markResultAll = (outcome: MarkSyncedOutcome) =>
  markResultBy(() => outcome);

describe('index', () => {
  // The production code only calls start/success/error on the spinner, so the
  // mock implements just those three. Typed as the full Spinner it satisfies
  // yoctoSpinner's mocked return type without stubbing methods nothing calls.
  let mockSpinner: Spinner;
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockSpinner = { start: vi.fn(), success: vi.fn(), error: vi.fn() } as unknown as Spinner;
    // The sync now runs only under the explicit `sync` subcommand, so the
    // default-sync tests below invoke it that way. Dispatch, help, and
    // no-arg tests override process.argv themselves.
    process.argv = ['node', 'index.js', 'sync'];
    process.exitCode = undefined;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = undefined;
    vi.restoreAllMocks();
    process.argv = originalArgv;
  });

  it('dispatches to runSourcesCommand and skips the sync flow when the "sources" command is given', async () => {
    process.argv = [...originalArgv.slice(0, 2), 'sources', 'list'];
    const { runSourcesCommand } = await import('@/commands/sources.js');
    const { fetchAllRecords } = await import('@/libs/records.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');
    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);

    await import('@/index.js');

    expect(runSourcesCommand).toHaveBeenCalledWith(['list']);
    expect(fetchAllRecords).not.toHaveBeenCalled();
    expect(mockSpinner.start).not.toHaveBeenCalled();
  });

  // The command modules now treat an unknown subcommand as a usage error
  // (stderr, exit 1). This pins the invariant their comments rely on: a
  // subcommand-position help flag is intercepted here and never reaches the
  // handler, so it still prints usage to stdout and exits 0.
  it.each(['--help', '-h'])(
    'prints a subcommand group\'s usage and exits 0 for "sources %s" without invoking the handler',
    async (helpFlag) => {
      process.argv = [...originalArgv.slice(0, 2), 'sources', helpFlag];
      const { runSourcesCommand } = await import('@/commands/sources.js');

      await import('@/index.js');

      expect(runSourcesCommand).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Usage: markpost sources'),
      );
      expect(process.exitCode).toBeUndefined();
    },
  );

  it('dispatches to runRecordsCommand and skips the sync flow when the "records" command is given', async () => {
    process.argv = [...originalArgv.slice(0, 2), 'records', 'list'];
    const { runRecordsCommand } = await import('@/commands/records.js');
    const { fetchAllRecords, deleteRecords } = await import(
      '@/libs/records.js'
    );
    const { default: yoctoSpinner } = await import('yocto-spinner');
    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);

    await import('@/index.js');

    expect(runRecordsCommand).toHaveBeenCalledWith(['list']);
    expect(fetchAllRecords).not.toHaveBeenCalled();
    expect(deleteRecords).not.toHaveBeenCalled();
    expect(mockSpinner.start).not.toHaveBeenCalled();
  });

  it('dispatches to runPushCommand and skips the default sync when the push command is given', async () => {
    process.argv = ['node', 'index.js', 'push', './notes/test.md'];
    const { runPushCommand } = await import('@/commands/push.js');
    const { fetchAllRecords } = await import('@/libs/records.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    await import('@/index.js');

    expect(runPushCommand).toHaveBeenCalledWith(['./notes/test.md']);
    expect(fetchAllRecords).not.toHaveBeenCalled();
    expect(yoctoSpinner).not.toHaveBeenCalled();
  });

  it('dispatches to runGetCommand and skips the default sync when the get command is given', async () => {
    process.argv = ['node', 'index.js', 'get', 'abc-123'];
    const { runGetCommand } = await import('@/commands/get.js');
    const { fetchAllRecords } = await import('@/libs/records.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    await import('@/index.js');

    expect(runGetCommand).toHaveBeenCalledWith(['abc-123']);
    expect(fetchAllRecords).not.toHaveBeenCalled();
    expect(yoctoSpinner).not.toHaveBeenCalled();
  });

  it('errors out on an unrecognized command instead of falling through to the default sync', async () => {
    process.argv = ['node', 'index.js', 'puhs', 'file.md'];
    const { runPushCommand } = await import('@/commands/push.js');
    const { runGetCommand } = await import('@/commands/get.js');
    const { runSourcesCommand } = await import('@/commands/sources.js');
    const { runRecordsCommand } = await import('@/commands/records.js');
    const { fetchAllRecords, deleteRecords } = await import('@/libs/records.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    await import('@/index.js');

    expect(runPushCommand).not.toHaveBeenCalled();
    expect(runGetCommand).not.toHaveBeenCalled();
    expect(runSourcesCommand).not.toHaveBeenCalled();
    expect(runRecordsCommand).not.toHaveBeenCalled();
    expect(fetchAllRecords).not.toHaveBeenCalled();
    expect(deleteRecords).not.toHaveBeenCalled();
    expect(yoctoSpinner).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Unknown command: puhs'),
    );
    expect(process.exitCode).toBe(1);
  });

  it.each(['toString', 'constructor', 'hasOwnProperty', '__proto__'])(
    'treats "%s" as an unknown command rather than resolving it off Object.prototype',
    async (command) => {
      process.argv = ['node', 'index.js', command];
      const { runPushCommand } = await import('@/commands/push.js');
      const { runGetCommand } = await import('@/commands/get.js');
      const { runSourcesCommand } = await import('@/commands/sources.js');
      const { runRecordsCommand } = await import('@/commands/records.js');
      const { fetchAllRecords } = await import('@/libs/records.js');

      await import('@/index.js');

      expect(runPushCommand).not.toHaveBeenCalled();
      expect(runGetCommand).not.toHaveBeenCalled();
      expect(runSourcesCommand).not.toHaveBeenCalled();
      expect(runRecordsCommand).not.toHaveBeenCalled();
      expect(fetchAllRecords).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining(`Unknown command: ${command}`),
      );
      expect(process.exitCode).toBe(1);
    },
  );

  it.each(['--help', 'help', '-h'])(
    'prints aggregated usage and exits 0 for "%s" without touching the sync',
    async (helpFlag) => {
      process.argv = ['node', 'index.js', helpFlag];
      const { fetchAllRecords, deleteRecords } = await import(
        '@/libs/records.js'
      );
      const { default: yoctoSpinner } = await import('yocto-spinner');

      await import('@/index.js');

      // Aggregates every subcommand's own USAGE string.
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Usage: markpost sync'),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Usage: markpost push'),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Usage: markpost get'),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Usage: markpost sources'),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Usage: markpost records'),
      );
      expect(fetchAllRecords).not.toHaveBeenCalled();
      expect(deleteRecords).not.toHaveBeenCalled();
      expect(yoctoSpinner).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    },
  );

  it('prints only the targeted command usage for "help <command>"', async () => {
    process.argv = ['node', 'index.js', 'help', 'sync'];

    await import('@/index.js');

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Usage: markpost sync'),
    );
    expect(console.log).not.toHaveBeenCalledWith(
      expect.stringContaining('Usage: markpost push'),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('falls back to the full help for an unknown help topic', async () => {
    process.argv = ['node', 'index.js', 'help', 'bogus'];

    await import('@/index.js');

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Usage: markpost <command>'),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('prints help, fails loud, and never runs the destructive sync when invoked with no arguments', async () => {
    process.argv = ['node', 'index.js'];
    const { fetchAllRecords, deleteRecords } = await import('@/libs/records.js');
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    await import('@/index.js');

    // A bare invocation is a missing-command error: help goes to stderr and
    // the exit code is non-zero so a cron job or wrapper can't "succeed"
    // while silently syncing nothing.
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Usage: markpost <command>'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('No command given'),
    );
    expect(process.exitCode).toBe(1);
    // The whole point of the fix: a bare invocation must not fetch, write, or
    // delete anything.
    expect(fetchAllRecords).not.toHaveBeenCalled();
    expect(writeMarkdown).not.toHaveBeenCalled();
    expect(deleteRecords).not.toHaveBeenCalled();
    expect(yoctoSpinner).not.toHaveBeenCalled();
  });

  it.each(['--help', '-h'])(
    'prints sync usage instead of syncing for "sync %s"',
    async (helpFlag) => {
      process.argv = ['node', 'index.js', 'sync', helpFlag];
      const { fetchAllRecords, deleteRecords } = await import(
        '@/libs/records.js'
      );
      const { default: yoctoSpinner } = await import('yocto-spinner');

      await import('@/index.js');

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Usage: markpost sync'),
      );
      expect(fetchAllRecords).not.toHaveBeenCalled();
      expect(deleteRecords).not.toHaveBeenCalled();
      expect(yoctoSpinner).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    },
  );

  it.each([
    ['push', '--help'],
    ['get', '-h'],
    ['sources', '--help'],
    ['records', '-h'],
  ])(
    'prints %s usage for "%s %s" without invoking the command handler',
    async (name, helpFlag) => {
      process.argv = ['node', 'index.js', name, helpFlag];
      const pushModule = await import('@/commands/push.js');
      const getModule = await import('@/commands/get.js');
      const sourcesModule = await import('@/commands/sources.js');
      const recordsModule = await import('@/commands/records.js');

      await import('@/index.js');

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining(`Usage: markpost ${name}`),
      );
      // A help flag must short-circuit before the handler runs, so no config
      // check or API call happens.
      expect(pushModule.runPushCommand).not.toHaveBeenCalled();
      expect(getModule.runGetCommand).not.toHaveBeenCalled();
      expect(sourcesModule.runSourcesCommand).not.toHaveBeenCalled();
      expect(recordsModule.runRecordsCommand).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    },
  );

  it('errors and skips the sync when the sync command is given unexpected arguments', async () => {
    process.argv = ['node', 'index.js', 'sync', 'oops'];
    const { fetchAllRecords, deleteRecords } = await import('@/libs/records.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    await import('@/index.js');

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Unexpected arguments: oops'),
    );
    expect(process.exitCode).toBe(1);
    expect(fetchAllRecords).not.toHaveBeenCalled();
    expect(deleteRecords).not.toHaveBeenCalled();
    expect(yoctoSpinner).not.toHaveBeenCalled();
  });

  it('runs the sync only under the explicit "sync" command', async () => {
    process.argv = ['node', 'index.js', 'sync'];
    const { fetchAllRecords, deleteRecords } = await import('@/libs/records.js');
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(mockSettings());
    vi.mocked(fetchAllRecords).mockResolvedValue({ ok: true, records: [mockRecord], partial: false });
    vi.mocked(writeMarkdown).mockReturnValue('/mock/output/test-title.md');
    vi.mocked(deleteRecords).mockResolvedValue({ deleted: 1 });

    await import('@/index.js');

    // Scoped to pending so the sync never re-fetches already-synced records
    // (regression guard for the `-2`/`-3` duplicate bug).
    expect(fetchAllRecords).toHaveBeenCalledWith({ status: 'pending' });
    expect(deleteRecords).toHaveBeenCalledWith(['abc-123']);
  });

  // checkConfig now signals failure by resolving false rather than terminating
  // the process, so the sync must abort before reading settings or fetching
  // records instead of falling through with unconfigured credentials.
  it('aborts the sync without fetching when checkConfig resolves false', async () => {
    process.argv = ['node', 'index.js', 'sync'];
    const { checkConfig } = await import('@/libs/config.js');
    const { fetchAllRecords } = await import('@/libs/records.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    // Once so the false result can't leak past this test's single sync call
    // (beforeEach clears call history, not implementations).
    vi.mocked(checkConfig).mockResolvedValueOnce(false);

    await import('@/index.js');

    expect(fetchSettings).not.toHaveBeenCalled();
    expect(fetchAllRecords).not.toHaveBeenCalled();
  });

  it('fetches all records and writes each as markdown', async () => {
    const { fetchAllRecords, deleteRecords } = await import('@/libs/records.js');
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(mockSettings());
    vi.mocked(fetchAllRecords).mockResolvedValue({ ok: true, records: [mockRecord], partial: false });
    vi.mocked(writeMarkdown).mockReturnValue('/mock/output/test-title.md');
    vi.mocked(deleteRecords).mockResolvedValue({ deleted: 1 });

    await import('@/index.js');

    expect(mockSpinner.start).toHaveBeenCalledWith('Fetching records...');
    expect(fetchAllRecords).toHaveBeenCalled();
    expect(writeMarkdown).toHaveBeenCalledWith(mockRecord, 'suffix', expect.any(Map), true, expect.any(Map), expect.any(Set));
    expect(mockSpinner.success).toHaveBeenCalledWith('Fetched 1 records!');
    expect(mockSpinner.start).toHaveBeenCalledWith('Writing records...');
    expect(mockSpinner.success).toHaveBeenCalledWith('Wrote 1 records!');
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('/mock/output/test-title.md'),
    );
    expect(mockSpinner.start).toHaveBeenCalledWith('Deleting records...');
    expect(deleteRecords).toHaveBeenCalledWith(['abc-123']);
  });

  it('writes one markdown file per record', async () => {
    const mockRecord2: Record = { uuid: 'def-456', title: 'Title 2', content: 'Content 2', createdAt: '2024-01-02T00:00:00Z' };
    const { fetchAllRecords, deleteRecords } = await import('@/libs/records.js');
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(mockSettings());
    vi.mocked(fetchAllRecords).mockResolvedValue({ ok: true, records: [mockRecord, mockRecord2], partial: false });
    vi.mocked(writeMarkdown)
      .mockReturnValueOnce('/mock/output/test-title.md')
      .mockReturnValueOnce('/mock/output/title-2.md');
    vi.mocked(deleteRecords).mockResolvedValue({ deleted: 1 });

    await import('@/index.js');

    expect(writeMarkdown).toHaveBeenCalledTimes(2);
    expect(writeMarkdown).toHaveBeenCalledWith(mockRecord, 'suffix', expect.any(Map), true, expect.any(Map), expect.any(Set));
    expect(writeMarkdown).toHaveBeenCalledWith(mockRecord2, 'suffix', expect.any(Map), true, expect.any(Map), expect.any(Set));
    // The whole reason seenSlugs is threaded is that every record in a batch
    // shares one Set — assert the exact same instance reaches both calls, so
    // a regression to a per-record Set (which would disable the overwrite
    // clobber guard) fails here.
    const [firstCall, secondCall] = vi.mocked(writeMarkdown).mock.calls;
    expect(secondCall[2]).toBe(firstCall[2]);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('/mock/output/test-title.md'),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('/mock/output/title-2.md'),
    );
    expect(deleteRecords).toHaveBeenCalledWith(['abc-123', 'def-456']);
  });

  it('warns about and excludes a dropped-server-change record from the delete', async () => {
    const droppedRecord: Record = {
      uuid: 'dropped-1',
      title: 'Dropped',
      content: 'x',
      createdAt: '2024-01-03T00:00:00Z',
    };
    const { fetchAllRecords, deleteRecords } = await import('@/libs/records.js');
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(mockSettings());
    vi.mocked(fetchAllRecords).mockResolvedValue({
      ok: true,
      records: [mockRecord, droppedRecord],
      partial: false,
    });
    // The second record's changed server revision is dropped for a local vault
    // edit; writeMarkdown signals that by adding the uuid to the collector Set.
    vi.mocked(writeMarkdown).mockImplementation(
      (record, _strategy, _seen, _frontmatter, _state, dropped) => {
        if (record.uuid === droppedRecord.uuid) {
          dropped?.add(record.uuid);
        }

        return `/mock/output/${record.uuid}.md`;
      },
    );
    vi.mocked(deleteRecords).mockResolvedValue({ deleted: 1 });

    await import('@/index.js');

    // Only the clean record is deleted; the dropped one is held back so its
    // server revision survives.
    expect(deleteRecords).toHaveBeenCalledWith(['abc-123']);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Deferred 1 record(s)'),
    );
  });

  it('warns about and excludes a dropped-server-change record from the mark-synced step', async () => {
    const droppedRecord: Record = {
      uuid: 'dropped-1',
      title: 'Dropped',
      content: 'x',
      createdAt: '2024-01-03T00:00:00Z',
    };
    const { fetchAllRecords, markRecordsSynced } = await import(
      '@/libs/records.js'
    );
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(mockSettings({ autoDelete: false }));
    vi.mocked(fetchAllRecords).mockResolvedValue({
      ok: true,
      records: [mockRecord, droppedRecord],
      partial: false,
    });
    vi.mocked(writeMarkdown).mockImplementation(
      (record, _strategy, _seen, _frontmatter, _state, dropped) => {
        if (record.uuid === droppedRecord.uuid) {
          dropped?.add(record.uuid);
        }

        return `/mock/output/${record.uuid}.md`;
      },
    );
    vi.mocked(markRecordsSynced).mockImplementation(markResultAll(MARK_SYNCED));

    await import('@/index.js');

    // Only the clean record is marked synced; the dropped one is held back from
    // the bulk call so it stays pending and a later run can re-surface the
    // unreconciled server revision.
    expect(markRecordsSynced).toHaveBeenCalledTimes(1);
    expect(markRecordsSynced).toHaveBeenCalledWith([
      { uuid: 'abc-123', filePath: '/mock/output/abc-123.md' },
    ]);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Deferred 1 record(s)'),
    );
  });

  it('passes the same seenSlugs map instance to every autoSync pass', async () => {
    const { fetchAllRecords, deleteRecords } = await import('@/libs/records.js');
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { runSyncWithAutoSchedule } = await import('@/libs/scheduler.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    const SHARED_SLUG = 'same-title';
    const passOneRecord: Record = { uuid: 'pass-1', title: 'Same Title', content: 'One', createdAt: '2024-01-01T00:00:00Z' };
    const passTwoRecord: Record = { uuid: 'pass-2', title: 'Same Title', content: 'Two', createdAt: '2024-01-02T00:00:00Z' };

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(mockSettings({ conflictStrategy: 'overwrite' }));
    // Each pass fetches a distinct record that slugifies to the same slug.
    vi.mocked(fetchAllRecords)
      .mockResolvedValueOnce({ ok: true, records: [passOneRecord], partial: false })
      .mockResolvedValueOnce({ ok: true, records: [passTwoRecord], partial: false });
    vi.mocked(deleteRecords).mockResolvedValue({ deleted: 1 });

    // Stand-in for writeMarkdown that records the first writer of the shared
    // slug and snapshots the owner the map reports at each call, so the test can
    // prove pass two sees the entry pass one wrote into the *same* map instance.
    // (This is not the real ownership rule — it only needs to observe cross-pass
    // map identity.) `Once` twice (writeMarkdown runs exactly once per pass) so
    // this implementation can't leak into later tests, whose implementations
    // persist across the suite.
    const ownerAtCall: (string | undefined)[] = [];
    const recordOwnership = (
      record: Record,
      _conflictStrategy?: ConflictStrategy,
      seenSlugs?: Map<string, string>,
      _includeFrontmatter?: boolean,
    ): string | null => {
      ownerAtCall.push(seenSlugs?.get(SHARED_SLUG));
      if (seenSlugs && !seenSlugs.has(SHARED_SLUG)) {
        seenSlugs.set(SHARED_SLUG, record.uuid);
      }
      return `/mock/output/${SHARED_SLUG}.md`;
    };
    vi.mocked(writeMarkdown)
      .mockImplementationOnce(recordOwnership)
      .mockImplementationOnce(recordOwnership);

    // Drive two sequential autoSync passes through the scheduler seam. `Once` so
    // this two-pass behavior reverts to the factory default (one pass) and can't
    // leak into later tests, whose implementations persist across the suite
    // (beforeEach clears call history, not implementations).
    vi.mocked(runSyncWithAutoSchedule).mockImplementationOnce(async (runSync) => {
      await runSync();
      await runSync();
    });

    await import('@/index.js');

    expect(writeMarkdown).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = vi.mocked(writeMarkdown).mock.calls;
    // The exact same Map instance reaches both passes — a per-pass map would be a
    // new object and this fails. Assert it's a real Map first so the identity
    // check can't pass vacuously on two `undefined` args.
    expect(firstCall[2]).toBeInstanceOf(Map);
    expect(secondCall[2]).toBe(firstCall[2]);
    // Pass one recorded pass-1 as the slug's owner; pass two still sees it, so a
    // different record is downgraded to suffix (behavior proven end-to-end in
    // markdown.test.ts). A per-pass map would make this [undefined, undefined].
    expect(ownerAtCall).toEqual([undefined, 'pass-1']);
  });

  it('exits early when no records are fetched', async () => {
    const { fetchAllRecords, deleteRecords } = await import('@/libs/records.js');
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchAllRecords).mockResolvedValue({ ok: true, records: [], partial: false });

    await import('@/index.js');

    expect(mockSpinner.success).toHaveBeenCalledWith('No new records, exiting...');
    expect(writeMarkdown).not.toHaveBeenCalled();
    expect(deleteRecords).not.toHaveBeenCalled();
  });

  // A failed fetch (`ok: false`) must fail loud with a non-zero exit — never
  // report "No new records" and exit 0, which would silently mask a broken
  // sync in cron (issue #63). It must also write and delete nothing.
  it('fails loud and exits non-zero when the record fetch fails', async () => {
    const { fetchAllRecords, deleteRecords } = await import('@/libs/records.js');
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(mockSettings());
    vi.mocked(fetchAllRecords).mockResolvedValue({ ok: false });

    await import('@/index.js');

    // Pin the fail-loud branch specifically: assert its exact message rather
    // than a bare `spinner.error` call, so deleting this branch (and letting
    // the generic catch's "Something went wrong!" fire instead) fails here.
    expect(mockSpinner.error).toHaveBeenCalledWith(
      'Failed to fetch records from the server — nothing synced.',
    );
    expect(mockSpinner.success).not.toHaveBeenCalledWith(
      'No new records, exiting...',
    );
    expect(writeMarkdown).not.toHaveBeenCalled();
    expect(deleteRecords).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  // The core of issue #89: an expired/invalid token surfaces as a systemic
  // ApiRequestError (401) re-thrown from fetchAllRecords. The sync must fail
  // loud — a classified, actionable spinner message and a non-zero exit —
  // never report "No new records, exiting..." and exit 0 (a silent failure a
  // cron job would treat as success). It must also write and delete nothing,
  // and stop autoSync from rescheduling into the same dead token.
  it('fails loud and exits non-zero on an expired-token (401) sync — not a silent success', async () => {
    const { fetchAllRecords, deleteRecords } = await import('@/libs/records.js');
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { ApiRequestError } = await import('@/libs/api.js');
    const { runSyncWithAutoSchedule } = await import('@/libs/scheduler.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    let scheduledAutoSync: boolean | undefined;
    vi.mocked(runSyncWithAutoSchedule).mockImplementationOnce(
      async (runSync) => {
        scheduledAutoSync = await runSync();
      },
    );
    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    // autoSync on by default — the failure must still return `false`.
    vi.mocked(fetchSettings).mockResolvedValue(mockSettings());
    // A leading ESC (0x1b) stands in for a server-derived escape sequence in
    // the message, so this also pins the sync-path sanitize wrap.
    const escape = String.fromCharCode(0x1b);
    vi.mocked(fetchAllRecords).mockRejectedValue(
      new ApiRequestError(
        `${escape}[2JInvalid or missing API token — run \`markpost config\` to set a valid one`,
        401,
      ),
    );

    await import('@/index.js');

    // The classified systemic message prints via console.error (guaranteed
    // output), not the generic "Something went wrong!" — so a cron log says the
    // token is the problem.
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Authentication failed (HTTP 401)'),
    );
    // The server-derived escape must be stripped before printing.
    const printedEscape = vi
      .mocked(console.error)
      .mock.calls.some(
        ([arg]) => typeof arg === 'string' && arg.includes(escape),
      );
    expect(printedEscape).toBe(false);
    expect(mockSpinner.error).not.toHaveBeenCalledWith('Something went wrong!');
    // The silent-success path must never fire.
    expect(mockSpinner.success).not.toHaveBeenCalledWith(
      'No new records, exiting...',
    );
    expect(writeMarkdown).not.toHaveBeenCalled();
    expect(deleteRecords).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    // A dead token recurs, so the scheduler must not spin another pass.
    expect(scheduledAutoSync).toBe(false);
  });

  // The same fail-fast holds for a non-auth systemic failure (a 5xx): its
  // classified message surfaces and the run never reports "No new records".
  // BUT a 5xx is transient, so — unlike a dead token — it must NOT kill the
  // autoSync daemon: the run reports autoSync back so the scheduler retries.
  it('fails loud on a systemic server (503) fetch failure but keeps autoSync alive to retry', async () => {
    const { fetchAllRecords } = await import('@/libs/records.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { ApiRequestError } = await import('@/libs/api.js');
    const { runSyncWithAutoSchedule } = await import('@/libs/scheduler.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    let scheduledAutoSync: boolean | undefined;
    vi.mocked(runSyncWithAutoSchedule).mockImplementationOnce(
      async (runSync) => {
        scheduledAutoSync = await runSync();
      },
    );
    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(mockSettings({ autoSync: true }));
    vi.mocked(fetchAllRecords).mockRejectedValue(
      new ApiRequestError('Service unavailable', 503),
    );

    await import('@/index.js');

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Server error (HTTP 503)'),
    );
    expect(mockSpinner.success).not.toHaveBeenCalledWith(
      'No new records, exiting...',
    );
    expect(process.exitCode).toBe(1);
    // Transient failure: the daemon must retry, so autoSync is preserved.
    expect(scheduledAutoSync).toBe(true);
  });

  // A partial read (a later page failed mid-pagination) must fail loud too —
  // exit non-zero and mark the spinner errored — while still syncing the pages
  // that were fetched, so cron never treats a truncated sync as clean.
  it('fails loud but still syncs the fetched pages on a partial fetch', async () => {
    const { fetchAllRecords, deleteRecords } = await import('@/libs/records.js');
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(mockSettings());
    vi.mocked(fetchAllRecords).mockResolvedValue({
      ok: true,
      records: [mockRecord],
      partial: true,
    });
    vi.mocked(writeMarkdown).mockReturnValue('/mock/output/test-title.md');
    vi.mocked(deleteRecords).mockResolvedValue({ deleted: 1 });

    await import('@/index.js');

    expect(mockSpinner.error).toHaveBeenCalledWith(
      expect.stringContaining('a later page failed'),
    );
    expect(mockSpinner.success).not.toHaveBeenCalledWith(
      'No new records, exiting...',
    );
    // The fetched page is still written and (with autoDelete on) deleted.
    expect(writeMarkdown).toHaveBeenCalledWith(
      mockRecord,
      'suffix',
      expect.any(Map),
      true,
      expect.any(Map),
      expect.any(Set),
    );
    expect(deleteRecords).toHaveBeenCalledWith(['abc-123']);
    // The run ends on the truncation warning, not the green delete-success line.
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Sync was incomplete'),
    );
    expect(process.exitCode).toBe(1);
  });

  // A partial read that fetched zero records must fail loud and return without
  // running the write path (no confusing "Wrote 0 records!" after the error).
  it('fails loud and writes nothing on a partial fetch that returned no records', async () => {
    const { fetchAllRecords, deleteRecords } = await import('@/libs/records.js');
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(mockSettings());
    vi.mocked(fetchAllRecords).mockResolvedValue({
      ok: true,
      records: [],
      partial: true,
    });

    await import('@/index.js');

    expect(mockSpinner.error).toHaveBeenCalledWith(
      expect.stringContaining('a later page failed'),
    );
    expect(mockSpinner.success).not.toHaveBeenCalledWith(
      'No new records, exiting...',
    );
    expect(writeMarkdown).not.toHaveBeenCalled();
    expect(deleteRecords).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('calls spinner.error and logs to console.error when fetchAllRecords throws', async () => {
    const { fetchAllRecords } = await import('@/libs/records.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchAllRecords).mockRejectedValue(new Error('Network error'));

    await import('@/index.js');

    expect(mockSpinner.error).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  const mockSettings = (
    overrides: Partial<UserSettings> = {},
  ): SettingsReadResult => ({
    ok: true,
    settings: {
      userId: 'user-1',
      vaultDir: '',
      filenameTemplate: '',
      autoSync: true,
      autoDelete: true,
      frontmatter: true,
      conflictStrategy: 'suffix',
      theme: 'system',
      accentColor: '#a855f7',
      updatedAt: '2024-01-01T00:00:00Z',
      ...overrides,
    },
  });

  it('writes but mutates nothing on the server (no delete, no mark) when settings cannot be read', async () => {
    const { fetchAllRecords, deleteRecords, markRecordsSynced } = await import(
      '@/libs/records.js'
    );
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue({ ok: false });
    vi.mocked(fetchAllRecords).mockResolvedValue({ ok: true, records: [mockRecord], partial: false });
    vi.mocked(writeMarkdown).mockReturnValue('/mock/output/test-title.md');

    await import('@/index.js');

    expect(writeMarkdown).toHaveBeenCalledWith(mockRecord, 'suffix', expect.any(Map), true, expect.any(Map), expect.any(Set));
    expect(mockSpinner.success).toHaveBeenCalledWith('Wrote 1 records!');
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Could not read settings'),
    );
    // With an unknown autoDelete preference the run must not mutate the server
    // at all: marking synced would be permanent and could strand records a
    // user with autoDelete on wanted deleted. They stay pending for a later
    // run instead.
    expect(mockSpinner.start).not.toHaveBeenCalledWith('Deleting records...');
    expect(deleteRecords).not.toHaveBeenCalled();
    expect(mockSpinner.start).not.toHaveBeenCalledWith(
      'Marking records synced...',
    );
    expect(markRecordsSynced).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Settings unreadable'),
    );
  });

  it("passes the user's conflict strategy from settings to writeMarkdown", async () => {
    const { fetchAllRecords, deleteRecords } = await import('@/libs/records.js');
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(
      mockSettings({ conflictStrategy: 'overwrite' }),
    );
    vi.mocked(fetchAllRecords).mockResolvedValue({ ok: true, records: [mockRecord], partial: false });
    vi.mocked(writeMarkdown).mockReturnValue('/mock/output/test-title.md');
    vi.mocked(deleteRecords).mockResolvedValue({ deleted: 1 });

    await import('@/index.js');

    expect(writeMarkdown).toHaveBeenCalledWith(mockRecord, 'overwrite', expect.any(Map), true, expect.any(Map), expect.any(Set));
  });

  it('normalizes an unknown conflict strategy from settings to suffix', async () => {
    const { fetchAllRecords, deleteRecords } = await import('@/libs/records.js');
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(
      mockSettings({ conflictStrategy: 'bogus-value' }),
    );
    vi.mocked(fetchAllRecords).mockResolvedValue({ ok: true, records: [mockRecord], partial: false });
    vi.mocked(writeMarkdown).mockReturnValue('/mock/output/test-title.md');
    vi.mocked(deleteRecords).mockResolvedValue({ deleted: 1 });

    await import('@/index.js');

    expect(writeMarkdown).toHaveBeenCalledWith(mockRecord, 'suffix', expect.any(Map), true, expect.any(Map), expect.any(Set));
  });

  it('passes includeFrontmatter=false to writeMarkdown when the frontmatter setting is off', async () => {
    const { fetchAllRecords, deleteRecords } = await import('@/libs/records.js');
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(
      mockSettings({ frontmatter: false }),
    );
    vi.mocked(fetchAllRecords).mockResolvedValue({
      ok: true,
      records: [mockRecord],
      partial: false,
    });
    vi.mocked(writeMarkdown).mockReturnValue('/mock/output/test-title.md');
    vi.mocked(deleteRecords).mockResolvedValue({ deleted: 1 });

    await import('@/index.js');

    expect(writeMarkdown).toHaveBeenCalledWith(
      mockRecord,
      'suffix',
      expect.any(Map),
      false,
      expect.any(Map),
      expect.any(Set),
    );
  });

  it('drives the default sync through the auto-sync scheduler', async () => {
    const { fetchAllRecords } = await import('@/libs/records.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { runSyncWithAutoSchedule } = await import('@/libs/scheduler.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(mockSettings());
    vi.mocked(fetchAllRecords).mockResolvedValue({ ok: true, records: [], partial: false });

    await import('@/index.js');

    expect(runSyncWithAutoSchedule).toHaveBeenCalledWith(expect.any(Function));
  });

  it('marks records synced (not deleted) when autoDelete is false', async () => {
    const { fetchAllRecords, deleteRecords, markRecordsSynced } = await import(
      '@/libs/records.js'
    );
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(
      mockSettings({ autoDelete: false }),
    );
    vi.mocked(fetchAllRecords).mockResolvedValue({ ok: true, records: [mockRecord], partial: false });
    vi.mocked(writeMarkdown).mockReturnValue('/mock/output/test-title.md');
    vi.mocked(markRecordsSynced).mockImplementation(markResultAll(MARK_SYNCED));

    await import('@/index.js');

    expect(mockSpinner.success).toHaveBeenCalledWith('Wrote 1 records!');
    expect(mockSpinner.start).not.toHaveBeenCalledWith('Deleting records...');
    expect(deleteRecords).not.toHaveBeenCalled();
    // The whole fix for #50: written records must be marked synced so the next
    // pending-only fetch skips them instead of re-writing duplicates.
    expect(mockSpinner.start).toHaveBeenCalledWith('Marking records synced...');
    expect(markRecordsSynced).toHaveBeenCalledWith([
      { uuid: 'abc-123', filePath: '/mock/output/test-title.md' },
    ]);
    expect(mockSpinner.success).toHaveBeenCalledWith('Marked 1 records synced!');
  });

  it('marks every written record synced, not just the first', async () => {
    const mockRecord2: Record = { uuid: 'def-456', title: 'Title 2', content: 'Content 2', createdAt: '2024-01-02T00:00:00Z' };
    const { fetchAllRecords, markRecordsSynced } = await import(
      '@/libs/records.js'
    );
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(
      mockSettings({ autoDelete: false }),
    );
    vi.mocked(fetchAllRecords).mockResolvedValue({
      ok: true,
      records: [mockRecord, mockRecord2],
      partial: false,
    });
    vi.mocked(writeMarkdown)
      .mockReturnValueOnce('/mock/output/test-title.md')
      .mockReturnValueOnce('/mock/output/title-2.md');
    vi.mocked(markRecordsSynced).mockImplementation(markResultAll(MARK_SYNCED));

    await import('@/index.js');

    // Both written records go up in a single bulk call, in write order.
    expect(markRecordsSynced).toHaveBeenCalledTimes(1);
    expect(markRecordsSynced).toHaveBeenCalledWith([
      { uuid: 'abc-123', filePath: '/mock/output/test-title.md' },
      { uuid: 'def-456', filePath: '/mock/output/title-2.md' },
    ]);
    expect(mockSpinner.success).toHaveBeenCalledWith('Marked 2 records synced!');
  });

  it('excludes skipped records (null write result) from the mark-synced calls', async () => {
    const mockRecord2: Record = { uuid: 'def-456', title: 'Title 2', content: 'Content 2', createdAt: '2024-01-02T00:00:00Z' };
    const { fetchAllRecords, markRecordsSynced } = await import(
      '@/libs/records.js'
    );
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(
      mockSettings({ autoDelete: false, conflictStrategy: 'skip' }),
    );
    vi.mocked(fetchAllRecords).mockResolvedValue({
      ok: true,
      records: [mockRecord, mockRecord2],
      partial: false,
    });
    vi.mocked(writeMarkdown)
      .mockReturnValueOnce('/mock/output/test-title.md')
      .mockReturnValueOnce(null);
    vi.mocked(markRecordsSynced).mockImplementation(markResultAll(MARK_SYNCED));

    await import('@/index.js');

    // The skipped record never lands on disk, so it must not appear in the bulk
    // payload — only the one written record is sent.
    expect(markRecordsSynced).toHaveBeenCalledTimes(1);
    expect(markRecordsSynced).toHaveBeenCalledWith([
      { uuid: 'abc-123', filePath: '/mock/output/test-title.md' },
    ]);
  });

  it('does not mark synced when every record was skipped', async () => {
    const mockRecord2: Record = { uuid: 'def-456', title: 'Title 2', content: 'Content 2', createdAt: '2024-01-02T00:00:00Z' };
    const { fetchAllRecords, markRecordsSynced } = await import(
      '@/libs/records.js'
    );
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(
      mockSettings({ autoDelete: false, conflictStrategy: 'skip' }),
    );
    vi.mocked(fetchAllRecords).mockResolvedValue({
      ok: true,
      records: [mockRecord, mockRecord2],
      partial: false,
    });
    vi.mocked(writeMarkdown).mockReturnValue(null);

    await import('@/index.js');

    expect(mockSpinner.start).not.toHaveBeenCalledWith(
      'Marking records synced...',
    );
    expect(markRecordsSynced).not.toHaveBeenCalled();
  });

  it('reports a mark-synced failure loudly instead of claiming success', async () => {
    const { fetchAllRecords, markRecordsSynced } = await import(
      '@/libs/records.js'
    );
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(
      mockSettings({ autoDelete: false }),
    );
    vi.mocked(fetchAllRecords).mockResolvedValue({
      ok: true,
      records: [mockRecord],
      partial: false,
    });
    vi.mocked(writeMarkdown).mockReturnValue('/mock/output/test-title.md');
    vi.mocked(markRecordsSynced).mockImplementation(markResultAll(MARK_FAILED));

    await import('@/index.js');

    expect(mockSpinner.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to mark 1 record(s) synced'),
    );
    expect(mockSpinner.success).not.toHaveBeenCalledWith(
      expect.stringContaining('Marked'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('reports only the records whose mark-synced failed, not the whole batch', async () => {
    const mockRecord2: Record = { uuid: 'def-456', title: 'Title 2', content: 'Content 2', createdAt: '2024-01-02T00:00:00Z' };
    const { fetchAllRecords, markRecordsSynced } = await import(
      '@/libs/records.js'
    );
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(
      mockSettings({ autoDelete: false }),
    );
    vi.mocked(fetchAllRecords).mockResolvedValue({
      ok: true,
      records: [mockRecord, mockRecord2],
      partial: false,
    });
    vi.mocked(writeMarkdown)
      .mockReturnValueOnce('/mock/output/test-title.md')
      .mockReturnValueOnce('/mock/output/title-2.md');
    // First record succeeds, second fails — the bulk response reports only
    // def-456 as unmatched, so the count and listed path must reflect exactly
    // the one failure, guarding against an off-by-one in the settle partition.
    vi.mocked(markRecordsSynced).mockImplementation(
      markResultBy((uuid) => (uuid === 'abc-123' ? MARK_SYNCED : MARK_FAILED)),
    );

    await import('@/index.js');

    expect(mockSpinner.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to mark 1 record(s) synced'),
    );
    expect(mockSpinner.success).not.toHaveBeenCalledWith(
      expect.stringContaining('Marked'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('/mock/output/title-2.md'),
    );
    expect(console.error).not.toHaveBeenCalledWith(
      expect.stringContaining('! abc-123'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('sends every written record in one bulk call and pinpoints a single failure', async () => {
    const records: Record[] = Array.from({ length: 11 }, (_item, index) => ({
      uuid: `uuid-${index}`,
      title: `Title ${index}`,
      content: `Content ${index}`,
      createdAt: '2024-01-01T00:00:00Z',
    }));
    const { fetchAllRecords, markRecordsSynced } = await import(
      '@/libs/records.js'
    );
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(
      mockSettings({ autoDelete: false }),
    );
    vi.mocked(fetchAllRecords).mockResolvedValue({
      ok: true,
      records,
      partial: false,
    });
    vi.mocked(writeMarkdown).mockImplementation(
      (record: Record) => `/mock/output/${record.uuid}.md`,
    );
    // Every record goes up in a single bulk request; only uuid-10 comes back
    // unmatched, exercising the per-record settle/report over one bulk response.
    vi.mocked(markRecordsSynced).mockImplementation(
      markResultBy((uuid) => (uuid === 'uuid-10' ? MARK_FAILED : MARK_SYNCED)),
    );

    await import('@/index.js');

    expect(markRecordsSynced).toHaveBeenCalledTimes(1);
    expect(markRecordsSynced).toHaveBeenCalledWith(
      records.map((record) => ({
        uuid: record.uuid,
        filePath: `/mock/output/${record.uuid}.md`,
      })),
    );
    expect(mockSpinner.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to mark 1 record(s) synced'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('! uuid-10 -> /mock/output/uuid-10.md'),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Marked 10 record(s) synced despite'),
    );
    expect(process.exitCode).toBe(1);
  });

  // A timeout aborts inside markRecordsSynced (chunk boundaries + the abort are
  // covered in tests/libs/records.test.ts); here the bulk call resolves a short
  // outcomes array — a timed-out record plus a trailing record with no outcome
  // because its chunk was never sent. Both must be reported pending.
  it('reports timed-out and never-attempted records as pending after an abort', async () => {
    const records: Record[] = Array.from({ length: 3 }, (_item, index) => ({
      uuid: `uuid-${index}`,
      title: `Title ${index}`,
      content: `Content ${index}`,
      createdAt: '2024-01-01T00:00:00Z',
    }));
    const { fetchAllRecords, markRecordsSynced } = await import(
      '@/libs/records.js'
    );
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(
      mockSettings({ autoDelete: false }),
    );
    vi.mocked(fetchAllRecords).mockResolvedValue({
      ok: true,
      records,
      partial: false,
    });
    vi.mocked(writeMarkdown).mockImplementation(
      (record: Record) => `/mock/output/${record.uuid}.md`,
    );
    // uuid-0 synced, uuid-1 timed out (abort), uuid-2 never attempted (no
    // outcome). The short outcomes array models the real timeout abort.
    vi.mocked(markRecordsSynced).mockResolvedValue({
      outcomes: [MARK_SYNCED, MARK_TIMED_OUT],
      stoppedBy: MARK_TIMED_OUT,
    });

    await import('@/index.js');

    // Timed-out (uuid-1) plus the never-attempted uuid-2 = two pending.
    expect(mockSpinner.error).toHaveBeenCalledWith(
      expect.stringContaining('2 record(s) still pending'),
    );
    expect(mockSpinner.error).toHaveBeenCalledWith(
      expect.stringContaining('Timed out marking records synced'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('! uuid-1 -> /mock/output/uuid-1.md'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('! uuid-2 -> /mock/output/uuid-2.md'),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Marked 1 record(s) synced despite'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('uses the abort wording when a request-shape 4xx stops the run', async () => {
    const records: Record[] = Array.from({ length: 3 }, (_item, index) => ({
      uuid: `uuid-${index}`,
      title: `Title ${index}`,
      content: `Content ${index}`,
      createdAt: '2024-01-01T00:00:00Z',
    }));
    const { fetchAllRecords, markRecordsSynced } = await import(
      '@/libs/records.js'
    );
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(
      mockSettings({ autoDelete: false }),
    );
    vi.mocked(fetchAllRecords).mockResolvedValue({
      ok: true,
      records,
      partial: false,
    });
    vi.mocked(writeMarkdown).mockImplementation(
      (record: Record) => `/mock/output/${record.uuid}.md`,
    );
    // uuid-0 synced, uuid-1's chunk was rejected as a request-shape 4xx (abort),
    // uuid-2 never attempted (no outcome) — the short outcomes array models the
    // real abort, and stoppedBy drives the abort-specific headline.
    vi.mocked(markRecordsSynced).mockResolvedValue({
      outcomes: [MARK_SYNCED, MARK_ABORTED],
      stoppedBy: MARK_ABORTED,
    });

    await import('@/index.js');

    // Rejected uuid-1 plus the never-attempted uuid-2 = two pending.
    expect(mockSpinner.error).toHaveBeenCalledWith(
      expect.stringContaining('2 record(s) still pending'),
    );
    expect(mockSpinner.error).toHaveBeenCalledWith(
      expect.stringContaining('Aborted marking records synced'),
    );
    // The abort headline must not read as a timeout or a plain scatter of
    // failures — guards the reason wiring.
    expect(mockSpinner.error).not.toHaveBeenCalledWith(
      expect.stringContaining('Timed out marking records synced'),
    );
    expect(mockSpinner.error).not.toHaveBeenCalledWith(
      expect.stringContaining('Failed to mark'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('! uuid-1 -> /mock/output/uuid-1.md'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('! uuid-2 -> /mock/output/uuid-2.md'),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Marked 1 record(s) synced despite'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('does not use the timeout wording for a plain (non-timeout) failure', async () => {
    const records: Record[] = Array.from({ length: 4 }, (_item, index) => ({
      uuid: `uuid-${index}`,
      title: `Title ${index}`,
      content: `Content ${index}`,
      createdAt: '2024-01-01T00:00:00Z',
    }));
    const { fetchAllRecords, markRecordsSynced } = await import(
      '@/libs/records.js'
    );
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(
      mockSettings({ autoDelete: false }),
    );
    vi.mocked(fetchAllRecords).mockResolvedValue({
      ok: true,
      records,
      partial: false,
    });
    vi.mocked(writeMarkdown).mockImplementation(
      (record: Record) => `/mock/output/${record.uuid}.md`,
    );
    // uuid-3 comes back unmatched (a plain failure, not a timeout). The report
    // must use the failure wording, never the timeout wording, and every record
    // still had an outcome — nothing was aborted.
    vi.mocked(markRecordsSynced).mockImplementation(
      markResultBy((uuid) => (uuid === 'uuid-3' ? MARK_FAILED : MARK_SYNCED)),
    );

    await import('@/index.js');

    expect(mockSpinner.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to mark 1 record(s) synced'),
    );
    expect(mockSpinner.error).not.toHaveBeenCalledWith(
      expect.stringContaining('Timed out marking records synced'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('! uuid-3 -> /mock/output/uuid-3.md'),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Marked 3 record(s) synced despite'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('reports only the timed-out record when nothing was left unattempted', async () => {
    const records: Record[] = Array.from({ length: 2 }, (_item, index) => ({
      uuid: `uuid-${index}`,
      title: `Title ${index}`,
      content: `Content ${index}`,
      createdAt: '2024-01-01T00:00:00Z',
    }));
    const { fetchAllRecords, markRecordsSynced } = await import(
      '@/libs/records.js'
    );
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(
      mockSettings({ autoDelete: false }),
    );
    vi.mocked(fetchAllRecords).mockResolvedValue({
      ok: true,
      records,
      partial: false,
    });
    vi.mocked(writeMarkdown).mockImplementation(
      (record: Record) => `/mock/output/${record.uuid}.md`,
    );
    // The abort lands on the last record, so every record has an outcome and
    // only the timed-out one is pending — no never-attempted tail.
    vi.mocked(markRecordsSynced).mockResolvedValue({
      outcomes: [MARK_SYNCED, MARK_TIMED_OUT],
      stoppedBy: MARK_TIMED_OUT,
    });

    await import('@/index.js');

    expect(mockSpinner.error).toHaveBeenCalledWith(
      expect.stringContaining('1 record(s) still pending'),
    );
    expect(mockSpinner.error).toHaveBeenCalledWith(
      expect.stringContaining('Timed out marking records synced'),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Marked 1 record(s) synced despite'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('counts both a failed and a timed-out record as pending in one run', async () => {
    const records: Record[] = Array.from({ length: 4 }, (_item, index) => ({
      uuid: `uuid-${index}`,
      title: `Title ${index}`,
      content: `Content ${index}`,
      createdAt: '2024-01-01T00:00:00Z',
    }));
    const { fetchAllRecords, markRecordsSynced } = await import(
      '@/libs/records.js'
    );
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(
      mockSettings({ autoDelete: false }),
    );
    vi.mocked(fetchAllRecords).mockResolvedValue({
      ok: true,
      records,
      partial: false,
    });
    vi.mocked(writeMarkdown).mockImplementation(
      (record: Record) => `/mock/output/${record.uuid}.md`,
    );
    // uuid-1 failed and uuid-2 timed out (abort), so uuid-3 was never attempted.
    // All three non-synced records are pending and the run uses timeout wording.
    vi.mocked(markRecordsSynced).mockResolvedValue({
      outcomes: [MARK_SYNCED, MARK_FAILED, MARK_TIMED_OUT],
      stoppedBy: MARK_TIMED_OUT,
    });

    await import('@/index.js');

    // uuid-1 failed, uuid-2 timed out, uuid-3 never attempted = three pending.
    expect(mockSpinner.error).toHaveBeenCalledWith(
      expect.stringContaining('3 record(s) still pending'),
    );
    expect(mockSpinner.error).toHaveBeenCalledWith(
      expect.stringContaining('Timed out marking records synced'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('! uuid-1 -> /mock/output/uuid-1.md'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('warns the sync was incomplete on the mark-synced path when a page failed', async () => {
    const { fetchAllRecords, markRecordsSynced } = await import(
      '@/libs/records.js'
    );
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(
      mockSettings({ autoDelete: false }),
    );
    // A later page failed mid-pagination but the fetched page still marks synced.
    vi.mocked(fetchAllRecords).mockResolvedValue({
      ok: true,
      records: [mockRecord],
      partial: true,
    });
    vi.mocked(writeMarkdown).mockReturnValue('/mock/output/test-title.md');
    vi.mocked(markRecordsSynced).mockImplementation(markResultAll(MARK_SYNCED));

    await import('@/index.js');

    // The run must not finish on the green "Marked" line while a page is still
    // outstanding — the truncation warning has the last word and the exit is 1.
    expect(mockSpinner.success).toHaveBeenCalledWith('Marked 1 records synced!');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Sync was incomplete'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('sanitizes control characters in a failed mark-synced record line', async () => {
    // ESC (0x1b) built via fromCharCode so no raw control byte lives in source.
    const escape = String.fromCharCode(0x1b);
    const evilRecord: Record = {
      uuid: `evil${escape}[2J-uuid`,
      title: 'Evil',
      content: 'c',
      createdAt: '2024-01-07T00:00:00Z',
    };
    const { fetchAllRecords, markRecordsSynced } = await import(
      '@/libs/records.js'
    );
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(
      mockSettings({ autoDelete: false }),
    );
    vi.mocked(fetchAllRecords).mockResolvedValue({
      ok: true,
      records: [evilRecord],
      partial: false,
    });
    vi.mocked(writeMarkdown).mockReturnValue('/mock/output/evil.md');
    vi.mocked(markRecordsSynced).mockImplementation(markResultAll(MARK_FAILED));

    await import('@/index.js');

    // The ESC in the API-supplied uuid must never reach the terminal raw, where
    // it could drive an ANSI clear/overwrite and hide the failure.
    const escapePrinted = vi
      .mocked(console.error)
      .mock.calls.some(
        ([arg]) => typeof arg === 'string' && arg.includes(escape),
      );
    expect(escapePrinted).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('/mock/output/evil.md'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('warns the sync was incomplete on the autoDelete path when a page failed and nothing was written', async () => {
    const { fetchAllRecords, deleteRecords } = await import('@/libs/records.js');
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(
      mockSettings({ autoDelete: true, conflictStrategy: 'skip' }),
    );
    // A later page failed and every fetched record is skipped, so nothing is
    // written and no delete is issued — but the user must still be told a page
    // failed rather than seeing a bare "Wrote 0 records!" as the last word.
    vi.mocked(fetchAllRecords).mockResolvedValue({
      ok: true,
      records: [mockRecord],
      partial: true,
    });
    vi.mocked(writeMarkdown).mockReturnValue(null);

    await import('@/index.js');

    expect(deleteRecords).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Sync was incomplete'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('deletes records (never marks synced) when autoDelete is true', async () => {
    const { fetchAllRecords, deleteRecords, markRecordsSynced } = await import(
      '@/libs/records.js'
    );
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(
      mockSettings({ autoDelete: true }),
    );
    vi.mocked(fetchAllRecords).mockResolvedValue({ ok: true, records: [mockRecord], partial: false });
    vi.mocked(writeMarkdown).mockReturnValue('/mock/output/test-title.md');
    vi.mocked(deleteRecords).mockResolvedValue({ deleted: 1 });

    await import('@/index.js');

    expect(deleteRecords).toHaveBeenCalledWith(['abc-123']);
    // The delete path must not also PATCH records that are about to be removed.
    expect(markRecordsSynced).not.toHaveBeenCalled();
    expect(mockSpinner.start).not.toHaveBeenCalledWith(
      'Marking records synced...',
    );
  });

  it('excludes skipped records (null write result) from the delete call', async () => {
    const mockRecord2: Record = { uuid: 'def-456', title: 'Title 2', content: 'Content 2', createdAt: '2024-01-02T00:00:00Z' };
    const { fetchAllRecords, deleteRecords } = await import('@/libs/records.js');
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(
      mockSettings({ conflictStrategy: 'skip' }),
    );
    vi.mocked(fetchAllRecords).mockResolvedValue({ ok: true, records: [mockRecord, mockRecord2], partial: false });
    vi.mocked(writeMarkdown)
      .mockReturnValueOnce('/mock/output/test-title.md')
      .mockReturnValueOnce(null);
    vi.mocked(deleteRecords).mockResolvedValue({ deleted: 1 });

    await import('@/index.js');

    expect(mockSpinner.success).toHaveBeenCalledWith('Wrote 1 records!');
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Skipped 1 record(s)'),
    );
    expect(deleteRecords).toHaveBeenCalledWith(['abc-123']);
  });

  it('does not issue a delete request when every record was skipped', async () => {
    const mockRecord2: Record = { uuid: 'def-456', title: 'Title 2', content: 'Content 2', createdAt: '2024-01-02T00:00:00Z' };
    const { fetchAllRecords, deleteRecords } = await import('@/libs/records.js');
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(
      mockSettings({ conflictStrategy: 'skip' }),
    );
    vi.mocked(fetchAllRecords).mockResolvedValue({ ok: true, records: [mockRecord, mockRecord2], partial: false });
    vi.mocked(writeMarkdown).mockReturnValue(null);

    await import('@/index.js');

    expect(mockSpinner.success).toHaveBeenCalledWith('Wrote 0 records!');
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Skipped 2 record(s)'),
    );
    expect(mockSpinner.start).not.toHaveBeenCalledWith('Deleting records...');
    expect(deleteRecords).not.toHaveBeenCalled();
  });

  it('reports a delete failure loudly instead of claiming success', async () => {
    const { fetchAllRecords, deleteRecords } = await import('@/libs/records.js');
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(mockSettings());
    vi.mocked(fetchAllRecords).mockResolvedValue({ ok: true, records: [mockRecord], partial: false });
    vi.mocked(writeMarkdown).mockReturnValue('/mock/output/test-title.md');
    vi.mocked(deleteRecords).mockResolvedValue(null);

    await import('@/index.js');

    expect(deleteRecords).toHaveBeenCalledWith(['abc-123']);
    expect(mockSpinner.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to delete records'),
    );
    expect(mockSpinner.success).not.toHaveBeenCalledWith(
      expect.stringContaining('Deleted'),
    );
    expect(process.exitCode).toBe(1);
  });

  // A systemic delete failure (dead token) re-throws from deleteRecords: the
  // sync must surface its classified message, fail loud, AND stop rescheduling
  // the autoSync daemon — otherwise it wakes every few minutes and re-writes
  // the same records as duplicates against a server it can't delete from.
  it('surfaces a systemic delete failure and stops autoSync from rescheduling', async () => {
    const { fetchAllRecords, deleteRecords } = await import('@/libs/records.js');
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { ApiRequestError } = await import('@/libs/api.js');
    const { runSyncWithAutoSchedule } = await import('@/libs/scheduler.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    let scheduledAutoSync: boolean | undefined;
    vi.mocked(runSyncWithAutoSchedule).mockImplementationOnce(
      async (runSync) => {
        scheduledAutoSync = await runSync();
      },
    );
    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    // autoSync on, so a naive delete-failure path would return `true` and keep
    // the daemon alive.
    vi.mocked(fetchSettings).mockResolvedValue(mockSettings({ autoSync: true }));
    vi.mocked(fetchAllRecords).mockResolvedValue({
      ok: true,
      records: [mockRecord],
      partial: false,
    });
    vi.mocked(writeMarkdown).mockReturnValue('/mock/output/test-title.md');
    vi.mocked(deleteRecords).mockRejectedValue(
      new ApiRequestError('Invalid or missing API token', 401),
    );

    await import('@/index.js');

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Authentication failed (HTTP 401)'),
    );
    expect(mockSpinner.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to delete records'),
    );
    expect(process.exitCode).toBe(1);
    // The run reported autoSync off, so the scheduler won't spin another pass.
    expect(scheduledAutoSync).toBe(false);
  });

  // A TRANSIENT delete failure (5xx) also fails loud, but must keep autoSync
  // alive — the server may recover, and the records are still pending, so the
  // next pass should retry rather than the daemon shutting down permanently.
  it('keeps autoSync alive after a transient (503) delete failure', async () => {
    const { fetchAllRecords, deleteRecords } = await import('@/libs/records.js');
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { ApiRequestError } = await import('@/libs/api.js');
    const { runSyncWithAutoSchedule } = await import('@/libs/scheduler.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    let scheduledAutoSync: boolean | undefined;
    vi.mocked(runSyncWithAutoSchedule).mockImplementationOnce(
      async (runSync) => {
        scheduledAutoSync = await runSync();
      },
    );
    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(mockSettings({ autoSync: true }));
    vi.mocked(fetchAllRecords).mockResolvedValue({
      ok: true,
      records: [mockRecord],
      partial: false,
    });
    vi.mocked(writeMarkdown).mockReturnValue('/mock/output/test-title.md');
    vi.mocked(deleteRecords).mockRejectedValue(
      new ApiRequestError('Service unavailable', 503),
    );

    await import('@/index.js');

    expect(mockSpinner.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to delete records'),
    );
    expect(process.exitCode).toBe(1);
    expect(scheduledAutoSync).toBe(true);
  });

  // Tests 1 and 2 share the same arrange: two records where mockRecord's write
  // throws and the second (def-456) succeeds. Extracted per rule of three so
  // the two assertions read on their own. The write outcome is keyed off the
  // record (not call order) to match the other write tests in this file.
  const arrangeFailingFirstWrite = async (): Promise<void> => {
    const mockRecord2: Record = { uuid: 'def-456', title: 'Title 2', content: 'Content 2', createdAt: '2024-01-02T00:00:00Z' };
    const { fetchAllRecords, deleteRecords } = await import('@/libs/records.js');
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(mockSettings());
    vi.mocked(fetchAllRecords).mockResolvedValue({ ok: true, records: [mockRecord, mockRecord2], partial: false });
    vi.mocked(writeMarkdown).mockImplementation((record) => {
      if (record.uuid === 'abc-123') {
        throw new Error('EACCES: permission denied');
      }

      return '/mock/output/title-2.md';
    });
    vi.mocked(deleteRecords).mockResolvedValue({ deleted: 1 });
  };

  it('contains a per-record write failure: keeps writing the rest and deletes only the written ones', async () => {
    await arrangeFailingFirstWrite();
    const { deleteRecords } = await import('@/libs/records.js');
    const { writeMarkdown } = await import('@/libs/markdown.js');

    await import('@/index.js');

    // Both records are attempted — the first throwing does not short-circuit
    // the second.
    expect(writeMarkdown).toHaveBeenCalledTimes(2);
    expect(mockSpinner.success).toHaveBeenCalledWith('Wrote 1 records!');
    // The failed record is left on the server (excluded from the delete); only
    // the successfully-written one is deleted.
    expect(deleteRecords).toHaveBeenCalledWith(['def-456']);
  });

  it('surfaces per-record write failures loudly and exits non-zero', async () => {
    await arrangeFailingFirstWrite();

    await import('@/index.js');

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to write 1 record(s)'),
    );
    // The failing record's title, uuid, and error message are named so the
    // user knows exactly what didn't sync.
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Test Title (abc-123): EACCES: permission denied'),
    );
    // Non-zero exit so a cron run notices the partial failure.
    expect(process.exitCode).toBe(1);
  });

  it('exits non-zero, shows an error (not a green checkmark), and issues no delete when every record fails to write', async () => {
    const mockRecord2: Record = { uuid: 'def-456', title: 'Title 2', content: 'Content 2', createdAt: '2024-01-02T00:00:00Z' };
    const { fetchAllRecords, deleteRecords } = await import('@/libs/records.js');
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(mockSettings());
    vi.mocked(fetchAllRecords).mockResolvedValue({ ok: true, records: [mockRecord, mockRecord2], partial: false });
    vi.mocked(writeMarkdown).mockImplementation(() => {
      throw new Error('EISDIR: illegal operation on a directory');
    });

    await import('@/index.js');

    // A run that wrote nothing must not end the write phase on a success
    // checkmark; it reports an error instead.
    expect(mockSpinner.error).toHaveBeenCalledWith(
      expect.stringContaining('all 2 failed'),
    );
    expect(mockSpinner.success).not.toHaveBeenCalledWith(
      expect.stringContaining('Wrote'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to write 2 record(s)'),
    );
    // Nothing was written, so no delete request is issued.
    expect(mockSpinner.start).not.toHaveBeenCalledWith('Deleting records...');
    expect(deleteRecords).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('sanitizes control characters in a failed record title before printing it', async () => {
    // ESC (0x1b) built via fromCharCode so no raw control byte lives in source.
    const escape = String.fromCharCode(0x1b);
    const evilRecord: Record = { uuid: 'evil-1', title: `Bad${escape}[2JTitle`, content: 'c', createdAt: '2024-01-05T00:00:00Z' };
    const { fetchAllRecords } = await import('@/libs/records.js');
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(mockSettings());
    vi.mocked(fetchAllRecords).mockResolvedValue({ ok: true, records: [evilRecord], partial: false });
    vi.mocked(writeMarkdown).mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    await import('@/index.js');

    // The ESC is replaced with a space so it can't drive an ANSI clear/overwrite
    // sequence; the visible characters and the uuid survive intact.
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Bad [2JTitle (evil-1)'),
    );
    const escapePrinted = vi
      .mocked(console.error)
      .mock.calls.some(
        ([arg]) => typeof arg === 'string' && arg.includes(escape),
      );
    expect(escapePrinted).toBe(false);
  });

  it.each([
    ['DEL', '0x7f', 0x7f],
    ['C1 CSI', '0x9b', 0x9b],
    ['C1 OSC', '0x9d', 0x9d],
  ])(
    'strips the %s control character (%s) from a failed record title',
    async (_name, _hex, codePoint) => {
      const control = String.fromCharCode(codePoint);
      const evilRecord: Record = { uuid: 'evil-2', title: `A${control}B`, content: 'c', createdAt: '2024-01-06T00:00:00Z' };
      const { fetchAllRecords } = await import('@/libs/records.js');
      const { writeMarkdown } = await import('@/libs/markdown.js');
      const { fetchSettings } = await import('@/libs/settings.js');
      const { default: yoctoSpinner } = await import('yocto-spinner');

      vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
      vi.mocked(fetchSettings).mockResolvedValue(mockSettings());
      vi.mocked(fetchAllRecords).mockResolvedValue({ ok: true, records: [evilRecord], partial: false });
      vi.mocked(writeMarkdown).mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });

      await import('@/index.js');

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('A B (evil-2)'),
      );
      const controlPrinted = vi
        .mocked(console.error)
        .mock.calls.some(
          ([arg]) => typeof arg === 'string' && arg.includes(control),
        );
      expect(controlPrinted).toBe(false);
    },
  );

  it('reports a systemic output-directory failure once, not as a per-record failure list', async () => {
    const mockRecord2: Record = { uuid: 'def-456', title: 'Title 2', content: 'Content 2', createdAt: '2024-01-02T00:00:00Z' };
    const { fetchAllRecords, deleteRecords } = await import('@/libs/records.js');
    const { writeMarkdown, ensureOutputDirectory } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(mockSettings());
    vi.mocked(fetchAllRecords).mockResolvedValue({ ok: true, records: [mockRecord, mockRecord2], partial: false });
    // A batch-wide precondition failure throws before the per-record loop.
    // `Once` so this throw can't leak into later tests (beforeEach's
    // clearAllMocks resets call history but not implementations).
    vi.mocked(ensureOutputDirectory).mockImplementationOnce(() => {
      throw new Error('Output directory is not set!');
    });

    await import('@/index.js');

    // The systemic error routes through the outer catch and is reported once —
    // never per record, and no record is even attempted.
    expect(writeMarkdown).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalledWith(
      expect.stringContaining('Failed to write 2 record(s)'),
    );
    expect(mockSpinner.error).toHaveBeenCalledWith('Something went wrong!');
    expect(deleteRecords).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('reports written, skipped, and failed records as three distinct outcomes', async () => {
    const recordSkipped: Record = { uuid: 'skip-1', title: 'Skip Me', content: 'c', createdAt: '2024-01-03T00:00:00Z' };
    const recordFailed: Record = { uuid: 'fail-1', title: 'Fail Me', content: 'c', createdAt: '2024-01-04T00:00:00Z' };
    const { fetchAllRecords, deleteRecords } = await import('@/libs/records.js');
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(mockSettings());
    vi.mocked(fetchAllRecords).mockResolvedValue({ ok: true, records: [mockRecord, recordSkipped, recordFailed], partial: false });
    // Written, skipped (null), failed (throw) — one of each, keyed off the
    // record so the outcome doesn't depend on call order.
    vi.mocked(writeMarkdown).mockImplementation((record) => {
      if (record.uuid === 'skip-1') {
        return null;
      }

      if (record.uuid === 'fail-1') {
        throw new Error('EACCES: permission denied');
      }

      return '/mock/output/test-title.md';
    });
    vi.mocked(deleteRecords).mockResolvedValue({ deleted: 1 });

    await import('@/index.js');

    // Skipped and failed are counted separately, not lumped together — a
    // regression to `skipped = total - written` would report "Skipped 2" here.
    expect(mockSpinner.success).toHaveBeenCalledWith('Wrote 1 records!');
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Skipped 1 record(s)'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to write 1 record(s)'),
    );
    // Only the written record is deleted; skipped and failed stay on the server.
    expect(deleteRecords).toHaveBeenCalledWith(['abc-123']);
    expect(process.exitCode).toBe(1);
  });

  it('surfaces the message when a record write throws a non-Error value', async () => {
    const { fetchAllRecords, deleteRecords } = await import('@/libs/records.js');
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(mockSettings());
    vi.mocked(fetchAllRecords).mockResolvedValue({ ok: true, records: [mockRecord], partial: false });
    // A thrown string (not an Error) must still render its text, never
    // "[object Object]" — exercises extractErrorMessage's String(error) branch.
    vi.mocked(writeMarkdown).mockImplementation(() => {
      throw 'raw string failure';
    });
    vi.mocked(deleteRecords).mockResolvedValue({ deleted: 0 });

    await import('@/index.js');

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('raw string failure'),
    );
    expect(process.exitCode).toBe(1);
  });

  // A delete timeout (deleteRecords re-throws it) must land in the specific
  // "remain on the server" branch with a non-zero exit and log its reason,
  // not fall through to the generic outer catch that would hide the detail.
  it('reports a delete timeout with the specific consequence and its reason', async () => {
    const { fetchAllRecords, deleteRecords } = await import('@/libs/records.js');
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(mockSettings());
    vi.mocked(fetchAllRecords).mockResolvedValue({ ok: true, records: [mockRecord], partial: false });
    vi.mocked(writeMarkdown).mockReturnValue('/mock/output/test-title.md');
    vi.mocked(deleteRecords).mockRejectedValue(
      new Error('Request to https://example.com/api/records timed out'),
    );

    await import('@/index.js');

    expect(mockSpinner.error).toHaveBeenCalledWith(
      expect.stringContaining('remain on the server'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('timed out'),
    );
    expect(process.exitCode).toBe(1);
  });

  // A settings timeout must degrade like any settings read failure — write
  // records, skip the auto-delete, warn — not abort the whole sync. Writing
  // was never the risky operation.
  it('degrades to writing records and skipping delete when settings times out', async () => {
    const { fetchAllRecords, deleteRecords } = await import('@/libs/records.js');
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockRejectedValue(
      new Error('Request to https://example.com/api/settings timed out'),
    );
    vi.mocked(fetchAllRecords).mockResolvedValue({ ok: true, records: [mockRecord], partial: false });
    vi.mocked(writeMarkdown).mockReturnValue('/mock/output/test-title.md');

    await import('@/index.js');

    expect(writeMarkdown).toHaveBeenCalledWith(
      mockRecord,
      'suffix',
      expect.any(Map),
      true,
      expect.any(Map),
      expect.any(Set),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Could not read settings'),
    );
    expect(deleteRecords).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  // Snapshots the writtenPaths map each writeMarkdown call receives (before it
  // writes), then records the path for the record — the same shape as the real
  // writeMarkdown's own tracking — so a later pass can observe what the shared
  // map carried forward. `writtenPaths` is optional in the signature, so guard.
  const captureWrittenPaths = (
    snapshots: Array<Map<string, WrittenRecordState>>,
  ) => (
    record: Record,
    _conflictStrategy?: ConflictStrategy,
    _seenSlugs?: Map<string, string>,
    _includeFrontmatter?: boolean,
    writtenState?: Map<string, WrittenRecordState>,
  ): string | null => {
    const filePath = `/mock/output/${record.uuid}.md`;
    snapshots.push(new Map(writtenState));
    writtenState?.set(record.uuid, {
      path: filePath,
      contentHash: 'hash',
      identity: { deviceId: 1n, inode: 1n },
    });
    return filePath;
  };

  it('passes the same writtenPaths map instance to every autoSync pass', async () => {
    const passTwoRecord: Record = { uuid: 'def-456', title: 'Title 2', content: 'Two', createdAt: '2024-01-02T00:00:00Z' };
    const { fetchAllRecords, deleteRecords } = await import('@/libs/records.js');
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { runSyncWithAutoSchedule } = await import('@/libs/scheduler.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(mockSettings());
    vi.mocked(fetchAllRecords)
      .mockResolvedValueOnce({ ok: true, records: [mockRecord], partial: false })
      .mockResolvedValueOnce({ ok: true, records: [passTwoRecord], partial: false });
    vi.mocked(deleteRecords).mockResolvedValue({ deleted: 1 });
    vi.mocked(writeMarkdown).mockImplementation(captureWrittenPaths([]));
    vi.mocked(runSyncWithAutoSchedule).mockImplementationOnce(async (runSync) => {
      await runSync();
      await runSync();
    });

    await import('@/index.js');

    expect(writeMarkdown).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = vi.mocked(writeMarkdown).mock.calls;
    // A per-pass map would be a fresh object and this identity check fails,
    // disabling the cross-pass reuse that stops duplicate accumulation.
    expect(firstCall[4]).toBeInstanceOf(Map);
    expect(secondCall[4]).toBe(firstCall[4]);
    // writtenPaths (uuid-keyed reuse) and seenSlugs (path-keyed ownership) must
    // be distinct instances — passing one map for both collapses both guards.
    expect(firstCall[4]).not.toBe(firstCall[2]);
  });

  it('forgets a record from the written-path map once it settles (deleted) so a later pass no longer carries it', async () => {
    const passTwoRecord: Record = { uuid: 'def-456', title: 'Title 2', content: 'Two', createdAt: '2024-01-02T00:00:00Z' };
    const { fetchAllRecords, deleteRecords } = await import('@/libs/records.js');
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { runSyncWithAutoSchedule } = await import('@/libs/scheduler.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    const snapshots: Array<Map<string, WrittenRecordState>> = [];
    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(mockSettings({ autoDelete: true }));
    vi.mocked(fetchAllRecords)
      .mockResolvedValueOnce({ ok: true, records: [mockRecord], partial: false })
      .mockResolvedValueOnce({ ok: true, records: [passTwoRecord], partial: false });
    vi.mocked(deleteRecords).mockResolvedValue({ deleted: 1 });
    vi.mocked(writeMarkdown).mockImplementation(captureWrittenPaths(snapshots));
    vi.mocked(runSyncWithAutoSchedule).mockImplementationOnce(async (runSync) => {
      await runSync();
      await runSync();
    });

    await import('@/index.js');

    // Pass one wrote abc-123, then its delete succeeded, so the map handed to
    // pass two no longer carries it — the "settled" half of the split.
    expect(snapshots[1].has('abc-123')).toBe(false);
  });

  it('keeps an unsettled record in the written-path map so a later pass reuses its file', async () => {
    const { fetchAllRecords, markRecordsSynced } = await import('@/libs/records.js');
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { runSyncWithAutoSchedule } = await import('@/libs/scheduler.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    const snapshots: Array<Map<string, WrittenRecordState>> = [];
    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(mockSettings({ autoDelete: false }));
    // The mark-synced step fails both passes, so the record stays pending and is
    // re-fetched — exactly the case that used to drop a suffixed duplicate.
    vi.mocked(fetchAllRecords).mockResolvedValue({ ok: true, records: [mockRecord], partial: false });
    vi.mocked(markRecordsSynced).mockImplementation(markResultAll(MARK_FAILED));
    vi.mocked(writeMarkdown).mockImplementation(captureWrittenPaths(snapshots));
    vi.mocked(runSyncWithAutoSchedule).mockImplementationOnce(async (runSync) => {
      await runSync();
      await runSync();
    });

    await import('@/index.js');

    // Pass one wrote abc-123 and its mark-synced failed (unsettled), so pass two
    // still sees its path in the shared map and reuses the file.
    expect(snapshots[1].get('abc-123')?.path).toBe('/mock/output/abc-123.md');
    // The reused record must still flow through to the settle step each pass —
    // reuse that dropped it from writtenRecords would never converge.
    expect(markRecordsSynced).toHaveBeenCalledTimes(2);
    expect(markRecordsSynced).toHaveBeenNthCalledWith(1, [
      { uuid: 'abc-123', filePath: '/mock/output/abc-123.md' },
    ]);
    expect(markRecordsSynced).toHaveBeenNthCalledWith(2, [
      { uuid: 'abc-123', filePath: '/mock/output/abc-123.md' },
    ]);
  });

  it('forgets only the mark-synced record that succeeded, keeping the failed one for reuse', async () => {
    const secondRecord: Record = { uuid: 'def-456', title: 'Title 2', content: 'Two', createdAt: '2024-01-02T00:00:00Z' };
    const { fetchAllRecords, markRecordsSynced } = await import('@/libs/records.js');
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { runSyncWithAutoSchedule } = await import('@/libs/scheduler.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    const snapshots: Array<Map<string, WrittenRecordState>> = [];
    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(mockSettings({ autoDelete: false }));
    // Both records are fetched again next pass; only def-456's mark fails, so it
    // must stay in the map while abc-123 is forgotten — pins the index alignment
    // between the settled and failed filters over the bulk response.
    vi.mocked(fetchAllRecords).mockResolvedValue({ ok: true, records: [mockRecord, secondRecord], partial: false });
    vi.mocked(markRecordsSynced).mockImplementation(
      markResultBy((uuid) => (uuid === 'abc-123' ? MARK_SYNCED : MARK_FAILED)),
    );
    vi.mocked(writeMarkdown).mockImplementation(captureWrittenPaths(snapshots));
    vi.mocked(runSyncWithAutoSchedule).mockImplementationOnce(async (runSync) => {
      await runSync();
      await runSync();
    });

    await import('@/index.js');

    // Snapshots 0/1 are pass one (both records fresh, map empty). Snapshots 2/3
    // are pass two: abc-123 settled (forgotten), def-456 unsettled (retained).
    expect(snapshots[2].has('abc-123')).toBe(false);
    expect(snapshots[2].get('def-456')?.path).toBe('/mock/output/def-456.md');
  });

  it('retains all written paths when a delete settles fewer records than were written', async () => {
    const secondRecord: Record = { uuid: 'def-456', title: 'Title 2', content: 'Two', createdAt: '2024-01-02T00:00:00Z' };
    const { fetchAllRecords, deleteRecords } = await import('@/libs/records.js');
    const { writeMarkdown } = await import('@/libs/markdown.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { runSyncWithAutoSchedule } = await import('@/libs/scheduler.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    const snapshots: Array<Map<string, WrittenRecordState>> = [];
    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(mockSettings({ autoDelete: true }));
    vi.mocked(fetchAllRecords).mockResolvedValue({ ok: true, records: [mockRecord, secondRecord], partial: false });
    // Two records written but the server reports only one deleted — a bare count
    // can't say which survived, so no path may be forgotten or a still-pending
    // record would drop a suffixed duplicate next pass.
    vi.mocked(deleteRecords).mockResolvedValue({ deleted: 1 });
    vi.mocked(writeMarkdown).mockImplementation(captureWrittenPaths(snapshots));
    vi.mocked(runSyncWithAutoSchedule).mockImplementationOnce(async (runSync) => {
      await runSync();
      await runSync();
    });

    await import('@/index.js');

    // Pass two (snapshot index 2) still carries both uuids.
    expect(snapshots[2].has('abc-123')).toBe(true);
    expect(snapshots[2].has('def-456')).toBe(true);
  });

  describe('sync --dry-run', () => {
    const secondRecord: Record = { uuid: 'def-456', title: 'Title 2', content: 'Content 2', createdAt: '2024-01-02T00:00:00Z' };

    // Arranges a two-record dry run: fetch succeeds and the write preview
    // reports both records landing on fresh paths.
    const arrangeDryRun = async (settingsOverrides: Partial<UserSettings> = {}) => {
      const { fetchAllRecords } = await import('@/libs/records.js');
      const { buildWritePreview } = await import('@/libs/markdown.js');
      const { fetchSettings } = await import('@/libs/settings.js');
      const { default: yoctoSpinner } = await import('yocto-spinner');

      vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
      vi.mocked(fetchSettings).mockResolvedValue(mockSettings(settingsOverrides));
      vi.mocked(fetchAllRecords).mockResolvedValue({ ok: true, records: [mockRecord, secondRecord], partial: false });
      vi.mocked(buildWritePreview).mockReturnValue([
        { record: mockRecord, path: '/mock/output/test-title.md', action: 'write' },
        { record: secondRecord, path: '/mock/output/title-2.md', action: 'write' },
      ]);
    };

    it('writes nothing, deletes nothing, and marks nothing under --dry-run', async () => {
      process.argv = ['node', 'index.js', 'sync', '--dry-run'];
      const { fetchAllRecords, deleteRecords, markRecordsSynced } = await import('@/libs/records.js');
      const { writeMarkdown, ensureOutputDirectory, buildWritePreview } = await import('@/libs/markdown.js');
      await arrangeDryRun();

      await import('@/index.js');

      // The fetch (a read) still runs — the preview needs the real record set.
      expect(fetchAllRecords).toHaveBeenCalledWith({ status: 'pending' });
      expect(buildWritePreview).toHaveBeenCalledWith([mockRecord, secondRecord], 'suffix');
      // Every mutation path must be short-circuited.
      expect(writeMarkdown).not.toHaveBeenCalled();
      expect(ensureOutputDirectory).not.toHaveBeenCalled();
      expect(deleteRecords).not.toHaveBeenCalled();
      expect(markRecordsSynced).not.toHaveBeenCalled();
      expect(mockSpinner.start).not.toHaveBeenCalledWith('Writing records...');
      expect(mockSpinner.start).not.toHaveBeenCalledWith('Deleting records...');
      // A successful preview exits 0.
      expect(process.exitCode).toBeUndefined();
    });

    it('lists the intended writes and the server-side deletes under --dry-run', async () => {
      process.argv = ['node', 'index.js', 'sync', '--dry-run'];
      await arrangeDryRun({ autoDelete: true });

      await import('@/index.js');

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Dry run — previewing 2 record(s)'),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Would write 2 record(s):'),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('/mock/output/test-title.md (write)'),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('/mock/output/title-2.md (write)'),
      );
      // autoDelete on → the server plan is a delete, listing each record.
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Would delete 2 record(s) from the server:'),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('abc-123 (Test Title)'),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('def-456 (Title 2)'),
      );
    });

    it('previews a mark-synced (not a delete) when autoDelete is off', async () => {
      process.argv = ['node', 'index.js', 'sync', '--dry-run'];
      await arrangeDryRun({ autoDelete: false });

      await import('@/index.js');

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Would mark 2 record(s) synced on the server:'),
      );
      expect(console.log).not.toHaveBeenCalledWith(
        expect.stringContaining('Would delete'),
      );
    });

    it('excludes skipped records from the server-side plan under --dry-run', async () => {
      process.argv = ['node', 'index.js', 'sync', '--dry-run'];
      const { fetchAllRecords } = await import('@/libs/records.js');
      const { buildWritePreview } = await import('@/libs/markdown.js');
      const { fetchSettings } = await import('@/libs/settings.js');
      const { default: yoctoSpinner } = await import('yocto-spinner');

      vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
      vi.mocked(fetchSettings).mockResolvedValue(mockSettings({ autoDelete: true, conflictStrategy: 'skip' }));
      vi.mocked(fetchAllRecords).mockResolvedValue({ ok: true, records: [mockRecord, secondRecord], partial: false });
      vi.mocked(buildWritePreview).mockReturnValue([
        { record: mockRecord, path: '/mock/output/test-title.md', action: 'write' },
        { record: secondRecord, path: '/mock/output/title-2.md', action: 'skip' },
      ]);

      await import('@/index.js');

      // Only the one non-skipped record is written and (would be) deleted.
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Would write 1 record(s):'),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Would skip 1 record(s)'),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Would delete 1 record(s) from the server:'),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('abc-123 (Test Title)'),
      );
      expect(console.log).not.toHaveBeenCalledWith(
        expect.stringContaining('def-456 (Title 2)'),
      );
    });

    it('mutates nothing on the server preview when settings cannot be read', async () => {
      process.argv = ['node', 'index.js', 'sync', '--dry-run'];
      const { fetchAllRecords } = await import('@/libs/records.js');
      const { buildWritePreview } = await import('@/libs/markdown.js');
      const { fetchSettings } = await import('@/libs/settings.js');
      const { default: yoctoSpinner } = await import('yocto-spinner');

      vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
      vi.mocked(fetchSettings).mockResolvedValue({ ok: false });
      vi.mocked(fetchAllRecords).mockResolvedValue({ ok: true, records: [mockRecord], partial: false });
      vi.mocked(buildWritePreview).mockReturnValue([
        { record: mockRecord, path: '/mock/output/test-title.md', action: 'write' },
      ]);

      await import('@/index.js');

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Settings unreadable'),
      );
      expect(console.log).not.toHaveBeenCalledWith(
        expect.stringContaining('Would delete'),
      );
      expect(console.log).not.toHaveBeenCalledWith(
        expect.stringContaining('Would mark'),
      );
    });

    it('previews once and never self-schedules, even with autoSync on', async () => {
      process.argv = ['node', 'index.js', 'sync', '--dry-run'];
      const { runSyncWithAutoSchedule } = await import('@/libs/scheduler.js');
      let scheduledAutoSync: boolean | undefined;
      vi.mocked(runSyncWithAutoSchedule).mockImplementationOnce(async (runSync) => {
        scheduledAutoSync = await runSync();
      });
      await arrangeDryRun({ autoSync: true });

      await import('@/index.js');

      // A dry run reports back `false` so the scheduler won't loop a preview.
      expect(scheduledAutoSync).toBe(false);
    });

    it('still rejects an unexpected argument alongside --dry-run', async () => {
      process.argv = ['node', 'index.js', 'sync', '--dry-run', 'oops'];
      const { fetchAllRecords } = await import('@/libs/records.js');

      await import('@/index.js');

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Unexpected arguments: oops'),
      );
      expect(process.exitCode).toBe(1);
      expect(fetchAllRecords).not.toHaveBeenCalled();
    });
  });
});
