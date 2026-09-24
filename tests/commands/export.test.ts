import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RecordExportRow } from '@/types/records.types.js';

vi.mock('@/libs/config.js', () => ({ checkConfig: vi.fn() }));
vi.mock('@/libs/export.js', () => ({
  fetchRecordExport: vi.fn(),
  writeExportFile: vi.fn(),
}));
vi.mock('chalk', () => ({
  default: {
    redBright: vi.fn((value: unknown) => value),
    bold: vi.fn((value: unknown) => value),
    yellow: vi.fn((value: unknown) => value),
    green: vi.fn((value: unknown) => value),
  },
}));

const firstRow: RecordExportRow = {
  uuid: 'abc-123',
  createdAt: '2024-01-01T00:00:00Z',
  title: 'First Record',
  content: 'First record content',
  source: 'webhook',
  sourceId: 'source-1',
  status: 'synced',
  filePath: '/vault/first-record.md',
  tags: ['a'],
  frontmatter: null,
  syncedAt: '2024-01-02T00:00:00Z',
  errorMessage: null,
};

const secondRow: RecordExportRow = {
  uuid: 'def-456',
  createdAt: '2024-01-03T00:00:00Z',
  title: 'Second Record',
  content: 'Second record content',
  source: null,
  sourceId: null,
  status: 'pending',
  filePath: null,
  tags: null,
  frontmatter: null,
  syncedAt: null,
  errorMessage: null,
};

