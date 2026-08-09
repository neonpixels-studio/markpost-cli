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
    const { failWithUsage } = await import('@/libs/usage.js');

    failWithUsage('No subcommand given.', 'Usage: markpost records <list>');

    expect(console.error).toHaveBeenCalledWith('No subcommand given.');
    expect(console.error).toHaveBeenCalledWith(
      'Usage: markpost records <list>',
    );
    expect(process.exitCode).toBe(1);
  });

  it('never writes to stdout', async () => {
    const { failWithUsage } = await import('@/libs/usage.js');

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
    const { failWithSubcommandUsage } = await import('@/libs/usage.js');

    failWithSubcommandUsage('bogus', 'Usage: markpost records <list>');

    expect(console.error).toHaveBeenCalledWith('Unknown subcommand: bogus');
    expect(process.exitCode).toBe(1);
  });

  it('reports a missing subcommand when none was given', async () => {
    const { failWithSubcommandUsage } = await import('@/libs/usage.js');

    failWithSubcommandUsage(undefined, 'Usage: markpost records <list>');

    expect(console.error).toHaveBeenCalledWith('No subcommand given.');
    expect(process.exitCode).toBe(1);
  });

  it('treats an empty-string subcommand as missing, matching push\'s empty-arg handling', async () => {
    const { failWithSubcommandUsage } = await import('@/libs/usage.js');

    failWithSubcommandUsage('', 'Usage: markpost records <list>');

    expect(console.error).toHaveBeenCalledWith('No subcommand given.');
  });
});
