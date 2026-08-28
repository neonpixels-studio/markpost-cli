import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { input } from '@inquirer/prompts';
import {
  checkConfig,
  getConfigPath,
  getConfigValue,
  isConfigKey,
  setConfigValue,
} from '@/libs/config.js';

const { mockGet, mockSet, CONFIG_FILE_PATH } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockSet: vi.fn(),
  CONFIG_FILE_PATH: '/home/user/.config/@markpost/cli/config.json',
}));

vi.mock('conf', () => ({
  default: vi.fn().mockImplementation(function () {
    return { get: mockGet, set: mockSet, path: CONFIG_FILE_PATH };
  }),
}));

vi.mock('@inquirer/prompts', () => ({ input: vi.fn() }));

describe('config accessors', () => {
  afterEach(() => {
    mockGet.mockReset();
    mockSet.mockReset();
  });

  it('reads a value through the store', () => {
    mockGet.mockReturnValue('stored-token');
    expect(getConfigValue('apiToken')).toBe('stored-token');
    expect(mockGet).toHaveBeenCalledWith('apiToken');
  });

  it('writes a value through the store', () => {
    setConfigValue('outputDirectory', '/my/dir');
    expect(mockSet).toHaveBeenCalledWith('outputDirectory', '/my/dir');
  });

  it('exposes the store file path', () => {
    expect(getConfigPath()).toBe(CONFIG_FILE_PATH);
  });

  it('recognizes only the persisted keys', () => {
    expect(isConfigKey('apiToken')).toBe(true);
    expect(isConfigKey('outputDirectory')).toBe(true);
    expect(isConfigKey('bogus')).toBe(false);
  });
});

