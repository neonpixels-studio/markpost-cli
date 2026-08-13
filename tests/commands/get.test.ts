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

  // A systemic auth failure (expired token) now re-throws from fetchRecord and
  // must surface its classified, actionable message with a non-zero exit —
  // distinct from the generic "Failed to fetch record" a genuine 404 produces
  // (issue #89).
  it('surfaces a systemic auth failure with a classified message, not "not found"', async () => {
    const { fetchRecord } = await import('@/libs/records.js');
    const { ApiRequestError } = await import('@/libs/api.js');
    vi.mocked(fetchRecord).mockRejectedValue(
      new ApiRequestError('Invalid or missing API token', 401),
    );
    const { runGetCommand } = await import('@/commands/get.js');

    await runGetCommand(['abc-123']);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Authentication failed (HTTP 401)'),
    );
    expect(console.error).not.toHaveBeenCalledWith(
      expect.stringContaining('Failed to fetch record'),
    );
    expect(process.exitCode).toBe(1);
  });

  // The systemic message is server-derived, so it must be stripped of terminal
  // escapes before printing. Pins the sanitize wrap so removing it fails here.
  it('strips terminal escapes from a server-derived systemic error message', async () => {
    // ESC (0x1b) built via fromCharCode so no raw control byte lives in source.
    const escape = String.fromCharCode(0x1b);
    const { fetchRecord } = await import('@/libs/records.js');
    const { ApiRequestError } = await import('@/libs/api.js');
    vi.mocked(fetchRecord).mockRejectedValue(
      new ApiRequestError(`${escape}[2JInvalid token`, 401),
    );
    const { runGetCommand } = await import('@/commands/get.js');

    await runGetCommand(['abc-123']);

    const printedEscape = vi
      .mocked(console.error)
      .mock.calls.some(
        ([arg]) => typeof arg === 'string' && arg.includes(escape),
      );
    expect(printedEscape).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Authentication failed (HTTP 401)'),
    );
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

  it('catches and logs an error when checkConfig throws', async () => {
    const { checkConfig } = await import('@/libs/config.js');
    vi.mocked(checkConfig).mockRejectedValue(new Error('boom'));
    const { runGetCommand } = await import('@/commands/get.js');

    await runGetCommand(['abc-123']);

    expect(console.error).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
