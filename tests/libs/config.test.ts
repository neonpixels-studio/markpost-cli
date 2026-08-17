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

describe('checkConfig', () => {
  const originalApiToken = process.env.API_TOKEN;
  const originalOutputDirectory = process.env.OUTPUT_DIRECTORY;

  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.API_TOKEN;
    delete process.env.OUTPUT_DIRECTORY;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.API_TOKEN = originalApiToken;
    process.env.OUTPUT_DIRECTORY = originalOutputDirectory;
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    mockGet.mockReset();
    mockSet.mockReset();
    vi.mocked(input).mockReset();
  });

  it('returns without prompting when both configs are stored', async () => {
    mockGet.mockReturnValue('stored-value');
    await checkConfig();
    expect(input).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('sets both values from env vars without prompting when both are set', async () => {
    mockGet.mockReturnValue(undefined);
    process.env.API_TOKEN = 'env-token';
    process.env.OUTPUT_DIRECTORY = '/env/dir';

    await checkConfig();

    expect(mockSet).toHaveBeenCalledWith('apiToken', 'env-token');
    expect(mockSet).toHaveBeenCalledWith('outputDirectory', '/env/dir');
    expect(input).not.toHaveBeenCalled();
  });

  it('still prompts for outputDirectory when API_TOKEN comes from env and directory is unset', async () => {
    mockGet.mockReturnValue(undefined);
    process.env.API_TOKEN = 'env-token';
    vi.mocked(input).mockResolvedValue('/prompted/dir');

    await checkConfig();

    expect(mockSet).toHaveBeenCalledWith('apiToken', 'env-token');
    expect(input).toHaveBeenCalledTimes(1);
    expect(input).toHaveBeenCalledWith({ message: 'Output Directory' });
    expect(mockSet).toHaveBeenCalledWith('outputDirectory', '/prompted/dir');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('prompts for both values in order when neither is set', async () => {
    mockGet.mockReturnValue(undefined);
    vi.mocked(input).mockResolvedValueOnce('my-token').mockResolvedValueOnce('/my/dir');

    await checkConfig();

    expect(input).toHaveBeenCalledTimes(2);
    expect(vi.mocked(input).mock.calls[0][0]).toEqual({ message: 'Sync API Token' });
    expect(vi.mocked(input).mock.calls[1][0]).toEqual({ message: 'Output Directory' });
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

    it('logs error and exits when token prompt is empty', async () => {
      vi.mocked(input).mockResolvedValue('');
      await checkConfig();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Sync API Token is required!'));
      expect(exitSpy).toHaveBeenCalledWith(1);
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

    it('logs error and exits when directory prompt is empty', async () => {
      vi.mocked(input).mockResolvedValue('');
      await checkConfig();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Output Directory is required!'));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});
