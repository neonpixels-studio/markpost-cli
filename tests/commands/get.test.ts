import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Record } from '@/types/records.types.js';

vi.mock('@/libs/config.js', () => ({ checkConfig: vi.fn() }));
vi.mock('@/libs/records.js', () => ({ fetchRecord: vi.fn() }));
vi.mock('chalk', () => ({
  default: {
    redBright: vi.fn((value: unknown) => value),
    bold: vi.fn((value: unknown) => value),
  },
}));

const mockRecord: Record = {
  uuid: 'abc-123',
  title: 'Test Title',
  content: 'Test Content',
  createdAt: '2024-01-01T00:00:00Z',
};

describe('runGetCommand', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.exitCode = undefined;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('errors to stderr and exits 1 when no uuid is given', async () => {
    const { runGetCommand } = await import('@/commands/get.js');

    await runGetCommand([]);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('No uuid given.'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Usage: markpost get'),
    );
    expect(console.log).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('does not check config when no uuid is given', async () => {
    const { checkConfig } = await import('@/libs/config.js');
    const { runGetCommand } = await import('@/commands/get.js');

    await runGetCommand([]);

    expect(checkConfig).not.toHaveBeenCalled();
  });

  it('fetches and prints the record', async () => {
    const { checkConfig } = await import('@/libs/config.js');
    const { fetchRecord } = await import('@/libs/records.js');
    vi.mocked(fetchRecord).mockResolvedValue(mockRecord);
    const { runGetCommand } = await import('@/commands/get.js');

    await runGetCommand(['abc-123']);

    expect(checkConfig).toHaveBeenCalled();
    expect(fetchRecord).toHaveBeenCalledWith('abc-123');
    expect(console.log).toHaveBeenCalledWith('Test Title');
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('uuid:       abc-123'),
    );
    expect(console.log).toHaveBeenCalledWith('Test Content');
  });

  it('reports an error when the record is not found', async () => {
    const { fetchRecord } = await import('@/libs/records.js');
    vi.mocked(fetchRecord).mockResolvedValue(null);
    const { runGetCommand } = await import('@/commands/get.js');

    await runGetCommand(['abc-123']);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to fetch record "abc-123".'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('strips control characters from untrusted record fields before printing', async () => {
    // ESC (0x1b) built via fromCharCode so no raw control byte lives in source.
    const control = String.fromCharCode(0x1b);
    const evilRecord: Record = {
      uuid: `id${control}1`,
      title: `A${control}B`,
      content: `C${control}D`,
      createdAt: `2024${control}01`,
    };
    const { fetchRecord } = await import('@/libs/records.js');
    vi.mocked(fetchRecord).mockResolvedValue(evilRecord);
    const { runGetCommand } = await import('@/commands/get.js');

    await runGetCommand(['id-1']);

    const printedControl = vi
      .mocked(console.log)
      .mock.calls.some(
        ([arg]) => typeof arg === 'string' && arg.includes(control),
      );
    expect(printedControl).toBe(false);
    expect(console.log).toHaveBeenCalledWith('A B');
    expect(console.log).toHaveBeenCalledWith('C D');
  });

  it('preserves newlines and tabs in multi-line content while still stripping escapes', async () => {
    // The markdown body must survive intact so `markpost get <uuid> > note.md`
    // stays a faithful export; only the ANSI escape is removed.
    const control = String.fromCharCode(0x1b);
    const multiLineContent = `# Heading\n\n- item one\n\titem two${control}[2J`;
    const record: Record = {
      uuid: 'id-1',
      title: 'Title',
      content: multiLineContent,
      createdAt: '2024-01-01T00:00:00Z',
    };
    const { fetchRecord } = await import('@/libs/records.js');
    vi.mocked(fetchRecord).mockResolvedValue(record);
    const { runGetCommand } = await import('@/commands/get.js');

    await runGetCommand(['id-1']);

    expect(console.log).toHaveBeenCalledWith(
      '# Heading\n\n- item one\n\titem two [2J',
    );
  });

  it('prints the record as a single parseable JSON object with --json', async () => {
    const { fetchRecord } = await import('@/libs/records.js');
    vi.mocked(fetchRecord).mockResolvedValue(mockRecord);
    const { runGetCommand } = await import('@/commands/get.js');

    await runGetCommand(['abc-123', '--json']);

    // One stdout write, and it is JSON — not the labeled "uuid:       " line.
    expect(console.log).toHaveBeenCalledTimes(1);
    const output = vi.mocked(console.log).mock.calls.at(-1)?.[0] as string;
    expect(output).not.toContain('uuid:       ');
    expect(JSON.parse(output)).toMatchObject({
      uuid: 'abc-123',
      title: 'Test Title',
      content: 'Test Content',
      createdAt: '2024-01-01T00:00:00Z',
    });
    expect(process.exitCode).not.toBe(1);
  });

  it('accepts --json before the uuid', async () => {
    const { fetchRecord } = await import('@/libs/records.js');
    vi.mocked(fetchRecord).mockResolvedValue(mockRecord);
    const { runGetCommand } = await import('@/commands/get.js');

    await runGetCommand(['--json', 'abc-123']);

    expect(fetchRecord).toHaveBeenCalledWith('abc-123');
    const output = vi.mocked(console.log).mock.calls.at(-1)?.[0] as string;
    expect(JSON.parse(output).uuid).toBe('abc-123');
  });

  // The JSON path stays faithful rather than terminal-sanitizing: no raw
  // control byte reaches stdout (JSON.stringify escapes it to a printable \u form), but the
  // value round-trips losslessly, unlike the pretty path that blanks escapes.
  it('emits faithful, JSON-escaped values on the --json path without stripping data', async () => {
    const control = String.fromCharCode(0x1b);
    const { fetchRecord } = await import('@/libs/records.js');
    vi.mocked(fetchRecord).mockResolvedValue({
      ...mockRecord,
      title: `A${control}B`,
    });
    const { runGetCommand } = await import('@/commands/get.js');

    await runGetCommand(['abc-123', '--json']);

    const output = vi.mocked(console.log).mock.calls.at(-1)?.[0] as string;
    expect(output).not.toContain(control);
    expect(JSON.parse(output).title).toBe(`A${control}B`);
  });

  it('writes nothing to stdout and exits 1 when the record is missing, even with --json', async () => {
    const { fetchRecord } = await import('@/libs/records.js');
    vi.mocked(fetchRecord).mockResolvedValue(null);
    const { runGetCommand } = await import('@/commands/get.js');

    await runGetCommand(['abc-123', '--json']);

    // A `jq` consumer relies on stdout being empty when the fetch fails, not a
    // `null` payload it would try to parse.
    expect(console.log).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('exits 1 on an unknown flag before checking config or fetching', async () => {
    const { checkConfig } = await import('@/libs/config.js');
    const { fetchRecord } = await import('@/libs/records.js');
    const { runGetCommand } = await import('@/commands/get.js');

    await runGetCommand(['abc-123', '--bogus']);

    expect(checkConfig).not.toHaveBeenCalled();
    expect(fetchRecord).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('catches and logs an error when checkConfig throws', async () => {
    const { checkConfig } = await import('@/libs/config.js');
    vi.mocked(checkConfig).mockRejectedValue(new Error('boom'));
    const { runGetCommand } = await import('@/commands/get.js');

    await runGetCommand(['abc-123']);

    expect(console.error).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
