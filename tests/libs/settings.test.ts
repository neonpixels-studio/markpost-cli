import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchSettings,
  resolveSyncSettings,
  updateSettings,
} from '@/libs/settings.js';
import { ApiTimeoutError } from '@/libs/api.js';
import { logErrorMessage } from '@/libs/errors.js';
import {
  DEFAULT_AUTO_SYNC,
  DEFAULT_CONFLICT_STRATEGY,
  DEFAULT_FRONTMATTER_ENABLED,
  UserSettings,
} from '@/types/settings.types.js';

// @/libs/api.js imports @/libs/config.js, which constructs a real
// `conf`-backed store as soon as it's loaded. Mock it so loading api.js
// doesn't pull in that side effect (see tests/libs/sources.test.ts).
vi.mock('@/libs/config.js', () => ({
  config: { get: vi.fn() },
}));

// Drive the external-service seams (base URL, token) through the env vars the
// real `getBaseUrl`/`getApiToken` read, so the shared `authedRequest` helper
// in @/libs/api.js resolves them the same way production does. Overriding the
// exports wouldn't reach `authedRequest`, which calls those functions
// internally. `vi.stubEnv` scopes and auto-restores the values so nothing
// leaks into other test files sharing the worker. The real response-parsing
// helpers stay in place so this exercises production logic.
beforeEach(() => {
  vi.stubEnv('BASE_URL', 'https://example.com');
  vi.stubEnv('API_TOKEN', 'test-token');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

vi.mock('@/libs/errors.js', () => ({
  logErrorMessage: vi.fn(),
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

function mockFetch(responseBody: object, ok = true) {
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    json: () => Promise.resolve(responseBody),
  });
}

function mockFetchTimeout() {
  global.fetch = vi
    .fn()
    .mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
}

describe('fetchSettings', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  // A timeout must escape the resilient `{ ok: false }` fallback so the sync
  // fails loud instead of silently using default settings on a stalled read.
  it('propagates a timeout as ApiTimeoutError instead of returning ok:false', async () => {
    mockFetchTimeout();

    await expect(fetchSettings()).rejects.toBeInstanceOf(ApiTimeoutError);
  });

  it('calls fetch with the settings URL and auth header', async () => {
    mockFetch({ data: { attributes: mockSettings } });

    await fetchSettings();

    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com/api/settings',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-token' },
      }),
    );
  });

  it('returns ok with the settings attributes on success', async () => {
    mockFetch({ data: { attributes: mockSettings } });

    expect(await fetchSettings()).toEqual({ ok: true, settings: mockSettings });
  });

  it('extracts attributes from a full JSON:API resource object', async () => {
    mockFetch({
      data: {
        type: 'user_settings',
        id: mockSettings.userId,
        attributes: mockSettings,
        links: { self: '/api/settings' },
      },
    });

    expect(await fetchSettings()).toEqual({ ok: true, settings: mockSettings });
  });

  it('returns a failure result and logs when a non-2xx response carries errors', async () => {
    mockFetch(
      { data: { errors: [{ title: 'Unauthorized', detail: 'No token' }] } },
      false,
    );

    expect(await fetchSettings()).toEqual({ ok: false });
    expect(logErrorMessage).toHaveBeenCalledWith(
      'fetchSettings',
      expect.stringContaining('Unauthorized'),
    );
  });

  it('returns null and logs when a 2xx body still carries data.errors', async () => {
    mockFetch(
      { data: { errors: [{ title: 'Conflict', detail: 'bad state' }] } },
      true,
    );

    expect(await fetchSettings()).toEqual({ ok: false });
    expect(logErrorMessage).toHaveBeenCalledWith(
      'fetchSettings',
      expect.stringContaining('Conflict'),
    );
  });

  it('returns null and logs when a 2xx body carries a top-level errors array', async () => {
    mockFetch(
      { errors: [{ title: 'Teapot', detail: 'short and stout' }] },
      true,
    );

    expect(await fetchSettings()).toEqual({ ok: false });
    expect(logErrorMessage).toHaveBeenCalledWith(
      'fetchSettings',
      expect.stringContaining('Teapot'),
    );
  });

  it('returns null and logs when fetch rejects', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network down'));

    expect(await fetchSettings()).toEqual({ ok: false });
    expect(logErrorMessage).toHaveBeenCalledWith(
      'fetchSettings',
      'Network down',
    );
  });

  it('returns ok with null settings when the success body has no data (no saved row yet)', async () => {
    mockFetch({ data: null });

    expect(await fetchSettings()).toEqual({ ok: true, settings: null });
  });
});

