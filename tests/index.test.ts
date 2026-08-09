import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Record } from '@/types/records.types.js';
import { UserSettings } from '@/types/settings.types.js';
import { SettingsReadResult } from '@/libs/settings.js';

vi.mock('@/libs/config.js', () => ({ checkConfig: vi.fn() }));
vi.mock('@/libs/records.js', () => ({
  fetchAllRecords: vi.fn(),
  deleteRecords: vi.fn(),
  markRecordSynced: vi.fn(),
  PENDING_STATUS: 'pending',
}));
vi.mock('@/libs/markdown.js', () => ({
  writeMarkdown: vi.fn(),
  ensureOutputDirectory: vi.fn(),
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

describe('index', () => {
  let mockSpinner: { start: ReturnType<typeof vi.fn>; success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockSpinner = { start: vi.fn(), success: vi.fn(), error: vi.fn() };
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
    expect(writeMarkdown).toHaveBeenCalledWith(mockRecord, 'suffix', expect.any(Set), true);
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
    expect(writeMarkdown).toHaveBeenCalledWith(mockRecord, 'suffix', expect.any(Set), true);
    expect(writeMarkdown).toHaveBeenCalledWith(mockRecord2, 'suffix', expect.any(Set), true);
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
      expect.any(Set),
      true,
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
    const { fetchAllRecords, deleteRecords, markRecordSynced } = await import(
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

    expect(writeMarkdown).toHaveBeenCalledWith(mockRecord, 'suffix', expect.any(Set), true);
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
    expect(markRecordSynced).not.toHaveBeenCalled();
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

    expect(writeMarkdown).toHaveBeenCalledWith(mockRecord, 'overwrite', expect.any(Set), true);
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

    expect(writeMarkdown).toHaveBeenCalledWith(mockRecord, 'suffix', expect.any(Set), true);
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
      expect.any(Set),
      false,
    );
  });

  it('drives the default sync through the auto-sync scheduler', async () => {
    const { fetchAllRecords } = await import('@/libs/records.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    const { runSyncWithAutoSchedule } = await import('@/libs/scheduler.js');
    const { default: yoctoSpinner } = await import('yocto-spinner');

    vi.mocked(yoctoSpinner).mockReturnValue(mockSpinner);
    vi.mocked(fetchSettings).mockResolvedValue(mockSettings());
    vi.mocked(fetchAllRecords).mockResolvedValue([]);

    await import('@/index.js');

    expect(runSyncWithAutoSchedule).toHaveBeenCalledWith(expect.any(Function));
  });

  it('marks records synced (not deleted) when autoDelete is false', async () => {
    const { fetchAllRecords, deleteRecords, markRecordSynced } = await import(
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
    vi.mocked(markRecordSynced).mockResolvedValue(true);

    await import('@/index.js');

    expect(mockSpinner.success).toHaveBeenCalledWith('Wrote 1 records!');
    expect(mockSpinner.start).not.toHaveBeenCalledWith('Deleting records...');
    expect(deleteRecords).not.toHaveBeenCalled();
    // The whole fix for #50: written records must be marked synced so the next
    // pending-only fetch skips them instead of re-writing duplicates.
    expect(mockSpinner.start).toHaveBeenCalledWith('Marking records synced...');
    expect(markRecordSynced).toHaveBeenCalledWith(
      'abc-123',
      '/mock/output/test-title.md',
    );
    expect(mockSpinner.success).toHaveBeenCalledWith('Marked 1 records synced!');
  });

  it('marks every written record synced, not just the first', async () => {
    const mockRecord2: Record = { uuid: 'def-456', title: 'Title 2', content: 'Content 2', createdAt: '2024-01-02T00:00:00Z' };
    const { fetchAllRecords, markRecordSynced } = await import(
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
    vi.mocked(markRecordSynced).mockResolvedValue(true);

    await import('@/index.js');

    expect(markRecordSynced).toHaveBeenCalledTimes(2);
    expect(markRecordSynced).toHaveBeenCalledWith(
      'abc-123',
      '/mock/output/test-title.md',
    );
    expect(markRecordSynced).toHaveBeenCalledWith(
      'def-456',
      '/mock/output/title-2.md',
    );
    expect(mockSpinner.success).toHaveBeenCalledWith('Marked 2 records synced!');
  });

  it('excludes skipped records (null write result) from the mark-synced calls', async () => {
    const mockRecord2: Record = { uuid: 'def-456', title: 'Title 2', content: 'Content 2', createdAt: '2024-01-02T00:00:00Z' };
    const { fetchAllRecords, markRecordSynced } = await import(
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
    vi.mocked(markRecordSynced).mockResolvedValue(true);

    await import('@/index.js');

    expect(markRecordSynced).toHaveBeenCalledTimes(1);
    expect(markRecordSynced).toHaveBeenCalledWith(
      'abc-123',
      '/mock/output/test-title.md',
    );
  });

  it('does not mark synced when every record was skipped', async () => {
    const mockRecord2: Record = { uuid: 'def-456', title: 'Title 2', content: 'Content 2', createdAt: '2024-01-02T00:00:00Z' };
    const { fetchAllRecords, markRecordSynced } = await import(
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
    expect(markRecordSynced).not.toHaveBeenCalled();
  });

  it('reports a mark-synced failure loudly instead of claiming success', async () => {
    const { fetchAllRecords, markRecordSynced } = await import(
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
    vi.mocked(markRecordSynced).mockResolvedValue(false);

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
    const { fetchAllRecords, markRecordSynced } = await import(
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
    // First record succeeds, second fails — the count and the listed path must
    // reflect exactly the one failure, guarding against an off-by-one.
    vi.mocked(markRecordSynced)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

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

  it('marks records across multiple concurrency batches and pinpoints a failure in a later batch', async () => {
    const records: Record[] = Array.from({ length: 11 }, (_item, index) => ({
      uuid: `uuid-${index}`,
      title: `Title ${index}`,
      content: `Content ${index}`,
      createdAt: '2024-01-01T00:00:00Z',
    }));
    const { fetchAllRecords, markRecordSynced } = await import(
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
    // Only the 11th record (in the second batch, since concurrency is 10)
    // fails, exercising the slice/order arithmetic across batches.
    vi.mocked(markRecordSynced).mockImplementation((uuid: string) =>
      Promise.resolve(uuid !== 'uuid-10'),
    );

    await import('@/index.js');

    expect(markRecordSynced).toHaveBeenCalledTimes(11);
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

  it('warns the sync was incomplete on the mark-synced path when a page failed', async () => {
    const { fetchAllRecords, markRecordSynced } = await import(
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
    vi.mocked(markRecordSynced).mockResolvedValue(true);

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
    const { fetchAllRecords, markRecordSynced } = await import(
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
    vi.mocked(markRecordSynced).mockResolvedValue(false);

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
    const { fetchAllRecords, deleteRecords, markRecordSynced } = await import(
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
    expect(markRecordSynced).not.toHaveBeenCalled();
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
      expect.any(Set),
      true,
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Could not read settings'),
    );
    expect(deleteRecords).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});
