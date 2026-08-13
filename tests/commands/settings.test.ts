import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UserSettings } from '@/types/settings.types.js';

vi.mock('@/libs/config.js', () => ({ checkConfig: vi.fn() }));
vi.mock('@/libs/settings.js', async (importOriginal) => {
  // Keep the real `resolveSyncSettings` (pure normalizer the command reuses to
  // print) and only stub the two network seams, so the tests exercise the real
  // print path against mocked API responses.
  const actual =
    await importOriginal<typeof import('@/libs/settings.js')>();

  return {
    ...actual,
    fetchSettings: vi.fn(),
    updateSettings: vi.fn(),
  };
});
vi.mock('chalk', () => ({
  default: {
    redBright: vi.fn((value: unknown) => value),
    greenBright: vi.fn((value: unknown) => value),
  },
}));

const mockSettings: UserSettings = {
  userId: 'user-1',
  vaultDir: '01-inbox/',
  filenameTemplate: '{{title}}',
  autoSync: true,
  autoDelete: false,
  frontmatter: true,
  conflictStrategy: 'overwrite',
  theme: 'system',
  accentColor: '#a855f7',
  updatedAt: '2024-01-01T00:00:00Z',
};

// Collapse every console.log/error argument into one searchable string so an
// assertion can't be dodged by output landing in a later call or the other
// stream.
const loggedText = (): string =>
  [
    ...vi.mocked(console.log).mock.calls,
    ...vi.mocked(console.error).mock.calls,
  ]
    .flat()
    .map((value) => String(value))
    .join('\n');

