import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Record } from '@/types/records.types.js';

vi.mock('@/libs/config.js', () => ({ checkConfig: vi.fn() }));
vi.mock('@/libs/records.js', () => ({
  fetchAllRecords: vi.fn(),
  deleteRecords: vi.fn(),
}));
vi.mock('chalk', () => ({
  default: {
    redBright: vi.fn((value: unknown) => value),
    bold: vi.fn((value: unknown) => value),
    yellow: vi.fn((value: unknown) => value),
  },
}));

const firstRecord: Record = {
  uuid: 'abc-123',
  createdAt: '2024-01-01T00:00:00Z',
  title: 'First Record',
  content: 'First record content',
};

const secondRecord: Record = {
  uuid: 'def-456',
  createdAt: '2024-01-02T00:00:00Z',
  title: 'Second Record',
  content: 'Second record content',
};

describe('runRecordsCommand', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('always checks config before dispatching', async () => {
    const { checkConfig } = await import('@/libs/config.js');
    const { fetchAllRecords } = await import('@/libs/records.js');
    vi.mocked(fetchAllRecords).mockResolvedValue({
      ok: true,
      records: [],
      partial: false,
    });
    const { runRecordsCommand } = await import('@/commands/records.js');

    await runRecordsCommand(['list']);

    expect(checkConfig).toHaveBeenCalled();
  });

  it('never dispatches to list when checkConfig fails', async () => {
    const { checkConfig } = await import('@/libs/config.js');
    const { fetchAllRecords } = await import('@/libs/records.js');
    vi.mocked(checkConfig).mockRejectedValue(new Error('Missing API key'));
    const { runRecordsCommand } = await import('@/commands/records.js');

    await runRecordsCommand(['list']);

    expect(fetchAllRecords).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  it('errors to stderr and exits 1 when no subcommand is given', async () => {
    const { checkConfig } = await import('@/libs/config.js');
    const { fetchAllRecords } = await import('@/libs/records.js');
    const { runRecordsCommand } = await import('@/commands/records.js');

    await runRecordsCommand([]);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('No subcommand given.'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Usage: markpost records'),
    );
    expect(console.log).not.toHaveBeenCalled();
    expect(checkConfig).not.toHaveBeenCalled();
    expect(fetchAllRecords).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('errors to stderr and exits 1 for an unrecognized subcommand', async () => {
    const { checkConfig } = await import('@/libs/config.js');
    const { fetchAllRecords } = await import('@/libs/records.js');
    const { runRecordsCommand } = await import('@/commands/records.js');

    await runRecordsCommand(['bogus']);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Unknown subcommand: bogus'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Usage: markpost records'),
    );
    expect(console.log).not.toHaveBeenCalled();
    expect(checkConfig).not.toHaveBeenCalled();
    expect(fetchAllRecords).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  describe('list', () => {
    it('prints "No records found." when there are none', async () => {
      const { fetchAllRecords } = await import('@/libs/records.js');
      vi.mocked(fetchAllRecords).mockResolvedValue({
        ok: true,
        records: [],
        partial: false,
      });
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand(['list']);

      expect(console.log).toHaveBeenCalledWith('No records found.');
    });

    it('prints each fetched record', async () => {
      const { fetchAllRecords } = await import('@/libs/records.js');
      vi.mocked(fetchAllRecords).mockResolvedValue({
        ok: true,
        records: [firstRecord, secondRecord],
        partial: false,
      });
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand(['list']);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('First Record'),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('abc-123'),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Second Record'),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('def-456'),
      );
    });

    it('passes no filters through when no flags are given', async () => {
      const { fetchAllRecords } = await import('@/libs/records.js');
      vi.mocked(fetchAllRecords).mockResolvedValue({
        ok: true,
        records: [],
        partial: false,
      });
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand(['list']);

      expect(fetchAllRecords).toHaveBeenCalledWith({
        source: undefined,
        status: undefined,
        search: undefined,
      });
    });

    it('threads --source, --status, and --search into the fetch', async () => {
      const { fetchAllRecords } = await import('@/libs/records.js');
      vi.mocked(fetchAllRecords).mockResolvedValue({
        ok: true,
        records: [firstRecord],
        partial: false,
      });
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand([
        'list',
        '--source',
        'webhook',
        '--status',
        'pending',
        '--search',
        'meeting notes',
      ]);

      expect(fetchAllRecords).toHaveBeenCalledWith({
        source: 'webhook',
        status: 'pending',
        search: 'meeting notes',
      });
      // Assert the fetched record actually renders, so the test breaks if the
      // filter path stops reaching the print step (not just the fetch call).
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('First Record'),
      );
      expect(process.exitCode).not.toBe(1);
    });

    it('accepts the --flag=value form', async () => {
      const { fetchAllRecords } = await import('@/libs/records.js');
      vi.mocked(fetchAllRecords).mockResolvedValue({
        ok: true,
        records: [],
        partial: false,
      });
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand(['list', '--source=email']);

      expect(fetchAllRecords).toHaveBeenCalledWith({
        source: 'email',
        status: undefined,
        search: undefined,
      });
    });

    it('surfaces an error and never fetches when given an unknown flag', async () => {
      const { fetchAllRecords } = await import('@/libs/records.js');
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand(['list', '--bogus', 'value']);

      expect(fetchAllRecords).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('bogus'),
        }),
      );
      expect(process.exitCode).toBe(1);
    });

    it('rejects a present-but-empty filter value instead of listing everything', async () => {
      const { fetchAllRecords } = await import('@/libs/records.js');
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand(['list', '--source=']);

      expect(fetchAllRecords).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.objectContaining({
          message: '--source needs a non-empty value.',
        }),
      );
      expect(process.exitCode).toBe(1);
    });

    it('rejects a stray positional argument instead of listing everything', async () => {
      const { fetchAllRecords } = await import('@/libs/records.js');
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand(['list', 'webhook']);

      expect(fetchAllRecords).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Unexpected argument "webhook"'),
        }),
      );
      expect(process.exitCode).toBe(1);
    });

    it('rejects a filter flag passed more than once instead of silently last-winning', async () => {
      const { fetchAllRecords } = await import('@/libs/records.js');
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand([
        'list',
        '--source',
        'webhook',
        '--source',
        'email',
      ]);

      expect(fetchAllRecords).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.objectContaining({
          message: '--source was given more than once. Pass it only once.',
        }),
      );
      expect(process.exitCode).toBe(1);
    });

    it('rejects a whitespace-only filter value', async () => {
      const { fetchAllRecords } = await import('@/libs/records.js');
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand(['list', '--source', '   ']);

      expect(fetchAllRecords).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.objectContaining({
          message: '--source needs a non-empty value.',
        }),
      );
      expect(process.exitCode).toBe(1);
    });

    it('trims surrounding whitespace from a filter value before sending it', async () => {
      const { fetchAllRecords } = await import('@/libs/records.js');
      vi.mocked(fetchAllRecords).mockResolvedValue({
        ok: true,
        records: [],
        partial: false,
      });
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand(['list', '--search', '  meeting notes  ']);

      expect(fetchAllRecords).toHaveBeenCalledWith({
        source: undefined,
        status: undefined,
        search: 'meeting notes',
      });
    });

    it('surfaces an error and never fetches when a flag is missing its value', async () => {
      const { fetchAllRecords } = await import('@/libs/records.js');
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand(['list', '--search']);

      expect(fetchAllRecords).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('search'),
        }),
      );
      expect(process.exitCode).toBe(1);
    });

    it('never deletes the records it lists', async () => {
      const { fetchAllRecords, deleteRecords } = await import(
        '@/libs/records.js'
      );
      vi.mocked(fetchAllRecords).mockResolvedValue({
        ok: true,
        records: [firstRecord, secondRecord],
        partial: false,
      });
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand(['list']);

      expect(deleteRecords).not.toHaveBeenCalled();
    });

    // A failed fetch (`ok: false`) must not print "No records found." — it has
    // to surface loudly and exit non-zero, distinct from an empty account.
    it('fails loud and exits non-zero when the fetch fails', async () => {
      const { fetchAllRecords } = await import('@/libs/records.js');
      vi.mocked(fetchAllRecords).mockResolvedValue({ ok: false });
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand(['list']);

      expect(console.log).not.toHaveBeenCalledWith('No records found.');
      // Assert the specific fetch-failure message, not a bare console.error
      // call any other throw in the command would also satisfy.
      expect(console.error).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Failed to fetch records from the server.',
        }),
      );
      expect(process.exitCode).toBe(1);
    });

    // A partial read (a later page failed) must still print what was fetched
    // but warn it may be incomplete and exit non-zero — never present a
    // truncated list as the full set.
    it('warns and exits non-zero on a partial read, still printing what it got', async () => {
      const { fetchAllRecords } = await import('@/libs/records.js');
      vi.mocked(fetchAllRecords).mockResolvedValue({
        ok: true,
        records: [firstRecord],
        partial: true,
      });
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand(['list']);

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('this list may be incomplete'),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('First Record'),
      );
      expect(process.exitCode).toBe(1);
    });

    // A partial read that returned zero records must not claim "No records
    // found." — the read failed before any page came back, not an empty account.
    it('does not print "No records found." on a partial read with no records', async () => {
      const { fetchAllRecords } = await import('@/libs/records.js');
      vi.mocked(fetchAllRecords).mockResolvedValue({
        ok: true,
        records: [],
        partial: true,
      });
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand(['list']);

      expect(console.log).not.toHaveBeenCalledWith('No records found.');
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('the read failed partway through'),
      );
      expect(process.exitCode).toBe(1);
    });
  });

  it('surfaces a fetch error instead of throwing', async () => {
    const { fetchAllRecords, deleteRecords } = await import(
      '@/libs/records.js'
    );
    vi.mocked(fetchAllRecords).mockRejectedValue(new Error('Network error'));
    const { runRecordsCommand } = await import('@/commands/records.js');

    await runRecordsCommand(['list']);

    expect(console.error).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Network error' }),
    );
    expect(deleteRecords).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
