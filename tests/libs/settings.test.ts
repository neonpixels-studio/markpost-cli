import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchSettings } from '@/libs/settings.js';
import { logErrorMessage } from '@/libs/errors.js';
import { UserSettings } from '@/types/settings.types.js';

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

describe('fetchSettings', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
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