describe('runSettingsCommand', () => {
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

  it('checks config before dispatching a valid subcommand', async () => {
    const { checkConfig } = await import('@/libs/config.js');
    const { fetchSettings } = await import('@/libs/settings.js');
    vi.mocked(fetchSettings).mockResolvedValue({
      ok: true,
      settings: mockSettings,
    });
    const { runSettingsCommand } = await import('@/commands/settings.js');

    await runSettingsCommand(['get']);

    expect(checkConfig).toHaveBeenCalled();
  });

  it('gates the handler on config: a rejected config check runs no API call', async () => {
    const { checkConfig } = await import('@/libs/config.js');
    vi.mocked(checkConfig).mockRejectedValueOnce(new Error('not configured'));
    const { fetchSettings } = await import('@/libs/settings.js');
    const { runSettingsCommand } = await import('@/commands/settings.js');

    await runSettingsCommand(['get']);

    expect(fetchSettings).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('errors to stderr and exits 1 when no subcommand is given', async () => {
    const { checkConfig } = await import('@/libs/config.js');
    const { runSettingsCommand } = await import('@/commands/settings.js');

    await runSettingsCommand([]);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('No subcommand given.'),
    );
    expect(checkConfig).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('errors to stderr and exits 1 for an unknown subcommand', async () => {
    const { checkConfig } = await import('@/libs/config.js');
    const { runSettingsCommand } = await import('@/commands/settings.js');

    await runSettingsCommand(['bogus']);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Unknown subcommand: bogus'),
    );
    expect(checkConfig).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('exits non-zero when a settings call throws', async () => {
    const { fetchSettings } = await import('@/libs/settings.js');
    vi.mocked(fetchSettings).mockRejectedValue(new Error('boom'));
    const { runSettingsCommand } = await import('@/commands/settings.js');

    await runSettingsCommand(['get']);

    expect(process.exitCode).toBe(1);
  });
});

describe('settings get', () => {
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

  it('prints the current settings on a successful read', async () => {
    const { fetchSettings } = await import('@/libs/settings.js');
    vi.mocked(fetchSettings).mockResolvedValue({
      ok: true,
      settings: mockSettings,
    });
    const { runSettingsCommand } = await import('@/commands/settings.js');

    await runSettingsCommand(['get']);

    const output = loggedText();
    expect(output).toContain('autoSync:         true');
    expect(output).toContain('autoDelete:       false');
    expect(output).toContain('frontmatter:      true');
    expect(output).toContain('conflictStrategy: overwrite');
    expect(process.exitCode).toBeUndefined();
  });

  it('prints markpost defaults when the account has no saved row', async () => {
    const { fetchSettings } = await import('@/libs/settings.js');
    vi.mocked(fetchSettings).mockResolvedValue({ ok: true, settings: null });
    const { runSettingsCommand } = await import('@/commands/settings.js');

    await runSettingsCommand(['get']);

    const output = loggedText();
    expect(output).toContain('No saved settings on this account');
    expect(output).toContain('conflictStrategy: suffix');
    expect(output).toContain('autoDelete:       true');
  });

  it('fails loud (stderr + exit 1) when the read fails', async () => {
    const { fetchSettings } = await import('@/libs/settings.js');
    vi.mocked(fetchSettings).mockResolvedValue({ ok: false });
    const { runSettingsCommand } = await import('@/commands/settings.js');

    await runSettingsCommand(['get']);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Could not read settings'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('rejects extra arguments to `get`', async () => {
    const { fetchSettings } = await import('@/libs/settings.js');
    const { runSettingsCommand } = await import('@/commands/settings.js');

    await runSettingsCommand(['get', 'autoSync=true']);

    expect(fetchSettings).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

describe('settings set', () => {
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

  it('sends the parsed fields as the update payload and prints the result', async () => {
    const { updateSettings } = await import('@/libs/settings.js');
    vi.mocked(updateSettings).mockResolvedValue({
      ...mockSettings,
      autoDelete: false,
      conflictStrategy: 'overwrite',
    });
    const { runSettingsCommand } = await import('@/commands/settings.js');

    await runSettingsCommand([
      'set',
      'autoDelete=false',
      'conflictStrategy=overwrite',
    ]);

    expect(updateSettings).toHaveBeenCalledWith({
      autoDelete: false,
      conflictStrategy: 'overwrite',
    });
    expect(loggedText()).toContain('Settings updated.');
    expect(loggedText()).toContain('conflictStrategy: overwrite');
    expect(process.exitCode).toBeUndefined();
  });

  it('coerces the string "true"/"false" to real booleans in the payload', async () => {
    const { updateSettings } = await import('@/libs/settings.js');
    vi.mocked(updateSettings).mockResolvedValue(mockSettings);
    const { runSettingsCommand } = await import('@/commands/settings.js');

    await runSettingsCommand(['set', 'autoSync=false', 'frontmatter=true']);

    expect(updateSettings).toHaveBeenCalledWith({
      autoSync: false,
      frontmatter: true,
    });
  });

  it('errors and never calls the API when no fields are given', async () => {
    const { updateSettings } = await import('@/libs/settings.js');
    const { runSettingsCommand } = await import('@/commands/settings.js');

    await runSettingsCommand(['set']);

    expect(updateSettings).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('No fields to set'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('rejects an unknown field name without calling the API', async () => {
    const { updateSettings } = await import('@/libs/settings.js');
    const { runSettingsCommand } = await import('@/commands/settings.js');

    await runSettingsCommand(['set', 'theme=dark']);

    expect(updateSettings).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Unknown setting: `theme`'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('rejects an inherited object member name as an unknown setting', async () => {
    const { updateSettings } = await import('@/libs/settings.js');
    const { runSettingsCommand } = await import('@/commands/settings.js');

    await runSettingsCommand(['set', 'toString=false']);

    expect(updateSettings).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Unknown setting: `toString`'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('rejects a non-boolean value for a boolean field', async () => {
    const { updateSettings } = await import('@/libs/settings.js');
    const { runSettingsCommand } = await import('@/commands/settings.js');

    await runSettingsCommand(['set', 'autoSync=yes']);

    expect(updateSettings).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('autoSync:'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('rejects an off-contract conflictStrategy value', async () => {
    const { updateSettings } = await import('@/libs/settings.js');
    const { runSettingsCommand } = await import('@/commands/settings.js');

    await runSettingsCommand(['set', 'conflictStrategy=merge']);

    expect(updateSettings).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('conflictStrategy:'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('rejects a token with no `=` separator', async () => {
    const { updateSettings } = await import('@/libs/settings.js');
    const { runSettingsCommand } = await import('@/commands/settings.js');

    await runSettingsCommand(['set', 'autoSync']);

    expect(updateSettings).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Invalid field `autoSync`'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('rejects a repeated key rather than silently last-wins', async () => {
    const { updateSettings } = await import('@/libs/settings.js');
    const { runSettingsCommand } = await import('@/commands/settings.js');

    await runSettingsCommand(['set', 'autoDelete=true', 'autoDelete=false']);

    expect(updateSettings).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('autoDelete: given more than once.'),
    );
    expect(process.exitCode).toBe(1);
  });

  // splitPair keeps everything after the first `=` as the value, so a value
  // carrying its own `=` is validated intact (here rejected as off-contract)
  // rather than truncated to `over`.
  it('does not truncate a value that contains an `=`', async () => {
    const { updateSettings } = await import('@/libs/settings.js');
    const { runSettingsCommand } = await import('@/commands/settings.js');

    await runSettingsCommand(['set', 'conflictStrategy=over=write']);

    expect(updateSettings).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('over=write'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('stops at the first invalid field and sends nothing', async () => {
    const { updateSettings } = await import('@/libs/settings.js');
    const { runSettingsCommand } = await import('@/commands/settings.js');

    await runSettingsCommand(['set', 'autoSync=true', 'bogus=1']);

    expect(updateSettings).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('fails loud (stderr + exit 1) when the update call returns null', async () => {
    const { updateSettings } = await import('@/libs/settings.js');
    vi.mocked(updateSettings).mockResolvedValue(null);
    const { runSettingsCommand } = await import('@/commands/settings.js');

    await runSettingsCommand(['set', 'autoSync=true']);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to update settings.'),
    );
    expect(process.exitCode).toBe(1);
  });
});
