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

  it('catches and logs an error when checkConfig throws', async () => {
    const { checkConfig } = await import('@/libs/config.js');
    vi.mocked(checkConfig).mockRejectedValue(new Error('boom'));
    const { runGetCommand } = await import('@/commands/get.js');

    await runGetCommand(['abc-123']);

    expect(console.error).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