describe('updateSettings', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('calls fetch with PUT, correct headers, and JSON:API body', async () => {
    mockFetch({ data: { attributes: mockSettings } });

    await updateSettings({ autoDelete: false, conflictStrategy: 'overwrite' });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com/api/settings',
      expect.objectContaining({
        method: 'PUT',
        headers: {
          'Content-Type': 'application/vnd.api+json',
          Authorization: 'Bearer test-token',
        },
        body: JSON.stringify({
          data: {
            type: 'user_settings',
            attributes: { autoDelete: false, conflictStrategy: 'overwrite' },
          },
        }),
      }),
    );
  });

  it('returns the updated settings attributes on success', async () => {
    mockFetch({ data: { attributes: mockSettings } });

    expect(await updateSettings({ autoSync: true })).toEqual(mockSettings);
  });

  it('returns null and logs when a non-2xx response carries errors', async () => {
    mockFetch(
      { data: { errors: [{ title: 'Unauthorized', detail: 'No token' }] } },
      false,
    );

    expect(await updateSettings({ autoSync: true })).toBeNull();
    expect(logErrorMessage).toHaveBeenCalledWith(
      'updateSettings',
      expect.stringContaining('Unauthorized'),
    );
  });

  it('returns null and logs when fetch rejects', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network down'));

    expect(await updateSettings({ frontmatter: false })).toBeNull();
    expect(logErrorMessage).toHaveBeenCalledWith(
      'updateSettings',
      'Network down',
    );
  });

  // A timeout must escape the resilient `null` fallback so a write that stalled
  // surfaces loudly rather than silently reporting "failed to update".
  it('propagates a timeout as ApiTimeoutError instead of returning null', async () => {
    mockFetchTimeout();

    await expect(updateSettings({ autoSync: true })).rejects.toBeInstanceOf(
      ApiTimeoutError,
    );
  });
});

describe('resolveSyncSettings', () => {
  it('falls back conservatively when the read failed', () => {
    const resolved = resolveSyncSettings({ ok: false });

    expect(resolved).toEqual({
      conflictStrategy: DEFAULT_CONFLICT_STRATEGY,
      autoDelete: false,
      autoSync: false,
      includeFrontmatter: DEFAULT_FRONTMATTER_ENABLED,
    });
  });

  it('passes through the normalized fields of a successful read', () => {
    const resolved = resolveSyncSettings({
      ok: true,
      settings: {
        ...mockSettings,
        conflictStrategy: 'overwrite',
        autoDelete: true,
        autoSync: false,
        frontmatter: false,
      },
    });

    expect(resolved).toEqual({
      conflictStrategy: 'overwrite',
      autoDelete: true,
      autoSync: false,
      includeFrontmatter: false,
    });
  });

  it('uses markpost schema defaults when the account has no saved row', () => {
    const resolved = resolveSyncSettings({ ok: true, settings: null });

    expect(resolved).toEqual({
      conflictStrategy: DEFAULT_CONFLICT_STRATEGY,
      autoDelete: true,
      autoSync: DEFAULT_AUTO_SYNC,
      includeFrontmatter: DEFAULT_FRONTMATTER_ENABLED,
    });
  });

  it('falls back to defaults for off-contract boolean values on a successful read', () => {
    const resolved = resolveSyncSettings({
      ok: true,
      settings: {
        ...mockSettings,
        // Wire values the server should never send, but the CLI must not trust:
        autoSync: 'false' as unknown as boolean,
        frontmatter: 0 as unknown as boolean,
        autoDelete: 'true' as unknown as boolean,
      },
    });

    expect(resolved.autoSync).toBe(DEFAULT_AUTO_SYNC);
    expect(resolved.includeFrontmatter).toBe(DEFAULT_FRONTMATTER_ENABLED);
    expect(resolved.autoDelete).toBe(true);
  });
});
