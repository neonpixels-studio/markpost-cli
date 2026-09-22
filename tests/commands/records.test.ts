import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ERROR_STATUS } from '@/libs/records.js';
import { Record } from '@/types/records.types.js';

vi.mock('@/libs/config.js', () => ({ checkConfig: vi.fn() }));
vi.mock('@/libs/records.js', async () => {
  // Pulls the real ERROR_STATUS through (via importActual, not a full-module
  // spread) rather than restating the literal, so these tests stay pinned to
  // the actual constant instead of drifting from it if it's ever renamed —
  // while keeping every other export undefined, so a command that starts
  // calling an unmocked function still fails loudly here instead of quietly
  // running the real implementation.
  const { ERROR_STATUS } =
    await vi.importActual<typeof import('@/libs/records.js')>(
      '@/libs/records.js',
    );

  return { ERROR_STATUS, fetchAllRecords: vi.fn(), deleteRecords: vi.fn() };
});
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
  status: 'synced',
  syncedAt: '2024-01-03T00:00:00Z',
};

const secondRecord: Record = {
  uuid: 'def-456',
  createdAt: '2024-01-02T00:00:00Z',
  title: 'Second Record',
  content: 'Second record content',
  status: 'pending',
};

describe('runRecordsCommand', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
    // resetAllMocks strips the default implementation, so re-pin checkConfig to
    // a passing resolve; failure-path tests override with mockRejectedValue.
    const { checkConfig } = await import('@/libs/config.js');
    vi.mocked(checkConfig).mockResolvedValue(true);
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

    expect(checkConfig).toHaveBeenCalledWith(false);
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

  // checkConfig now signals failure by resolving false (diagnostic already
  // emitted, exitCode set) rather than throwing, so list must not run.
  it('never dispatches to list when checkConfig resolves false', async () => {
    const { checkConfig } = await import('@/libs/config.js');
    vi.mocked(checkConfig).mockResolvedValueOnce(false);
    const { fetchAllRecords } = await import('@/libs/records.js');
    const { runRecordsCommand } = await import('@/commands/records.js');

    await runRecordsCommand(['list']);

    expect(fetchAllRecords).not.toHaveBeenCalled();
    // checkConfig owns the diagnostic on the false path, so the command emits
    // nothing — distinguishing a false return from a thrown checkConfig.
    expect(console.error).not.toHaveBeenCalled();
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

    it("prints each record's status, and syncedAt when present", async () => {
      const { fetchAllRecords } = await import('@/libs/records.js');
      vi.mocked(fetchAllRecords).mockResolvedValue({
        ok: true,
        records: [firstRecord, secondRecord],
        partial: false,
      });
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand(['list']);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('status:     synced'),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('synced at:  2024-01-03T00:00:00Z'),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('status:     pending'),
      );
    });

    // syncedAt is null until a record is first written to disk, so a pending
    // record must not print a blank "synced at:" line.
    it('omits the synced at line for a record without syncedAt', async () => {
      const { fetchAllRecords } = await import('@/libs/records.js');
      vi.mocked(fetchAllRecords).mockResolvedValue({
        ok: true,
        records: [secondRecord],
        partial: false,
      });
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand(['list']);

      const printedSyncedAt = vi
        .mocked(console.log)
        .mock.calls.some(
          ([arg]) => typeof arg === 'string' && arg.includes('synced at:'),
        );
      expect(printedSyncedAt).toBe(false);
    });

    it('includes status and syncedAt in the --json output', async () => {
      const { fetchAllRecords } = await import('@/libs/records.js');
      vi.mocked(fetchAllRecords).mockResolvedValue({
        ok: true,
        records: [firstRecord],
        partial: false,
      });
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand(['list', '--json']);

      const output = vi.mocked(console.log).mock.calls.at(-1)?.[0] as string;
      expect(JSON.parse(output)[0]).toMatchObject({
        status: 'synced',
        syncedAt: '2024-01-03T00:00:00Z',
      });
    });

    it("prints an error-status record's errorMessage", async () => {
      const { fetchAllRecords } = await import('@/libs/records.js');
      const erroredRecord: Record = {
        ...secondRecord,
        status: ERROR_STATUS,
        errorMessage: 'Sync failed: file already exists',
      };
      vi.mocked(fetchAllRecords).mockResolvedValue({
        ok: true,
        records: [firstRecord, erroredRecord],
        partial: false,
      });
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand(['list']);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('error:      Sync failed: file already exists'),
      );
    });

    // Neither record has ever errored (the common case), so neither prints a
    // blank "error:" line.
    it('omits the error line for records without errorMessage', async () => {
      const { fetchAllRecords } = await import('@/libs/records.js');
      vi.mocked(fetchAllRecords).mockResolvedValue({
        ok: true,
        records: [firstRecord, secondRecord],
        partial: false,
      });
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand(['list']);

      const printedError = vi
        .mocked(console.log)
        .mock.calls.some(
          ([arg]) => typeof arg === 'string' && /^ {2}error: {6}/.test(arg),
        );
      expect(printedError).toBe(false);
    });

    // Exercises the OTHER half of the gate: an error-status record whose
    // errorMessage happens to be null must not print a blank "error:" line
    // either — `status === ERROR_STATUS` alone isn't enough.
    it('omits the error line for an error-status record with no errorMessage', async () => {
      const { fetchAllRecords } = await import('@/libs/records.js');
      const erroredWithNoMessage: Record = {
        ...secondRecord,
        status: ERROR_STATUS,
        errorMessage: null,
      };
      vi.mocked(fetchAllRecords).mockResolvedValue({
        ok: true,
        records: [erroredWithNoMessage],
        partial: false,
      });
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand(['list']);

      const printedError = vi
        .mocked(console.log)
        .mock.calls.some(
          ([arg]) => typeof arg === 'string' && /^ {2}error: {6}/.test(arg),
        );
      expect(printedError).toBe(false);
    });

    // markpost's PATCH endpoint only clears errorMessage when a caller
    // explicitly sends `null` for it, so a record that has since synced can
    // still carry a stale errorMessage from an earlier failure. The error
    // line must gate on the record's CURRENT status, not on errorMessage
    // alone, or a resolved failure would print as if it were still live.
    it('omits the error line for a synced record with a stale errorMessage', async () => {
      const { fetchAllRecords } = await import('@/libs/records.js');
      const staleRecord: Record = {
        ...firstRecord,
        status: 'synced',
        errorMessage: 'Sync failed: file already exists',
      };
      vi.mocked(fetchAllRecords).mockResolvedValue({
        ok: true,
        records: [staleRecord],
        partial: false,
      });
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand(['list']);

      const printedError = vi
        .mocked(console.log)
        .mock.calls.some(
          ([arg]) => typeof arg === 'string' && /^ {2}error: {6}/.test(arg),
        );
      expect(printedError).toBe(false);
    });

    it('includes errorMessage in the --json output', async () => {
      const { fetchAllRecords } = await import('@/libs/records.js');
      const erroredRecord: Record = {
        ...secondRecord,
        status: ERROR_STATUS,
        errorMessage: 'Sync failed: file already exists',
      };
      vi.mocked(fetchAllRecords).mockResolvedValue({
        ok: true,
        records: [erroredRecord],
        partial: false,
      });
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand(['list', '--json']);

      const output = vi.mocked(console.log).mock.calls.at(-1)?.[0] as string;
      expect(JSON.parse(output)[0]).toMatchObject({
        errorMessage: 'Sync failed: file already exists',
      });
    });

    it('strips control characters from untrusted record fields before printing', async () => {
      // ESC (0x1b) built via fromCharCode so no raw control byte lives in source.
      const control = String.fromCharCode(0x1b);
      const evilRecord: Record = {
        uuid: `id${control}1`,
        createdAt: `2024${control}01`,
        title: `A${control}B`,
        content: 'irrelevant',
        status: ERROR_STATUS,
        errorMessage: `Sync ${control}failed`,
      };
      const { fetchAllRecords } = await import('@/libs/records.js');
      vi.mocked(fetchAllRecords).mockResolvedValue({
        ok: true,
        records: [evilRecord],
        partial: false,
      });
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand(['list']);

      const printedControl = vi
        .mocked(console.log)
        .mock.calls.some(
          ([arg]) => typeof arg === 'string' && arg.includes(control),
        );
      expect(printedControl).toBe(false);
      expect(console.log).toHaveBeenCalledWith('A B');
      // sanitizeForTerminal replaces the stripped control byte with a space
      // rather than deleting it, hence the double space before "failed".
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('error:      Sync  failed'),
      );
    });

    it('prints the records as a parseable JSON array with --json', async () => {
      const { checkConfig } = await import('@/libs/config.js');
      const { fetchAllRecords } = await import('@/libs/records.js');
      vi.mocked(fetchAllRecords).mockResolvedValue({
        ok: true,
        records: [firstRecord, secondRecord],
        partial: false,
      });
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand(['list', '--json']);

      // --json must reach checkConfig so it fails loud instead of prompting on
      // stdout on an unconfigured machine.
      expect(checkConfig).toHaveBeenCalledWith(true);
      // Exactly one stdout write, so a future stray console.log before the
      // payload breaks the test instead of hiding in earlier calls.
      expect(console.log).toHaveBeenCalledTimes(1);
      const output = vi.mocked(console.log).mock.calls.at(-1)?.[0] as string;
      const parsed = JSON.parse(output);
      expect(parsed).toHaveLength(2);
      expect(parsed[0]).toMatchObject({
        uuid: 'abc-123',
        title: 'First Record',
      });
      expect(parsed[1]).toMatchObject({
        uuid: 'def-456',
        title: 'Second Record',
      });
    });

    it('still threads filters through when --json is passed', async () => {
      const { fetchAllRecords } = await import('@/libs/records.js');
      vi.mocked(fetchAllRecords).mockResolvedValue({
        ok: true,
        records: [firstRecord],
        partial: false,
      });
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand(['list', '--source', 'webhook', '--json']);

      expect(fetchAllRecords).toHaveBeenCalledWith({
        source: 'webhook',
        status: undefined,
        search: undefined,
      });
      const output = vi.mocked(console.log).mock.calls.at(-1)?.[0] as string;
      expect(JSON.parse(output)).toHaveLength(1);
    });

    it('prints an empty JSON array (not "No records found.") for --json with no records', async () => {
      const { fetchAllRecords } = await import('@/libs/records.js');
      vi.mocked(fetchAllRecords).mockResolvedValue({
        ok: true,
        records: [],
        partial: false,
      });
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand(['list', '--json']);

      expect(console.log).not.toHaveBeenCalledWith('No records found.');
      const output = vi.mocked(console.log).mock.calls.at(-1)?.[0] as string;
      expect(JSON.parse(output)).toEqual([]);
    });

    // A partial read must keep stdout valid JSON (jq-safe): the warning goes to
    // stderr only, and the command still exits non-zero.
    it('writes clean JSON to stdout on a partial read, warning only on stderr', async () => {
      const { fetchAllRecords } = await import('@/libs/records.js');
      vi.mocked(fetchAllRecords).mockResolvedValue({
        ok: true,
        records: [firstRecord],
        partial: true,
      });
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand(['list', '--json']);

      const output = vi.mocked(console.log).mock.calls.at(-1)?.[0] as string;
      expect(JSON.parse(output)).toHaveLength(1);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('this list may be incomplete'),
      );
      expect(process.exitCode).toBe(1);
    });

    // Under --json the stderr warning must itself be the single JSON error
    // object the rest of the JSON failure contract uses (issue #194) — not a
    // plain-text chalk line, which would choke a script parsing stderr as
    // JSON.
    it('emits a single JSON error object on stderr on a partial read under --json', async () => {
      const { fetchAllRecords } = await import('@/libs/records.js');
      vi.mocked(fetchAllRecords).mockResolvedValue({
        ok: true,
        records: [firstRecord],
        partial: true,
      });
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand(['list', '--json']);

      expect(console.error).toHaveBeenCalledTimes(1);
      const errorOutput = vi.mocked(console.error).mock.calls[0][0] as string;
      expect(() => JSON.parse(errorOutput)).not.toThrow();
      expect(JSON.parse(errorOutput)).toEqual({
        error: 'fetch_failed',
        message: expect.stringContaining('this list may be incomplete'),
      });
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
      const { checkConfig } = await import('@/libs/config.js');
      const { fetchAllRecords } = await import('@/libs/records.js');
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand(['list', '--bogus', 'value']);

      // A bad flag must fail on usage before checkConfig runs, since checkConfig
      // prompts for and persists an API token/output directory when unset.
      expect(checkConfig).not.toHaveBeenCalled();
      expect(fetchAllRecords).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('bogus'),
      );
      expect(process.exitCode).toBe(1);
    });

    // The non-JSON path changed too: a bad flag used to print bare prose via
    // failWithMessage and now goes through failWithUsage, so the usage block
    // must print alongside the message.
    it('prints the usage block, not bare prose, for an unknown flag without --json', async () => {
      const { runRecordsCommand, USAGE } =
        await import('@/commands/records.js');

      await runRecordsCommand(['list', '--bogus', 'value']);

      expect(console.error).toHaveBeenCalledWith(USAGE);
      expect(process.exitCode).toBe(1);
    });

    it('rejects a present-but-empty filter value instead of listing everything', async () => {
      const { fetchAllRecords } = await import('@/libs/records.js');
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand(['list', '--source=']);

      expect(fetchAllRecords).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('--source needs a non-empty value.'),
      );
      expect(process.exitCode).toBe(1);
    });

    it('rejects a stray positional argument instead of listing everything', async () => {
      const { fetchAllRecords } = await import('@/libs/records.js');
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand(['list', 'webhook']);

      expect(fetchAllRecords).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Unexpected argument "webhook"'),
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
        expect.stringContaining(
          '--source was given more than once. Pass it only once.',
        ),
      );
      expect(process.exitCode).toBe(1);
    });

    it('rejects a whitespace-only filter value', async () => {
      const { fetchAllRecords } = await import('@/libs/records.js');
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand(['list', '--source', '   ']);

      expect(fetchAllRecords).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('--source needs a non-empty value.'),
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
        expect.stringContaining('search'),
      );
      expect(process.exitCode).toBe(1);
    });

    it('never deletes the records it lists', async () => {
      const { fetchAllRecords, deleteRecords } =
        await import('@/libs/records.js');
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
      // call any other throw in the command would also satisfy. The command
      // now prints the composed message string (see describeApiError), not the
      // raw Error object.
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to fetch records from the server.'),
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
    const { fetchAllRecords, deleteRecords } =
      await import('@/libs/records.js');
    vi.mocked(fetchAllRecords).mockRejectedValue(new Error('Network error'));
    const { runRecordsCommand } = await import('@/commands/records.js');

    await runRecordsCommand(['list']);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Network error'),
    );
    expect(deleteRecords).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  // A systemic auth failure (expired token) now re-throws from fetchAllRecords
  // and must surface its classified, actionable message with a non-zero exit —
  // never masquerade as "No records found." (issue #89).
  it('surfaces a systemic auth failure with a classified message and non-zero exit', async () => {
    const { fetchAllRecords } = await import('@/libs/records.js');
    const { ApiRequestError } = await import('@/libs/api.js');
    vi.mocked(fetchAllRecords).mockRejectedValue(
      new ApiRequestError('Invalid or missing API token', 401),
    );
    const { runRecordsCommand } = await import('@/commands/records.js');

    await runRecordsCommand(['list']);

    expect(console.log).not.toHaveBeenCalledWith('No records found.');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Authentication failed (HTTP 401)'),
    );
    expect(process.exitCode).toBe(1);
  });

  // The unified --json failure contract: a bad subcommand and a thrown fetch
  // failure both surface as one parseable { error, message } shape on stderr.
  describe('--json failure contract', () => {
    it('emits a usage-coded JSON error for an unknown subcommand', async () => {
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand(['bogus', '--json']);

      const parsed = JSON.parse(
        vi.mocked(console.error).mock.calls[0][0] as string,
      );
      expect(parsed).toEqual({
        error: 'usage',
        message: 'Unknown subcommand: bogus',
      });
      expect(process.exitCode).toBe(1);
    });

    it('emits a fetch_failed JSON error on stderr for a thrown fetch failure', async () => {
      const { fetchAllRecords } = await import('@/libs/records.js');
      const { ApiRequestError } = await import('@/libs/api.js');
      vi.mocked(fetchAllRecords).mockRejectedValue(
        new ApiRequestError('Invalid or missing API token', 401),
      );
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand(['list', '--json']);

      const parsed = JSON.parse(
        vi.mocked(console.error).mock.calls[0][0] as string,
      );
      expect(parsed.error).toBe('fetch_failed');
      expect(parsed.message).toContain('Authentication failed (HTTP 401)');
      expect(process.exitCode).toBe(1);
    });

    // A bad flag/stray argument on `list` must report the documented `usage`
    // code, not `fetch_failed` — argument parsing used to share the fetch's
    // try/catch, miscoding it (issue #184).
    it('emits a usage-coded JSON error, not fetch_failed, for an unknown flag on list', async () => {
      const { checkConfig } = await import('@/libs/config.js');
      const { fetchAllRecords } = await import('@/libs/records.js');
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand(['list', '--bogus', 'value', '--json']);

      const parsed = JSON.parse(
        vi.mocked(console.error).mock.calls[0][0] as string,
      );
      expect(parsed.error).toBe('usage');
      expect(parsed.message).toContain('bogus');
      expect(checkConfig).not.toHaveBeenCalled();
      expect(fetchAllRecords).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it('emits a usage-coded JSON error, not fetch_failed, for a stray positional on list', async () => {
      const { checkConfig } = await import('@/libs/config.js');
      const { fetchAllRecords } = await import('@/libs/records.js');
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand(['list', 'webhook', '--json']);

      const parsed = JSON.parse(
        vi.mocked(console.error).mock.calls[0][0] as string,
      );
      expect(parsed.error).toBe('usage');
      expect(parsed.message).toContain('Unexpected argument "webhook"');
      expect(checkConfig).not.toHaveBeenCalled();
      expect(fetchAllRecords).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    // normalizeFilter (a third usage-throw site inside the same try, distinct
    // from parseArgs' own throws above) must also route through the `usage`
    // code rather than `fetch_failed` — guards against a future refactor that
    // moves this validation elsewhere and reintroduces the miscode.
    it('emits a usage-coded JSON error, not fetch_failed, for a present-but-empty filter value', async () => {
      const { checkConfig } = await import('@/libs/config.js');
      const { fetchAllRecords } = await import('@/libs/records.js');
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand(['list', '--source=', '--json']);

      const parsed = JSON.parse(
        vi.mocked(console.error).mock.calls[0][0] as string,
      );
      expect(parsed.error).toBe('usage');
      expect(parsed.message).toContain('--source needs a non-empty value.');
      expect(checkConfig).not.toHaveBeenCalled();
      expect(fetchAllRecords).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it('emits a usage-coded JSON error, not fetch_failed, for a filter flag passed more than once', async () => {
      const { checkConfig } = await import('@/libs/config.js');
      const { fetchAllRecords } = await import('@/libs/records.js');
      const { runRecordsCommand } = await import('@/commands/records.js');

      await runRecordsCommand([
        'list',
        '--source',
        'webhook',
        '--source',
        'email',
        '--json',
      ]);

      const parsed = JSON.parse(
        vi.mocked(console.error).mock.calls[0][0] as string,
      );
      expect(parsed.error).toBe('usage');
      expect(parsed.message).toContain('was given more than once');
      expect(checkConfig).not.toHaveBeenCalled();
      expect(fetchAllRecords).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });
  });
});
