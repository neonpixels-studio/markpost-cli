import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetConfigValue, mockSetConfigValue, mockGetConfigPath } =
  vi.hoisted(() => ({
    mockGetConfigValue: vi.fn(),
    mockSetConfigValue: vi.fn(),
    mockGetConfigPath: vi.fn(),
  }));

// `conf` instantiates a filesystem-backed store at import time; stub it so
// loading the real config module in tests never touches disk.
vi.mock('conf', () => ({
  default: vi.fn().mockImplementation(function () {
    return { get: vi.fn(), set: vi.fn(), path: '' };
  }),
}));

// Keep the real CONFIG_KEYS / isConfigKey / formatting so a new key added to
// the source is exercised here automatically; mock only the I/O seams.
vi.mock('@/libs/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/libs/config.js')>()),
  getConfigValue: mockGetConfigValue,
  setConfigValue: mockSetConfigValue,
  getConfigPath: mockGetConfigPath,
}));

vi.mock('chalk', () => ({
  default: {
    redBright: vi.fn((value: unknown) => value),
    greenBright: vi.fn((value: unknown) => value),
    bold: vi.fn((value: unknown) => value),
  },
}));

const LONG_TOKEN = 'sk_abcdef1234567890wxyz';
const SHORT_TOKEN = 'sk_short';
const STORED_DIRECTORY = '/home/user/notes';
const CONFIG_FILE_PATH = '/home/user/.config/@markpost/cli/config.json';

const importCommand = async () => {
  const { runConfigCommand } = await import('@/commands/config.js');
  return runConfigCommand;
};

const importKeys = async () => {
  const { CONFIG_KEYS } = await import('@/libs/config.js');
  return CONFIG_KEYS;
};

