import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EventExportRow } from '#src/types/events.types.js';

vi.mock('#src/libs/config.js', () => ({ checkConfig: vi.fn() }));
vi.mock('#src/libs/events.js', () => ({ fetchAllEvents: vi.fn() }));
vi.mock('#src/libs/export.js', () => ({
  fetchEventExport: vi.fn(),
  writeExportFile: vi.fn(),
}));
vi.mock('chalk', () => ({
  default: {
    redBright: vi.fn((value: unknown) => value),
    yellow: vi.fn((value: unknown) => value),
    green: vi.fn((value: unknown) => value),
    dim: vi.fn((value: unknown) => value),
    bold: vi.fn((value: unknown) => value),
  },
}));

const firstRow: EventExportRow = {
  id: 'evt-1',
  ts: '2024-01-01T00:00:00.000Z',
  kind: 'ok',
  message: 'Ingested record from webhook',
  recordUuid: 'rec-1',
  sourceId: 'src-1',
};

const secondRow: EventExportRow = {
  id: 'evt-2',
  ts: '2024-01-02T00:00:00.000Z',
  kind: 'err',
  message: 'Signature verification failed',
  recordUuid: null,
  sourceId: null,
};

const completeExport = (rows: EventExportRow[]) => ({
  ok: true as const,
  rows,
  truncated: false,
  skippedCount: 0,
});

const loadModules = async () => {
  const { checkConfig } = await import('#src/libs/config.js');
  const { fetchEventExport, writeExportFile } =
    await import('#src/libs/export.js');
  const { runEventsCommand } = await import('#src/commands/events.js');
  return { checkConfig, fetchEventExport, writeExportFile, runEventsCommand };
};

const stderrText = () =>
  vi
    .mocked(console.error)
    .mock.calls.map(([arg]) => String(arg))
    .join('\n');

