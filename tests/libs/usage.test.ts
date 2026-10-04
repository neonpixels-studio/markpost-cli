import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('chalk', () => ({
  default: {
    redBright: vi.fn((value: unknown) => value),
  },
}));

describe('failWithUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('writes the message and usage to stderr and exits 1', async () => {
    const { failWithUsage } = await import('#src/libs/usage.js');

    failWithUsage('No subcommand given.', 'Usage: markpost records <list>');

    expect(console.error).toHaveBeenCalledWith('No subcommand given.');
    expect(console.error).toHaveBeenCalledWith(
      'Usage: markpost records <list>',
    );
    expect(process.exitCode).toBe(1);
  });

  it('never writes to stdout', async () => {
    const { failWithUsage } = await import('#src/libs/usage.js');

    failWithUsage('No uuid given.', 'Usage: markpost get <uuid>');

    expect(console.log).not.toHaveBeenCalled();
  });
});

describe('failWithSubcommandUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('names the unknown token when a subcommand was given', async () => {
    const { failWithSubcommandUsage } = await import('#src/libs/usage.js');

    failWithSubcommandUsage('bogus', 'Usage: markpost records <list>');

    expect(console.error).toHaveBeenCalledWith('Unknown subcommand: bogus');
    expect(process.exitCode).toBe(1);
  });

  it('reports a missing subcommand when none was given', async () => {
    const { failWithSubcommandUsage } = await import('#src/libs/usage.js');

    failWithSubcommandUsage(undefined, 'Usage: markpost records <list>');

    expect(console.error).toHaveBeenCalledWith('No subcommand given.');
    expect(process.exitCode).toBe(1);
  });

  it("treats an empty-string subcommand as missing, matching push's empty-arg handling", async () => {
    const { failWithSubcommandUsage } = await import('#src/libs/usage.js');

    failWithSubcommandUsage('', 'Usage: markpost records <list>');

    expect(console.error).toHaveBeenCalledWith('No subcommand given.');
  });
});

describe('parseOrFailWithUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('returns the parsed value and leaves the exit code untouched on success', async () => {
    const { parseOrFailWithUsage } = await import('#src/libs/usage.js');

    const result = parseOrFailWithUsage(
      () => ({ ok: true }),
      'Usage: markpost sources <list>',
    );

    expect(result).toEqual({ ok: true });
    expect(console.error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('returns null and reports the usage block when the parse thunk throws', async () => {
    const { parseOrFailWithUsage } = await import('#src/libs/usage.js');

    const result = parseOrFailWithUsage(() => {
      throw new Error('Unknown option --bogus');
    }, 'Usage: markpost sources <list>');

    expect(result).toBeNull();
    expect(console.error).toHaveBeenCalledWith('Unknown option --bogus');
    expect(console.error).toHaveBeenCalledWith(
      'Usage: markpost sources <list>',
    );
    expect(process.exitCode).toBe(1);
  });

  // A thrown value's message can carry user-supplied text (an echoed unknown
  // flag or positional) — it must go through the same sanitizer as every
  // other untrusted-text path before reaching the terminal.
  it('sanitizes control characters out of the thrown message', async () => {
    const control = String.fromCharCode(0x1b);
    const { parseOrFailWithUsage } = await import('#src/libs/usage.js');

    parseOrFailWithUsage(() => {
      throw new Error(`Unexpected argument "evil${control}[2J"`);
    }, 'Usage: markpost sources <list>');

    const printedControl = vi
      .mocked(console.error)
      .mock.calls.some(
        ([arg]) => typeof arg === 'string' && arg.includes(control),
      );
    expect(printedControl).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('evil [2J'),
    );
  });

  it('reports a usage-coded JSON error on stderr in --json mode', async () => {
    const { parseOrFailWithUsage } = await import('#src/libs/usage.js');

    const result = parseOrFailWithUsage(
      () => {
        throw new Error('Unknown option --bogus');
      },
      'Usage: markpost sources <list>',
      true,
    );

    expect(result).toBeNull();
    expect(console.log).not.toHaveBeenCalled();
    const parsed = JSON.parse(
      vi.mocked(console.error).mock.calls[0][0] as string,
    );
    expect(parsed).toEqual({
      error: 'usage',
      message: 'Unknown option --bogus',
    });
    expect(process.exitCode).toBe(1);
  });
});