describe('runExportCommand', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
    const { checkConfig } = await import('@/libs/config.js');
    vi.mocked(checkConfig).mockResolvedValue(true);
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('always checks config before fetching', async () => {
    const { checkConfig } = await import('@/libs/config.js');
    const { fetchRecordExport } = await import('@/libs/export.js');
    vi.mocked(fetchRecordExport).mockResolvedValue({
      ok: true,
      rows: [],
      truncated: false,
      skippedCount: 0,
    });
    const { runExportCommand } = await import('@/commands/export.js');

    await runExportCommand([]);

    expect(checkConfig).toHaveBeenCalledWith(false);
  });

  it('never fetches when checkConfig resolves false', async () => {
    const { checkConfig } = await import('@/libs/config.js');
    vi.mocked(checkConfig).mockResolvedValueOnce(false);
    const { fetchRecordExport } = await import('@/libs/export.js');
    const { runExportCommand } = await import('@/commands/export.js');

    await runExportCommand([]);

    expect(fetchRecordExport).not.toHaveBeenCalled();
  });

  it('prints "No records to export." when the account is empty', async () => {
    const { fetchRecordExport } = await import('@/libs/export.js');
    vi.mocked(fetchRecordExport).mockResolvedValue({
      ok: true,
      rows: [],
      truncated: false,
      skippedCount: 0,
    });
    const { runExportCommand } = await import('@/commands/export.js');

    await runExportCommand([]);

    expect(console.log).toHaveBeenCalledWith('No records to export.');
  });

  it('prints a summary of each exported row by default', async () => {
    const { fetchRecordExport } = await import('@/libs/export.js');
    vi.mocked(fetchRecordExport).mockResolvedValue({
      ok: true,
      rows: [firstRow, secondRow],
      truncated: false,
      skippedCount: 0,
    });
    const { runExportCommand } = await import('@/commands/export.js');

    await runExportCommand([]);

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('First Record'),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('status:     synced'),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Second Record'),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('status:     pending'),
    );
  });

  it('omits optional fields for a row without them', async () => {
    const { fetchRecordExport } = await import('@/libs/export.js');
    vi.mocked(fetchRecordExport).mockResolvedValue({
      ok: true,
      rows: [secondRow],
      truncated: false,
      skippedCount: 0,
    });
    const { runExportCommand } = await import('@/commands/export.js');

    await runExportCommand([]);

    const printedSourceLine = vi
      .mocked(console.log)
      .mock.calls.some(
        ([arg]) => typeof arg === 'string' && arg.includes('source:'),
      );
    expect(printedSourceLine).toBe(false);
  });

  it('strips control characters from untrusted export fields before printing', async () => {
    const control = String.fromCharCode(0x1b);
    const evilRow: RecordExportRow = { ...firstRow, title: `A${control}B` };
    const { fetchRecordExport } = await import('@/libs/export.js');
    vi.mocked(fetchRecordExport).mockResolvedValue({
      ok: true,
      rows: [evilRow],
      truncated: false,
      skippedCount: 0,
    });
    const { runExportCommand } = await import('@/commands/export.js');

    await runExportCommand([]);

    const printedControl = vi
      .mocked(console.log)
      .mock.calls.some(
        ([arg]) => typeof arg === 'string' && arg.includes(control),
      );
    expect(printedControl).toBe(false);
    expect(console.log).toHaveBeenCalledWith('A B');
  });

  // A truncated export or a batch of malformed rows both mean the account
  // isn't fully represented, even though the fetch itself succeeded — so both
  // must exit non-zero (mirroring records.ts/events.ts's partial-read
  // convention) so a script can detect an incomplete backup via `$?` alone.
  describe('incomplete export reporting', () => {
    it('warns and exits non-zero when the export was truncated', async () => {
      const { fetchRecordExport } = await import('@/libs/export.js');
      vi.mocked(fetchRecordExport).mockResolvedValue({
        ok: true,
        rows: [firstRow],
        truncated: true,
        skippedCount: 0,
      });
      const { runExportCommand } = await import('@/commands/export.js');

      await runExportCommand([]);

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('truncated'),
      );
      expect(process.exitCode).toBe(1);
    });

    it('warns and exits non-zero when the server returned malformed rows', async () => {
      const { fetchRecordExport } = await import('@/libs/export.js');
      vi.mocked(fetchRecordExport).mockResolvedValue({
        ok: true,
        rows: [firstRow],
        truncated: false,
        skippedCount: 3,
      });
      const { runExportCommand } = await import('@/commands/export.js');

      await runExportCommand([]);

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('3 malformed row(s)'),
      );
      expect(process.exitCode).toBe(1);
    });

    it('does not warn or exit non-zero for a complete export', async () => {
      const { fetchRecordExport } = await import('@/libs/export.js');
      vi.mocked(fetchRecordExport).mockResolvedValue({
        ok: true,
        rows: [firstRow],
        truncated: false,
        skippedCount: 0,
      });
      const { runExportCommand } = await import('@/commands/export.js');

      await runExportCommand([]);

      expect(console.error).not.toHaveBeenCalled();
      expect(process.exitCode).not.toBe(1);
    });
  });

  describe('--json', () => {
    it('prints the rows as a parseable JSON array', async () => {
      const { fetchRecordExport } = await import('@/libs/export.js');
      vi.mocked(fetchRecordExport).mockResolvedValue({
        ok: true,
        rows: [firstRow, secondRow],
        truncated: false,
        skippedCount: 0,
      });
      const { runExportCommand } = await import('@/commands/export.js');

      await runExportCommand(['--json']);

      const output = vi.mocked(console.log).mock.calls.at(-1)?.[0] as string;
      const parsed = JSON.parse(output);
      expect(parsed).toHaveLength(2);
      expect(parsed[0]).toMatchObject({ uuid: 'abc-123' });
    });

    it('prints an empty JSON array (not "No records to export.") when there are none', async () => {
      const { fetchRecordExport } = await import('@/libs/export.js');
      vi.mocked(fetchRecordExport).mockResolvedValue({
        ok: true,
        rows: [],
        truncated: false,
        skippedCount: 0,
      });
      const { runExportCommand } = await import('@/commands/export.js');

      await runExportCommand(['--json']);

      expect(console.log).not.toHaveBeenCalledWith('No records to export.');
      const output = vi.mocked(console.log).mock.calls.at(-1)?.[0] as string;
      expect(JSON.parse(output)).toEqual([]);
    });

    // Under --json the stderr warning must itself be the single JSON error
    // object the rest of the JSON failure contract uses (issue #205, mirroring
    // records.ts/events.ts's own partial_read fix, issue #194) — not a
    // plain-text chalk line, which would choke a script parsing stderr as
    // JSON.
    it('emits a single partial_read JSON error object on stderr for a truncated export under --json', async () => {
      const { fetchRecordExport } = await import('@/libs/export.js');
      vi.mocked(fetchRecordExport).mockResolvedValue({
        ok: true,
        rows: [firstRow],
        truncated: true,
        skippedCount: 0,
      });
      const { runExportCommand } = await import('@/commands/export.js');

      await runExportCommand(['--json']);

      expect(console.error).toHaveBeenCalledTimes(1);
      const errorOutput = vi.mocked(console.error).mock.calls[0][0] as string;
      expect(JSON.parse(errorOutput)).toEqual({
        error: 'partial_read',
        message: expect.stringContaining('truncated'),
      });
      // The partial data on stdout and the non-zero exit must both survive
      // alongside the JSON error object on stderr.
      const output = vi.mocked(console.log).mock.calls.at(-1)?.[0] as string;
      expect(JSON.parse(output)).toHaveLength(1);
      expect(process.exitCode).toBe(1);
    });

    it('emits a single partial_read JSON error object on stderr for skipped malformed rows under --json', async () => {
      const { fetchRecordExport } = await import('@/libs/export.js');
      vi.mocked(fetchRecordExport).mockResolvedValue({
        ok: true,
        rows: [firstRow],
        truncated: false,
        skippedCount: 3,
      });
      const { runExportCommand } = await import('@/commands/export.js');

      await runExportCommand(['--json']);

      expect(console.error).toHaveBeenCalledTimes(1);
      const errorOutput = vi.mocked(console.error).mock.calls[0][0] as string;
      expect(JSON.parse(errorOutput)).toEqual({
        error: 'partial_read',
        message: expect.stringContaining('3 malformed row(s)'),
      });
      const output = vi.mocked(console.log).mock.calls.at(-1)?.[0] as string;
      expect(JSON.parse(output)).toHaveLength(1);
      expect(process.exitCode).toBe(1);
    });

    it('emits two separate partial_read JSON error objects when both truncated and skipped rows apply under --json', async () => {
      const { fetchRecordExport } = await import('@/libs/export.js');
      vi.mocked(fetchRecordExport).mockResolvedValue({
        ok: true,
        rows: [firstRow],
        truncated: true,
        skippedCount: 2,
      });
      const { runExportCommand } = await import('@/commands/export.js');

      await runExportCommand(['--json']);

      expect(console.error).toHaveBeenCalledTimes(2);
      const [truncatedOutput, skippedOutput] = vi
        .mocked(console.error)
        .mock.calls.map(([arg]) => JSON.parse(arg as string));
      expect(truncatedOutput).toEqual({
        error: 'partial_read',
        message: expect.stringContaining('truncated'),
      });
      expect(skippedOutput).toEqual({
        error: 'partial_read',
        message: expect.stringContaining('2 malformed row(s)'),
      });
      expect(process.exitCode).toBe(1);
    });

    it('rejects combining --out and --json', async () => {
      const { fetchRecordExport, writeExportFile } =
        await import('@/libs/export.js');
      const { runExportCommand } = await import('@/commands/export.js');

      await runExportCommand(['--out', '/tmp/backup.json', '--json']);

      expect(fetchRecordExport).not.toHaveBeenCalled();
      expect(writeExportFile).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Cannot combine --out and --json.'),
      );
      expect(process.exitCode).toBe(1);
    });

    // Regression: `parseArgs`'s `--flag=value` form explicitly allows a
    // dash-prefixed value (unlike the space-separated form, which Node
    // itself rejects as ambiguous) — so `--out=--json` would otherwise
    // silently set `values.out` to the literal string "--json" and write a
    // file by that name, while `--json` itself was never actually requested.
    // This must be rejected outright rather than reaching the write path.
    it('rejects --out=--json instead of writing a file literally named "--json"', async () => {
      const { fetchRecordExport, writeExportFile } =
        await import('@/libs/export.js');
      const { runExportCommand } = await import('@/commands/export.js');

      await runExportCommand(['--out=--json']);

      expect(fetchRecordExport).not.toHaveBeenCalled();
      expect(writeExportFile).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('--out was not given a path'),
      );
      expect(process.exitCode).toBe(1);
    });
  });

  describe('--out', () => {
    it('writes the export to the given path and reports where it landed', async () => {
      const { fetchRecordExport, writeExportFile } =
        await import('@/libs/export.js');
      vi.mocked(fetchRecordExport).mockResolvedValue({
        ok: true,
        rows: [firstRow],
        truncated: false,
        skippedCount: 0,
      });
      vi.mocked(writeExportFile).mockReturnValue('/resolved/backup.json');
      const { runExportCommand } = await import('@/commands/export.js');

      await runExportCommand(['--out', '/tmp/backup.json']);

      expect(writeExportFile).toHaveBeenCalledWith(
        '/tmp/backup.json',
        [firstRow],
        false,
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('/resolved/backup.json'),
      );
      // The per-record summary must not also print to stdout.
      expect(console.log).not.toHaveBeenCalledWith(
        expect.stringContaining('First Record'),
      );
    });

    it('threads --force through to writeExportFile', async () => {
      const { fetchRecordExport, writeExportFile } =
        await import('@/libs/export.js');
      vi.mocked(fetchRecordExport).mockResolvedValue({
        ok: true,
        rows: [firstRow],
        truncated: false,
        skippedCount: 0,
      });
      vi.mocked(writeExportFile).mockReturnValue('/resolved/backup.json');
      const { runExportCommand } = await import('@/commands/export.js');

      await runExportCommand(['--out', '/tmp/backup.json', '--force']);

      expect(writeExportFile).toHaveBeenCalledWith(
        '/tmp/backup.json',
        [firstRow],
        true,
      );
    });

    it('rejects --force without --out', async () => {
      const { fetchRecordExport, writeExportFile } =
        await import('@/libs/export.js');
      const { runExportCommand } = await import('@/commands/export.js');

      await runExportCommand(['--force']);

      expect(fetchRecordExport).not.toHaveBeenCalled();
      expect(writeExportFile).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('--force has no effect without --out.'),
      );
      expect(process.exitCode).toBe(1);
    });

    // Regression: nothing pins the ordering that a failed fetch must never
    // reach the write path — an innocuous reorder in `runExport` could start
    // truncating the user's previous backup on every auth failure.
    it('never calls writeExportFile when the fetch fails', async () => {
      const { fetchRecordExport, writeExportFile } =
        await import('@/libs/export.js');
      vi.mocked(fetchRecordExport).mockResolvedValue({ ok: false });
      const { runExportCommand } = await import('@/commands/export.js');

      await runExportCommand(['--out', '/tmp/backup.json']);

      expect(writeExportFile).not.toHaveBeenCalled();
    });

    it('notes the skipped count in the write summary', async () => {
      const { fetchRecordExport, writeExportFile } =
        await import('@/libs/export.js');
      vi.mocked(fetchRecordExport).mockResolvedValue({
        ok: true,
        rows: [firstRow],
        truncated: false,
        skippedCount: 2,
      });
      vi.mocked(writeExportFile).mockReturnValue('/resolved/backup.json');
      const { runExportCommand } = await import('@/commands/export.js');

      await runExportCommand(['--out', '/tmp/backup.json']);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('2 malformed row(s) skipped'),
      );
      expect(process.exitCode).toBe(1);
    });

    it('rejects a present-but-empty --out value', async () => {
      const { fetchRecordExport, writeExportFile } =
        await import('@/libs/export.js');
      const { runExportCommand } = await import('@/commands/export.js');

      await runExportCommand(['--out=']);

      expect(fetchRecordExport).not.toHaveBeenCalled();
      expect(writeExportFile).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('--out needs a non-empty path.'),
      );
      expect(process.exitCode).toBe(1);
    });

    it('still warns about truncation and exits non-zero when writing to a file', async () => {
      const { fetchRecordExport, writeExportFile } =
        await import('@/libs/export.js');
      vi.mocked(fetchRecordExport).mockResolvedValue({
        ok: true,
        rows: [firstRow],
        truncated: true,
        skippedCount: 0,
      });
      vi.mocked(writeExportFile).mockReturnValue('/resolved/backup.json');
      const { runExportCommand } = await import('@/commands/export.js');

      await runExportCommand(['--out', '/tmp/backup.json']);

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('truncated'),
      );
      expect(process.exitCode).toBe(1);
    });

    // Regression: a filesystem failure (EACCES, EISDIR, a full disk) writing
    // the already-fetched rows is not a fetch failure — the rows were
    // retrieved successfully — so the reported error must say so explicitly
    // rather than a generic message that reads as "nothing was retrieved".
    it('reports a write failure without claiming the fetch itself failed', async () => {
      const { fetchRecordExport, writeExportFile } =
        await import('@/libs/export.js');
      vi.mocked(fetchRecordExport).mockResolvedValue({
        ok: true,
        rows: [firstRow, secondRow],
        truncated: false,
        skippedCount: 0,
      });
      vi.mocked(writeExportFile).mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });
      const { runExportCommand } = await import('@/commands/export.js');

      await runExportCommand(['--out', '/root/backup.json']);

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Fetched 2 record(s) but failed to write'),
      );
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('EACCES: permission denied'),
      );
      expect(process.exitCode).toBe(1);
    });
  });

  it('rejects a stray positional argument', async () => {
    const { fetchRecordExport } = await import('@/libs/export.js');
    const { runExportCommand } = await import('@/commands/export.js');

    await runExportCommand(['bogus']);

    expect(fetchRecordExport).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Unexpected argument "bogus"'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('surfaces an error and never fetches when given an unknown flag', async () => {
    const { checkConfig } = await import('@/libs/config.js');
    const { fetchRecordExport } = await import('@/libs/export.js');
    const { runExportCommand } = await import('@/commands/export.js');

    await runExportCommand(['--bogus', 'value']);

    expect(checkConfig).not.toHaveBeenCalled();
    expect(fetchRecordExport).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('bogus'),
    );
    expect(process.exitCode).toBe(1);
  });

  // A failed fetch (`ok: false`) must not print "No records to export." — it
  // has to surface loudly and exit non-zero, distinct from an empty account.
  it('fails loud and exits non-zero when the fetch fails', async () => {
    const { fetchRecordExport } = await import('@/libs/export.js');
    vi.mocked(fetchRecordExport).mockResolvedValue({ ok: false });
    const { runExportCommand } = await import('@/commands/export.js');

    await runExportCommand([]);

    expect(console.log).not.toHaveBeenCalledWith('No records to export.');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to fetch the export from the server.'),
    );
    expect(process.exitCode).toBe(1);
  });

  // A systemic auth failure (expired token) re-throws from fetchRecordExport
  // and must surface its classified, actionable message with a non-zero exit.
  it('surfaces a systemic auth failure with a classified message and non-zero exit', async () => {
    const { fetchRecordExport } = await import('@/libs/export.js');
    const { ApiRequestError } = await import('@/libs/api.js');
    vi.mocked(fetchRecordExport).mockRejectedValue(
      new ApiRequestError('Invalid or missing API token', 401),
    );
    const { runExportCommand } = await import('@/commands/export.js');

    await runExportCommand([]);

    expect(console.log).not.toHaveBeenCalledWith('No records to export.');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Authentication failed (HTTP 401)'),
    );
    expect(process.exitCode).toBe(1);
  });

  describe('--json failure contract', () => {
    // Mirrors get.ts/records.ts: a bad flag throws out of the arg parser and
    // is caught by the command's single outer catch, which always reports
    // through the fetch_failed shape (there is no separate usage-coded path
    // for a thrown parse error here, unlike the subcommand-group commands'
    // dedicated failWithSubcommandUsage call).
    it('emits a fetch_failed-coded JSON error for an unknown flag', async () => {
      const { runExportCommand } = await import('@/commands/export.js');

      await runExportCommand(['--bogus', '--json']);

      const parsed = JSON.parse(
        vi.mocked(console.error).mock.calls[0][0] as string,
      );
      expect(parsed.error).toBe('fetch_failed');
      expect(parsed.message).toContain('bogus');
      expect(process.exitCode).toBe(1);
    });

    it('emits a fetch_failed JSON error on stderr for a thrown fetch failure', async () => {
      const { fetchRecordExport } = await import('@/libs/export.js');
      const { ApiRequestError } = await import('@/libs/api.js');
      vi.mocked(fetchRecordExport).mockRejectedValue(
        new ApiRequestError('Invalid or missing API token', 401),
      );
      const { runExportCommand } = await import('@/commands/export.js');

      await runExportCommand(['--json']);

      const parsed = JSON.parse(
        vi.mocked(console.error).mock.calls[0][0] as string,
      );
      expect(parsed.error).toBe('fetch_failed');
      expect(parsed.message).toContain('Authentication failed (HTTP 401)');
      expect(process.exitCode).toBe(1);
    });
  });
});