describe('runConfigCommand', () => {
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

  const storeAllValues = () => {
    mockGetConfigValue.mockImplementation((key: string) =>
      key === 'apiToken' ? LONG_TOKEN : STORED_DIRECTORY,
    );
  };

  describe('get', () => {
    it('prints every stored key when no key is given', async () => {
      storeAllValues();
      const keys = await importKeys();
      const runConfigCommand = await importCommand();

      await runConfigCommand(['get']);

      expect(console.log).toHaveBeenCalledTimes(keys.length);
      keys.forEach((key) => {
        expect(console.log).toHaveBeenCalledWith(
          expect.stringContaining(`${key}:`),
        );
      });
    });

    it('masks the token to its edges and never prints it in full', async () => {
      storeAllValues();
      const runConfigCommand = await importCommand();

      await runConfigCommand(['get', 'apiToken']);

      expect(console.log).toHaveBeenCalledWith('apiToken: sk_a****wxyz');
      const printedInFull = vi
        .mocked(console.log)
        .mock.calls.some(([line]) => String(line).includes(LONG_TOKEN));
      expect(printedInFull).toBe(false);
    });

    it('fully masks a token too short to reveal edges safely', async () => {
      mockGetConfigValue.mockReturnValue(SHORT_TOKEN);
      const runConfigCommand = await importCommand();

      await runConfigCommand(['get', 'apiToken']);

      expect(console.log).toHaveBeenCalledWith('apiToken: ****');
    });

    it('masks a token exactly one under the reveal threshold', async () => {
      const fifteenCharToken = 'abcdefghijklmno';
      mockGetConfigValue.mockReturnValue(fifteenCharToken);
      const runConfigCommand = await importCommand();

      await runConfigCommand(['get', 'apiToken']);

      expect(console.log).toHaveBeenCalledWith('apiToken: ****');
    });

    it('reveals edges for a token exactly at the reveal threshold', async () => {
      const sixteenCharToken = 'abcdefghijklmnop';
      mockGetConfigValue.mockReturnValue(sixteenCharToken);
      const runConfigCommand = await importCommand();

      await runConfigCommand(['get', 'apiToken']);

      expect(console.log).toHaveBeenCalledWith('apiToken: abcd****mnop');
    });

    it('surfaces a store read failure as a friendly error', async () => {
      mockGetConfigValue.mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });
      const runConfigCommand = await importCommand();

      await runConfigCommand(['get', 'apiToken']);

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Could not read apiToken'),
      );
      expect(process.exitCode).toBe(1);
    });

    it('prints the output directory in full (not sensitive)', async () => {
      storeAllValues();
      const runConfigCommand = await importCommand();

      await runConfigCommand(['get', 'outputDirectory']);

      expect(console.log).toHaveBeenCalledWith(
        `outputDirectory: ${STORED_DIRECTORY}`,
      );
    });

    it('shows "(not set)" for an unset value', async () => {
      mockGetConfigValue.mockReturnValue(undefined);
      const runConfigCommand = await importCommand();

      await runConfigCommand(['get', 'apiToken']);

      expect(console.log).toHaveBeenCalledWith('apiToken: (not set)');
    });

    it('errors on an unknown key and does not read it', async () => {
      const runConfigCommand = await importCommand();

      await runConfigCommand(['get', 'bogus']);

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Unknown config key: bogus'),
      );
      expect(mockGetConfigValue).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });
  });

  describe('set', () => {
    it('stores the value under the given key', async () => {
      const runConfigCommand = await importCommand();

      await runConfigCommand(['set', 'outputDirectory', STORED_DIRECTORY]);

      expect(mockSetConfigValue).toHaveBeenCalledWith(
        'outputDirectory',
        STORED_DIRECTORY,
      );
    });

    it('confirms a token change without echoing the token in full', async () => {
      const runConfigCommand = await importCommand();

      await runConfigCommand(['set', 'apiToken', LONG_TOKEN]);

      expect(mockSetConfigValue).toHaveBeenCalledWith('apiToken', LONG_TOKEN);
      expect(console.log).toHaveBeenCalledWith('Set apiToken to sk_a****wxyz');
      const echoedInFull = vi
        .mocked(console.log)
        .mock.calls.some(([line]) => String(line).includes(LONG_TOKEN));
      expect(echoedInFull).toBe(false);
    });

    it('errors and stores nothing when the value is missing', async () => {
      const runConfigCommand = await importCommand();

      await runConfigCommand(['set', 'apiToken']);

      expect(mockSetConfigValue).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it('errors and stores nothing when the value is an empty string', async () => {
      const runConfigCommand = await importCommand();

      await runConfigCommand(['set', 'apiToken', '']);

      expect(mockSetConfigValue).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it('errors and stores nothing when the value is only whitespace', async () => {
      const runConfigCommand = await importCommand();

      await runConfigCommand(['set', 'apiToken', '   ']);

      expect(mockSetConfigValue).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it('stores the trimmed value', async () => {
      const runConfigCommand = await importCommand();

      await runConfigCommand([
        'set',
        'outputDirectory',
        '  /home/user/notes  ',
      ]);

      expect(mockSetConfigValue).toHaveBeenCalledWith(
        'outputDirectory',
        '/home/user/notes',
      );
    });

    it('errors and stores nothing for an unknown key', async () => {
      const runConfigCommand = await importCommand();

      await runConfigCommand(['set', 'bogus', 'value']);

      expect(mockSetConfigValue).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Unknown config key: bogus'),
      );
      expect(process.exitCode).toBe(1);
    });

    it('surfaces a store write failure as a friendly error', async () => {
      mockSetConfigValue.mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });
      const runConfigCommand = await importCommand();

      await runConfigCommand(['set', 'apiToken', LONG_TOKEN]);

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Could not save apiToken'),
      );
      expect(process.exitCode).toBe(1);
    });
  });

  describe('path', () => {
    it('prints the config file location', async () => {
      mockGetConfigPath.mockReturnValue(CONFIG_FILE_PATH);
      const runConfigCommand = await importCommand();

      await runConfigCommand(['path']);

      expect(console.log).toHaveBeenCalledWith(CONFIG_FILE_PATH);
    });
  });

  it('prints usage on stdout and exits 0 when no subcommand is given', async () => {
    const runConfigCommand = await importCommand();

    await runConfigCommand([]);

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Usage: markpost config'),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('rejects too many arguments to set instead of truncating a value', async () => {
    const runConfigCommand = await importCommand();

    await runConfigCommand(['set', 'outputDirectory', '/My', 'Notes']);

    expect(mockSetConfigValue).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Too many arguments'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('rejects extra arguments to get instead of ignoring them', async () => {
    const runConfigCommand = await importCommand();

    await runConfigCommand(['get', 'apiToken', 'outputDirectory']);

    expect(mockGetConfigValue).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Too many arguments'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('prints usage on stdout for an unrecognized subcommand', async () => {
    const runConfigCommand = await importCommand();

    await runConfigCommand(['bogus']);

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Usage: markpost config'),
    );
    expect(mockSetConfigValue).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});
