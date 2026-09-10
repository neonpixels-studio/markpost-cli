import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Event } from '@/types/events.types.js';

vi.mock('@/libs/config.js', () => ({ checkConfig: vi.fn() }));
vi.mock('@/libs/events.js', () => ({ fetchAllEvents: vi.fn() }));
vi.mock('chalk', () => ({
  default: {
    redBright: vi.fn((value: unknown) => value),
    yellow: vi.fn((value: unknown) => value),
    green: vi.fn((value: unknown) => value),
    dim: vi.fn((value: unknown) => value),
    bold: vi.fn((value: unknown) => value),
  },
}));

const okEvent: Event = {
  id: 'evt-1',
  userId: 'user-1',
  ts: '2024-01-01T00:00:00Z',
  kind: 'ok',
  message: 'Ingested record from webhook',
  recordUuid: 'rec-1',
  sourceId: 'src-1',
};

const errEvent: Event = {
  id: 'evt-2',
  userId: 'user-1',
  ts: '2024-01-02T00:00:00Z',
  kind: 'err',
  message: 'Signature verification failed',
  recordUuid: null,
  sourceId: 'src-1',
};

describe('runEventsCommand', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
    // resetAllMocks strips the default implementation, so re-pin checkConfig
    // to a passing resolve; failure-path tests override it.
    const { checkConfig } = await import('@/libs/config.js');
    vi.mocked(checkConfig).mockResolvedValue(true);
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('always checks config before dispatching', async () => {
    const { checkConfig } = await import('@/libs/config.js');
    const { fetchAllEvents } = await import('@/libs/events.js');
    vi.mocked(fetchAllEvents).mockResolvedValue({
      ok: true,
      events: [],
      partial: false,
    });
    const { runEventsCommand } = await import('@/commands/events.js');

    await runEventsCommand(['list']);

    expect(checkConfig).toHaveBeenCalledWith(false);
  });

  it('never dispatches to list when checkConfig resolves false', async () => {
    const { checkConfig } = await import('@/libs/config.js');
    vi.mocked(checkConfig).mockResolvedValueOnce(false);
    const { fetchAllEvents } = await import('@/libs/events.js');
    const { runEventsCommand } = await import('@/commands/events.js');

    await runEventsCommand(['list']);

    expect(fetchAllEvents).not.toHaveBeenCalled();
  });

  it('errors to stderr and exits 1 when no subcommand is given', async () => {
    const { fetchAllEvents } = await import('@/libs/events.js');
    const { runEventsCommand } = await import('@/commands/events.js');

    await runEventsCommand([]);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('No subcommand given.'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Usage: markpost events'),
    );
    expect(fetchAllEvents).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('errors to stderr and exits 1 for an unrecognized subcommand', async () => {
    const { runEventsCommand } = await import('@/commands/events.js');

    await runEventsCommand(['bogus']);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Unknown subcommand: bogus'),
    );
    expect(process.exitCode).toBe(1);
  });

  describe('list', () => {
    it('prints "No events found." when the log is empty', async () => {
      const { fetchAllEvents } = await import('@/libs/events.js');
      vi.mocked(fetchAllEvents).mockResolvedValue({
        ok: true,
        events: [],
        partial: false,
      });
      const { runEventsCommand } = await import('@/commands/events.js');

      await runEventsCommand(['list']);

      expect(console.log).toHaveBeenCalledWith('No events found.');
    });

    it('prints each fetched event, including source and record when present', async () => {
      const { fetchAllEvents } = await import('@/libs/events.js');
      vi.mocked(fetchAllEvents).mockResolvedValue({
        ok: true,
        events: [okEvent, errEvent],
        partial: false,
      });
      const { runEventsCommand } = await import('@/commands/events.js');

      await runEventsCommand(['list']);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Ingested record from webhook'),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('source: src-1'),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('record: rec-1'),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Signature verification failed'),
      );
    });

    it('colors each kind through its dedicated chalk function', async () => {
      const chalk = (await import('chalk')).default;
      const { fetchAllEvents } = await import('@/libs/events.js');
      vi.mocked(fetchAllEvents).mockResolvedValue({
        ok: true,
        events: [okEvent, errEvent],
        partial: false,
      });
      const { runEventsCommand } = await import('@/commands/events.js');

      await runEventsCommand(['list']);

      expect(chalk.green).toHaveBeenCalledWith('OK');
      expect(chalk.redBright).toHaveBeenCalledWith('ERR');
    });

    it('leaves an off-contract kind uncolored instead of failing', async () => {
      const chalk = (await import('chalk')).default;
      const offContractEvent: Event = {
        id: 'evt-4',
        userId: 'user-1',
        ts: '2024-01-04T00:00:00Z',
        kind: 'mystery',
        message: 'Unknown kind from an off-contract response',
        recordUuid: null,
        sourceId: null,
      };
      const { fetchAllEvents } = await import('@/libs/events.js');
      vi.mocked(fetchAllEvents).mockResolvedValue({
        ok: true,
        events: [offContractEvent],
        partial: false,
      });
      const { runEventsCommand } = await import('@/commands/events.js');

      await runEventsCommand(['list']);

      expect(chalk.green).not.toHaveBeenCalled();
      expect(chalk.yellow).not.toHaveBeenCalled();
      expect(chalk.redBright).not.toHaveBeenCalled();
      expect(chalk.dim).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('MYSTERY'),
      );
    });

    // A non-string kind (an off-contract response) must not crash the whole
    // list via a bare `.toUpperCase()` call.
    it('does not crash on a non-string kind', async () => {
      const malformedEvent = {
        id: 'evt-5',
        userId: 'user-1',
        ts: '2024-01-05T00:00:00Z',
        kind: null,
        message: 'Malformed kind',
        recordUuid: null,
        sourceId: null,
      } as unknown as Event;
      const { fetchAllEvents } = await import('@/libs/events.js');
      vi.mocked(fetchAllEvents).mockResolvedValue({
        ok: true,
        events: [malformedEvent],
        partial: false,
      });
      const { runEventsCommand } = await import('@/commands/events.js');

      await expect(runEventsCommand(['list'])).resolves.not.toThrow();
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Malformed kind'),
      );
    });

    // recordUuid is null on errEvent — its "record:" line must not print.
    it('omits the record line for an event with no recordUuid', async () => {
      const { fetchAllEvents } = await import('@/libs/events.js');
      vi.mocked(fetchAllEvents).mockResolvedValue({
        ok: true,
        events: [errEvent],
        partial: false,
      });
      const { runEventsCommand } = await import('@/commands/events.js');

      await runEventsCommand(['list']);

      const printedRecordLine = vi
        .mocked(console.log)
        .mock.calls.some(
          ([arg]) => typeof arg === 'string' && arg.includes('record:'),
        );
      expect(printedRecordLine).toBe(false);
    });

    it('strips control characters from untrusted event fields before printing', async () => {
      const control = String.fromCharCode(0x1b);
      const evilEvent: Event = {
        id: 'evt-3',
        userId: 'user-1',
        ts: `2024${control}01`,
        kind: 'ok',
        message: `A${control}B`,
        recordUuid: null,
        sourceId: null,
      };
      const { fetchAllEvents } = await import('@/libs/events.js');
      vi.mocked(fetchAllEvents).mockResolvedValue({
        ok: true,
        events: [evilEvent],
        partial: false,
      });
      const { runEventsCommand } = await import('@/commands/events.js');

      await runEventsCommand(['list']);

      const printedControl = vi
        .mocked(console.log)
        .mock.calls.some(
          ([arg]) => typeof arg === 'string' && arg.includes(control),
        );
      expect(printedControl).toBe(false);
      expect(console.log).toHaveBeenCalledWith('  A B');
    });

    // Covers the fields the test above doesn't: an off-contract kind, plus
    // sourceId/recordUuid, which are only sanitized on the "source:"/
    // "record:" lines.
    it('strips control characters from kind, sourceId, and recordUuid before printing', async () => {
      const control = String.fromCharCode(0x1b);
      const evilEvent: Event = {
        id: 'evt-6',
        userId: 'user-1',
        ts: '2024-01-06T00:00:00Z',
        kind: `mystery${control}kind`,
        message: 'irrelevant',
        recordUuid: `rec${control}1`,
        sourceId: `src${control}1`,
      };
      const { fetchAllEvents } = await import('@/libs/events.js');
      vi.mocked(fetchAllEvents).mockResolvedValue({
        ok: true,
        events: [evilEvent],
        partial: false,
      });
      const { runEventsCommand } = await import('@/commands/events.js');

      await runEventsCommand(['list']);

      const printedControl = vi
        .mocked(console.log)
        .mock.calls.some(
          ([arg]) => typeof arg === 'string' && arg.includes(control),
        );
      expect(printedControl).toBe(false);
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('source: src 1'),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('record: rec 1'),
      );
    });

    it('prints the events as a parseable JSON array with --json', async () => {
      const { checkConfig } = await import('@/libs/config.js');
      const { fetchAllEvents } = await import('@/libs/events.js');
      vi.mocked(fetchAllEvents).mockResolvedValue({
        ok: true,
        events: [okEvent, errEvent],
        partial: false,
      });
      const { runEventsCommand } = await import('@/commands/events.js');

      await runEventsCommand(['list', '--json']);

      expect(checkConfig).toHaveBeenCalledWith(true);
      expect(console.log).toHaveBeenCalledTimes(1);
      const output = vi.mocked(console.log).mock.calls.at(-1)?.[0] as string;
      const parsed = JSON.parse(output);
      expect(parsed).toHaveLength(2);
      expect(parsed[0]).toMatchObject({ id: 'evt-1', kind: 'ok' });
      expect(parsed[1]).toMatchObject({ id: 'evt-2', kind: 'err' });
    });

    it('prints an empty JSON array (not "No events found.") for --json with no events', async () => {
      const { fetchAllEvents } = await import('@/libs/events.js');
      vi.mocked(fetchAllEvents).mockResolvedValue({
        ok: true,
        events: [],
        partial: false,
      });
      const { runEventsCommand } = await import('@/commands/events.js');

      await runEventsCommand(['list', '--json']);

      expect(console.log).not.toHaveBeenCalledWith('No events found.');
      const output = vi.mocked(console.log).mock.calls.at(-1)?.[0] as string;
      expect(JSON.parse(output)).toEqual([]);
    });

    // A partial read must keep stdout valid JSON (jq-safe): the warning goes
    // to stderr only, and the command still exits non-zero.
    it('writes clean JSON to stdout on a partial read, warning only on stderr', async () => {
      const { fetchAllEvents } = await import('@/libs/events.js');
      vi.mocked(fetchAllEvents).mockResolvedValue({
        ok: true,
        events: [okEvent],
        partial: true,
      });
      const { runEventsCommand } = await import('@/commands/events.js');

      await runEventsCommand(['list', '--json']);

      const output = vi.mocked(console.log).mock.calls.at(-1)?.[0] as string;
      expect(JSON.parse(output)).toHaveLength(1);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('this list may be incomplete'),
      );
      expect(process.exitCode).toBe(1);
    });

    it('surfaces an error and never fetches when given an unknown flag', async () => {
      const { checkConfig } = await import('@/libs/config.js');
      const { fetchAllEvents } = await import('@/libs/events.js');
      const { runEventsCommand } = await import('@/commands/events.js');

      await runEventsCommand(['list', '--bogus']);

      expect(checkConfig).not.toHaveBeenCalled();
      expect(fetchAllEvents).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('--bogus'),
      );
      expect(process.exitCode).toBe(1);
    });

    it('rejects a stray positional argument instead of listing everything', async () => {
      const { fetchAllEvents } = await import('@/libs/events.js');
      const { runEventsCommand } = await import('@/commands/events.js');

      await runEventsCommand(['list', 'webhook']);

      expect(fetchAllEvents).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Unexpected argument "webhook"'),
      );
      expect(process.exitCode).toBe(1);
    });

    // A failed fetch (`ok: false`) must not print "No events found." — it has
    // to surface loudly and exit non-zero, distinct from an empty log.
    it('fails loud and exits non-zero when the fetch fails', async () => {
      const { fetchAllEvents } = await import('@/libs/events.js');
      vi.mocked(fetchAllEvents).mockResolvedValue({ ok: false });
      const { runEventsCommand } = await import('@/commands/events.js');

      await runEventsCommand(['list']);

      expect(console.log).not.toHaveBeenCalledWith('No events found.');
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to fetch events from the server.'),
      );
      expect(process.exitCode).toBe(1);
    });

    // A partial read that still collected some events must print them,
    // warn, and exit non-zero — never silently present a truncated log as
    // the full one.
    it('warns and exits non-zero on a partial read, still printing what it got', async () => {
      const { fetchAllEvents } = await import('@/libs/events.js');
      vi.mocked(fetchAllEvents).mockResolvedValue({
        ok: true,
        events: [okEvent],
        partial: true,
      });
      const { runEventsCommand } = await import('@/commands/events.js');

      await runEventsCommand(['list']);

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('this list may be incomplete'),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Ingested record from webhook'),
      );
      expect(process.exitCode).toBe(1);
    });

    // A partial read that returned zero events must not claim "No events
    // found." — the read failed before any page came back, not an empty log.
    it('does not print "No events found." on a partial read with no events', async () => {
      const { fetchAllEvents } = await import('@/libs/events.js');
      vi.mocked(fetchAllEvents).mockResolvedValue({
        ok: true,
        events: [],
        partial: true,
      });
      const { runEventsCommand } = await import('@/commands/events.js');

      await runEventsCommand(['list']);

      expect(console.log).not.toHaveBeenCalledWith('No events found.');
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('the read failed partway through'),
      );
      expect(process.exitCode).toBe(1);
    });

    // A systemic auth failure (expired token) re-throws from fetchAllEvents
    // and must surface its classified, actionable message with a non-zero
    // exit — never masquerade as "No events found."
    it('surfaces a systemic auth failure with a classified message and non-zero exit', async () => {
      const { fetchAllEvents } = await import('@/libs/events.js');
      const { ApiRequestError } = await import('@/libs/api.js');
      vi.mocked(fetchAllEvents).mockRejectedValue(
        new ApiRequestError('Invalid or missing API token', 401),
      );
      const { runEventsCommand } = await import('@/commands/events.js');

      await runEventsCommand(['list']);

      expect(console.log).not.toHaveBeenCalledWith('No events found.');
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Authentication failed (HTTP 401)'),
      );
      expect(process.exitCode).toBe(1);
    });
  });

  describe('--json failure contract', () => {
    it('emits a usage-coded JSON error for an unknown subcommand', async () => {
      const { runEventsCommand } = await import('@/commands/events.js');

      await runEventsCommand(['bogus', '--json']);

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
      const { fetchAllEvents } = await import('@/libs/events.js');
      const { ApiRequestError } = await import('@/libs/api.js');
      vi.mocked(fetchAllEvents).mockRejectedValue(
        new ApiRequestError('Invalid or missing API token', 401),
      );
      const { runEventsCommand } = await import('@/commands/events.js');

      await runEventsCommand(['list', '--json']);

      const parsed = JSON.parse(
        vi.mocked(console.error).mock.calls[0][0] as string,
      );
      expect(parsed.error).toBe('fetch_failed');
      expect(parsed.message).toContain('Authentication failed (HTTP 401)');
      expect(process.exitCode).toBe(1);
    });
  });
});