describe('runEventsCommand export', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
    const { checkConfig } = await import('#src/libs/config.js');
    vi.mocked(checkConfig).mockResolvedValue(true);
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('checks config before fetching', async () => {
    const { checkConfig, fetchEventExport, runEventsCommand } =
      await loadModules();
    vi.mocked(fetchEventExport).mockResolvedValue(completeExport([]));

    await runEventsCommand(['export']);

    expect(checkConfig).toHaveBeenCalledWith(false);
    expect(vi.mocked(checkConfig).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(fetchEventExport).mock.invocationCallOrder[0],
    );
  });

  it('never fetches when checkConfig resolves false', async () => {
    const { checkConfig, fetchEventExport, runEventsCommand } =
      await loadModules();
    vi.mocked(checkConfig).mockResolvedValueOnce(false);

    await runEventsCommand(['export']);

    expect(fetchEventExport).not.toHaveBeenCalled();
  });

  it('prints "No events to export." when the log is empty', async () => {
    const { fetchEventExport, runEventsCommand } = await loadModules();
    vi.mocked(fetchEventExport).mockResolvedValue(completeExport([]));

    await runEventsCommand(['export']);

    expect(console.log).toHaveBeenCalledWith('No events to export.');
  });

  it('prints each exported event like `events list`', async () => {
    const { fetchEventExport, runEventsCommand } = await loadModules();
    vi.mocked(fetchEventExport).mockResolvedValue(
      completeExport([firstRow, secondRow]),
    );

    await runEventsCommand(['export']);

    expect(console.log).toHaveBeenCalledWith('OK  2024-01-01T00:00:00.000Z');
    expect(console.log).toHaveBeenCalledWith('  Ingested record from webhook');
    expect(console.log).toHaveBeenCalledWith('  record: rec-1');
    expect(console.log).toHaveBeenCalledWith('  source: src-1');
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).not.toMatch(
      /(record|source): null/,
    );
    expect(console.log).toHaveBeenCalledWith('ERR  2024-01-02T00:00:00.000Z');
  });

  it('strips control characters from untrusted fields before printing', async () => {
    const { fetchEventExport, runEventsCommand } = await loadModules();
    vi.mocked(fetchEventExport).mockResolvedValue(
      completeExport([{ ...firstRow, message: 'evil\u001b[31mred' }]),
    );

    await runEventsCommand(['export']);

    const printed = vi.mocked(console.log).mock.calls.flat().join('\n');
    expect(printed).not.toContain('\u001b');
  });

  it('threads --json to the fetch and prints a parseable array', async () => {
    const { fetchEventExport, runEventsCommand } = await loadModules();
    vi.mocked(fetchEventExport).mockResolvedValue(completeExport([firstRow]));

    await runEventsCommand(['export', '--json']);

    expect(fetchEventExport).toHaveBeenCalledWith(true);
    const printed = vi.mocked(console.log).mock.calls[0][0] as string;
    expect(JSON.parse(printed)).toEqual([firstRow]);
  });

  it('prints [] under --json for an empty log', async () => {
    const { fetchEventExport, runEventsCommand } = await loadModules();
    vi.mocked(fetchEventExport).mockResolvedValue(completeExport([]));

    await runEventsCommand(['export', '--json']);

    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toEqual([]);
  });

  it('warns and exits non-zero when the export was truncated', async () => {
    const { fetchEventExport, runEventsCommand } = await loadModules();
    vi.mocked(fetchEventExport).mockResolvedValue({
      ...completeExport([firstRow]),
      truncated: true,
    });

    await runEventsCommand(['export']);

    expect(stderrText()).toContain('truncated');
    expect(process.exitCode).toBe(1);
  });

  it('warns and exits non-zero when malformed rows were skipped', async () => {
    const { fetchEventExport, runEventsCommand } = await loadModules();
    vi.mocked(fetchEventExport).mockResolvedValue({
      ...completeExport([firstRow]),
      skippedCount: 2,
    });

    await runEventsCommand(['export']);

    expect(stderrText()).toContain('2 malformed row(s)');
    expect(process.exitCode).toBe(1);
  });

  it('emits a single partial_read JSON error under --json for a truncated export', async () => {
    const { fetchEventExport, runEventsCommand } = await loadModules();
    vi.mocked(fetchEventExport).mockResolvedValue({
      ...completeExport([firstRow]),
      truncated: true,
    });

    await runEventsCommand(['export', '--json']);

    expect(vi.mocked(console.error)).toHaveBeenCalledTimes(1);
    expect(JSON.parse(stderrText()).error).toBe('partial_read');
  });

  it('does not warn or fail for a complete export', async () => {
    const { fetchEventExport, runEventsCommand } = await loadModules();
    vi.mocked(fetchEventExport).mockResolvedValue(completeExport([firstRow]));

    await runEventsCommand(['export']);

    expect(console.error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  describe('--out', () => {
    it('writes the rows to the path and reports it', async () => {
      const { fetchEventExport, writeExportFile, runEventsCommand } =
        await loadModules();
      vi.mocked(fetchEventExport).mockResolvedValue(
        completeExport([firstRow, secondRow]),
      );
      vi.mocked(writeExportFile).mockReturnValue('/tmp/out/events.json');

      await runEventsCommand(['export', '--out', '/tmp/out/events.json']);

      expect(writeExportFile).toHaveBeenCalledWith(
        '/tmp/out/events.json',
        [firstRow, secondRow],
        false,
      );
      expect(console.log).toHaveBeenCalledWith(
        'Wrote 2 event(s) to /tmp/out/events.json.',
      );
    });

    it('threads --force to writeExportFile', async () => {
      const { fetchEventExport, writeExportFile, runEventsCommand } =
        await loadModules();
      vi.mocked(fetchEventExport).mockResolvedValue(completeExport([]));
      vi.mocked(writeExportFile).mockReturnValue('/tmp/e.json');

      await runEventsCommand(['export', '--out', '/tmp/e.json', '--force']);

      expect(writeExportFile).toHaveBeenCalledWith('/tmp/e.json', [], true);
    });

    it('still writes the rows, warns and exits non-zero for a truncated export', async () => {
      const { fetchEventExport, writeExportFile, runEventsCommand } =
        await loadModules();
      vi.mocked(fetchEventExport).mockResolvedValue({
        ...completeExport([firstRow]),
        truncated: true,
      });
      vi.mocked(writeExportFile).mockReturnValue('/tmp/e.json');

      await runEventsCommand(['export', '--out', '/tmp/e.json']);

      expect(writeExportFile).toHaveBeenCalledWith(
        '/tmp/e.json',
        [firstRow],
        false,
      );
      expect(stderrText()).toContain('truncated');
      expect(process.exitCode).toBe(1);
    });

    it('never writes when the fetch fails', async () => {
      const { fetchEventExport, writeExportFile, runEventsCommand } =
        await loadModules();
      vi.mocked(fetchEventExport).mockResolvedValue({ ok: false });

      await runEventsCommand(['export', '--out', '/tmp/e.json']);

      expect(writeExportFile).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it('reports a write failure without claiming the fetch failed', async () => {
      const { fetchEventExport, writeExportFile, runEventsCommand } =
        await loadModules();
      vi.mocked(fetchEventExport).mockResolvedValue(completeExport([firstRow]));
      vi.mocked(writeExportFile).mockImplementation(() => {
        throw new Error('EACCES');
      });

      await runEventsCommand(['export', '--out', '/tmp/e.json']);

      expect(stderrText()).toContain('Fetched 1 event(s) but failed to write');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('filters', () => {
    const SOURCE_ID = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b';
    const matchingRow: EventExportRow = {
      ...secondRow,
      id: 'evt-3',
      sourceId: SOURCE_ID,
    };
    const rows = [firstRow, secondRow, matchingRow];

    const printedIds = () =>
      JSON.parse(vi.mocked(console.log).mock.calls.at(-1)?.[0] as string).map(
        (row: EventExportRow) => row.id,
      );

    it('keeps only rows of the requested --kind', async () => {
      const { fetchEventExport, runEventsCommand } = await loadModules();
      vi.mocked(fetchEventExport).mockResolvedValue(completeExport(rows));

      await runEventsCommand(['export', '--kind', 'err', '--json']);

      expect(printedIds()).toEqual(['evt-2', 'evt-3']);
    });

    it('keeps only rows of the requested --source', async () => {
      const { fetchEventExport, runEventsCommand } = await loadModules();
      vi.mocked(fetchEventExport).mockResolvedValue(completeExport(rows));

      await runEventsCommand(['export', '--source', SOURCE_ID, '--json']);

      expect(printedIds()).toEqual(['evt-3']);
    });

    it('combines --kind and --source', async () => {
      const { fetchEventExport, runEventsCommand } = await loadModules();
      vi.mocked(fetchEventExport).mockResolvedValue(completeExport(rows));

      await runEventsCommand([
        'export',
        '--kind',
        'ok',
        '--source',
        SOURCE_ID,
        '--json',
      ]);

      expect(printedIds()).toEqual([]);
    });

    it('still reports a truncated export when filtering', async () => {
      const { fetchEventExport, runEventsCommand } = await loadModules();
      vi.mocked(fetchEventExport).mockResolvedValue({
        ...completeExport(rows),
        truncated: true,
      });

      await runEventsCommand(['export', '--kind', 'err', '--json']);

      expect(stderrText()).toContain('truncated');
      expect(process.exitCode).toBe(1);
    });

    it('matches --source case-insensitively and skips null sourceId rows', async () => {
      const { fetchEventExport, runEventsCommand } = await loadModules();
      vi.mocked(fetchEventExport).mockResolvedValue(completeExport(rows));

      await runEventsCommand([
        'export',
        '--source',
        SOURCE_ID.toUpperCase(),
        '--json',
      ]);

      expect(printedIds()).toEqual(['evt-3']);
    });

    it('writes only the filtered rows with --out', async () => {
      const { fetchEventExport, writeExportFile, runEventsCommand } =
        await loadModules();
      vi.mocked(fetchEventExport).mockResolvedValue(completeExport(rows));
      vi.mocked(writeExportFile).mockReturnValue('/tmp/out.json');

      await runEventsCommand(['export', '--kind', 'ok', '--out', 'out.json']);

      expect(writeExportFile).toHaveBeenCalledWith(
        'out.json',
        [firstRow],
        false,
      );
    });

    it.each([
      ['a non-uuid --source', ['export', '--source', 'webhook']],
      ['a repeated --kind', ['export', '--kind', 'ok', '--kind', 'err']],
      ['an empty --kind', ['export', '--kind=']],
    ])('rejects %s without fetching', async (_label, args) => {
      const { fetchEventExport, runEventsCommand } = await loadModules();

      await runEventsCommand(args);

      expect(fetchEventExport).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it('rejects an invalid --kind without fetching', async () => {
      const { fetchEventExport, runEventsCommand } = await loadModules();

      await runEventsCommand(['export', '--kind', 'fatal']);

      expect(fetchEventExport).not.toHaveBeenCalled();
      expect(stderrText()).toContain(
        '--kind must be one of: ok, dim, warn, err',
      );
      expect(process.exitCode).toBe(1);
    });
  });

  describe('usage errors', () => {
    it.each([
      ['--out with --json', ['export', '--out', 'a.json', '--json']],
      ['--force without --out', ['export', '--force']],
      ['a stray positional', ['export', 'extra']],
      ['an unknown flag', ['export', '--bogus']],
    ])('rejects %s without fetching', async (_label, args) => {
      const { fetchEventExport, runEventsCommand } = await loadModules();

      await runEventsCommand(args);

      expect(fetchEventExport).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it('names `events export` in the stray positional message', async () => {
      const { runEventsCommand } = await loadModules();

      await runEventsCommand(['export', 'extra']);

      expect(stderrText()).toContain('`events export` takes no positional');
    });

    it('reports a usage-coded JSON error under --json', async () => {
      const { runEventsCommand } = await loadModules();

      await runEventsCommand(['export', '--bogus', '--json']);

      expect(JSON.parse(stderrText()).error).toBe('usage');
    });
  });

  it('fails loud and exits non-zero when the fetch fails', async () => {
    const { fetchEventExport, runEventsCommand } = await loadModules();
    vi.mocked(fetchEventExport).mockResolvedValue({ ok: false });

    await runEventsCommand(['export']);

    expect(stderrText()).toContain('Failed to fetch the events export');
    expect(process.exitCode).toBe(1);
  });

  it('surfaces a thrown systemic failure with a non-zero exit', async () => {
    const { fetchEventExport, runEventsCommand } = await loadModules();
    vi.mocked(fetchEventExport).mockRejectedValue(new Error('boom'));

    await runEventsCommand(['export']);

    expect(stderrText()).toContain('boom');
    expect(process.exitCode).toBe(1);
  });
});