const restoreEnv = (name: string, original: string | undefined): void => {
  if (original === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = original;
};

describe('checkConfig', () => {
  const originalApiToken = process.env.API_TOKEN;
  const originalOutputDirectory = process.env.OUTPUT_DIRECTORY;
  const originalExitCode = process.exitCode;

  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.API_TOKEN;
    delete process.env.OUTPUT_DIRECTORY;
    // The fix never calls process.exit anymore — it sets process.exitCode so
    // the async stderr diagnostic can flush on a pipe before exit. Spy on
    // process.exit purely to prove it is not called, and reset exitCode so
    // each test observes only what checkConfig sets.
    process.exitCode = 0;
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    // Restore precisely: assigning an `undefined` original would coerce to the
    // string "undefined" (truthy), leaking a bogus token to the rest of the run.
    restoreEnv('API_TOKEN', originalApiToken);
    restoreEnv('OUTPUT_DIRECTORY', originalOutputDirectory);
    process.exitCode = originalExitCode;
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    mockGet.mockReset();
    mockSet.mockReset();
    vi.mocked(input).mockReset();
  });

  it('resolves true without prompting when both configs are stored', async () => {
    mockGet.mockReturnValue('stored-value');
    await expect(checkConfig()).resolves.toBe(true);
    expect(input).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it('sets both values from env vars without prompting when both are set', async () => {
    mockGet.mockReturnValue(undefined);
    process.env.API_TOKEN = 'env-token';
    process.env.OUTPUT_DIRECTORY = '/env/dir';

    await expect(checkConfig()).resolves.toBe(true);

    expect(mockSet).toHaveBeenCalledWith('apiToken', 'env-token');
    expect(mockSet).toHaveBeenCalledWith('outputDirectory', '/env/dir');
    expect(input).not.toHaveBeenCalled();
  });

  it('still prompts for outputDirectory when API_TOKEN comes from env and directory is unset', async () => {
    mockGet.mockReturnValue(undefined);
    process.env.API_TOKEN = 'env-token';
    vi.mocked(input).mockResolvedValue('/prompted/dir');

    await expect(checkConfig()).resolves.toBe(true);

    expect(mockSet).toHaveBeenCalledWith('apiToken', 'env-token');
    expect(input).toHaveBeenCalledTimes(1);
    expect(input).toHaveBeenCalledWith({ message: 'Output Directory' });
    expect(mockSet).toHaveBeenCalledWith('outputDirectory', '/prompted/dir');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('trims surrounding whitespace from a prompted value before storing it', async () => {
    mockGet.mockReturnValue(undefined);
    process.env.API_TOKEN = 'env-token';
    vi.mocked(input).mockResolvedValue('  ~/notes  ');

    await checkConfig();

    expect(mockSet).toHaveBeenCalledWith('outputDirectory', '~/notes');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('prompts for both values in order when neither is set', async () => {
    mockGet.mockReturnValue(undefined);
    vi.mocked(input)
      .mockResolvedValueOnce('my-token')
      .mockResolvedValueOnce('/my/dir');

    await expect(checkConfig()).resolves.toBe(true);

    expect(input).toHaveBeenCalledTimes(2);
    expect(vi.mocked(input).mock.calls[0][0]).toEqual({
      message: 'Sync API Token',
    });
    expect(vi.mocked(input).mock.calls[1][0]).toEqual({
      message: 'Output Directory',
    });
  });

  it('stops at the first field when its prompt is empty, never prompting the second', async () => {
    mockGet.mockReturnValue(undefined);
    vi.mocked(input).mockResolvedValue('');

    await expect(checkConfig()).resolves.toBe(false);

    // Only the token was prompted: the false short-circuit kept the second
    // field (Output Directory) from ever rendering a prompt.
    expect(input).toHaveBeenCalledTimes(1);
    expect(vi.mocked(input).mock.calls[0][0]).toEqual({
      message: 'Sync API Token',
    });
    expect(process.exitCode).toBe(1);
  });

  describe('--json mode', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      logSpy.mockRestore();
    });

    it('never prompts when a value is missing and resolves false', async () => {
      mockGet.mockReturnValue(undefined);

      await expect(checkConfig(true)).resolves.toBe(false);

      expect(input).not.toHaveBeenCalled();
    });

    it('writes nothing to stdout and emits one structured error to stderr, flagging a non-zero exit without calling process.exit', async () => {
      mockGet.mockReturnValue(undefined);

      // The return value is the real short-circuit now — no reliance on
      // process.exit terminating — so the second field is never reached and
      // exactly one diagnostic is emitted, the guarantee `--json | jq` needs.
      await expect(checkConfig(true)).resolves.toBe(false);

      // stdout is the data channel `--json | jq` reads: it must stay empty.
      expect(logSpy).not.toHaveBeenCalled();
      // Exactly one diagnostic, on stderr, and it is parseable JSON.
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const stderr = errorSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(stderr);
      expect(parsed).toMatchObject({
        error: 'config_required',
        missing: 'apiToken',
      });
      expect(parsed.message).toContain('API_TOKEN');
      // The diagnostic must survive on a pipe: exit via exitCode, never a
      // non-flushing process.exit.
      expect(process.exitCode).toBe(1);
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('reports the outputDirectory field when only the token is stored', async () => {
      mockGet.mockImplementation((key: string) =>
        key === 'apiToken' ? 'stored-token' : undefined,
      );

      await expect(checkConfig(true)).resolves.toBe(false);

      const stderr = errorSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(stderr);
      expect(parsed).toMatchObject({
        error: 'config_required',
        missing: 'outputDirectory',
      });
      expect(parsed.message).toContain('OUTPUT_DIRECTORY');
      expect(process.exitCode).toBe(1);
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('still resolves values from env vars without prompting or erroring', async () => {
      mockGet.mockReturnValue(undefined);
      process.env.API_TOKEN = 'env-token';
      process.env.OUTPUT_DIRECTORY = '/env/dir';

      await expect(checkConfig(true)).resolves.toBe(true);

      expect(input).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(0);
      expect(mockSet).toHaveBeenCalledWith('apiToken', 'env-token');
      expect(mockSet).toHaveBeenCalledWith('outputDirectory', '/env/dir');
    });

    it('resolves true silently when both values are already stored', async () => {
      mockGet.mockReturnValue('stored-value');

      await expect(checkConfig(true)).resolves.toBe(true);

      expect(input).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(0);
    });
  });

  describe('apiToken', () => {
    beforeEach(() => {
      mockGet.mockImplementation((key: string) =>
        key === 'outputDirectory' ? '/stored/dir' : undefined,
      );
    });

    it('sets token from API_TOKEN env var and returns', async () => {
      process.env.API_TOKEN = 'env-token';
      await checkConfig();
      expect(mockSet).toHaveBeenCalledWith('apiToken', 'env-token');
      expect(input).not.toHaveBeenCalled();
    });

    it('prompts and sets token when not in env or config', async () => {
      vi.mocked(input).mockResolvedValue('my-token');
      await checkConfig();
      expect(mockSet).toHaveBeenCalledWith('apiToken', 'my-token');
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('logs error and flags a non-zero exit when token prompt is empty', async () => {
      vi.mocked(input).mockResolvedValue('');
      await expect(checkConfig()).resolves.toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Sync API Token is required!'),
      );
      expect(process.exitCode).toBe(1);
      expect(exitSpy).not.toHaveBeenCalled();
      // The false return keeps an empty answer out of the store without relying
      // on process.exit to terminate mid-function.
      expect(mockSet).not.toHaveBeenCalledWith('apiToken', '');
    });
  });

  describe('outputDirectory', () => {
    beforeEach(() => {
      mockGet.mockImplementation((key: string) =>
        key === 'apiToken' ? 'stored-token' : undefined,
      );
    });

    it('sets directory from OUTPUT_DIRECTORY env var and returns', async () => {
      process.env.OUTPUT_DIRECTORY = '/env/dir';
      await checkConfig();
      expect(mockSet).toHaveBeenCalledWith('outputDirectory', '/env/dir');
      expect(input).not.toHaveBeenCalled();
    });

    it('still prompts for apiToken when OUTPUT_DIRECTORY comes from env and token is unset', async () => {
      mockGet.mockReturnValue(undefined);
      process.env.OUTPUT_DIRECTORY = '/env/dir';
      vi.mocked(input).mockResolvedValue('my-token');

      await checkConfig();

      expect(input).toHaveBeenCalledTimes(1);
      expect(input).toHaveBeenCalledWith({ message: 'Sync API Token' });
      expect(mockSet).toHaveBeenCalledWith('apiToken', 'my-token');
      expect(mockSet).toHaveBeenCalledWith('outputDirectory', '/env/dir');
    });

    it('prompts and sets directory when not in env or config', async () => {
      vi.mocked(input).mockResolvedValue('/my/dir');
      await checkConfig();
      expect(mockSet).toHaveBeenCalledWith('outputDirectory', '/my/dir');
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('logs error and flags a non-zero exit when directory prompt is empty', async () => {
      vi.mocked(input).mockResolvedValue('');
      await expect(checkConfig()).resolves.toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Output Directory is required!'),
      );
      expect(process.exitCode).toBe(1);
      expect(exitSpy).not.toHaveBeenCalled();
      // The false return keeps an empty answer out of the store without relying
      // on process.exit to terminate mid-function.
      expect(mockSet).not.toHaveBeenCalledWith('outputDirectory', '');
    });
  });
});
