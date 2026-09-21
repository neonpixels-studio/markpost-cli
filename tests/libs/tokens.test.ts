import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createToken,
  fetchTokens,
  revokeToken,
} from '@/libs/tokens.js';
import { ApiTimeoutError } from '@/libs/api.js';
import { logErrorMessage } from '@/libs/errors.js';
import { Token } from '@/types/tokens.types.js';

// @/libs/api.js imports @/libs/config.js, which constructs a real
// `conf`-backed store (touching the developer's actual config directory) as
// soon as it's loaded. Mock it so loading api.js doesn't pull in that side
// effect — API_TOKEN below resolves the token before the store is consulted.
vi.mock('@/libs/config.js', () => ({
  config: { get: vi.fn() },
}));

// Drive the external-service seams (base URL, token) through the env vars the
// real `getBaseUrl`/`getApiToken` read, so the shared `authedRequest` helper
// in @/libs/api.js resolves them the same way production does. `vi.stubEnv`
// scopes and auto-restores the values so nothing leaks into other test files
// sharing the worker.
beforeEach(() => {
  vi.stubEnv('BASE_URL', 'https://example.com');
  vi.stubEnv('API_TOKEN', 'test-token');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

vi.mock('@/libs/errors.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/libs/errors.js')>()),
  logErrorMessage: vi.fn(),
}));

const mockToken: Token = {
  id: 'tok-abc-123',
  name: 'CI token',
  prefix: 'mp_live_ab12',
  createdAt: '2024-01-01T00:00:00Z',
  lastUsedAt: null,
  expiresAt: null,
  scopes: null,
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

// A timeout must escape each function's resilient fallback ([] or null/false)
// so the command fails loud instead of looking like an empty result on a
// stalled server. All three token calls flow through the same seam.
describe('tokens API timeout propagation', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('fetchTokens rejects with ApiTimeoutError instead of returning []', async () => {
    mockFetchTimeout();
    await expect(fetchTokens()).rejects.toBeInstanceOf(ApiTimeoutError);
  });

  it('createToken rejects with ApiTimeoutError instead of returning null', async () => {
    mockFetchTimeout();
    await expect(createToken({ name: 'n' })).rejects.toBeInstanceOf(
      ApiTimeoutError,
    );
  });

  it('revokeToken rejects with ApiTimeoutError instead of returning false', async () => {
    mockFetchTimeout();
    await expect(revokeToken('tok-abc-123')).rejects.toBeInstanceOf(
      ApiTimeoutError,
    );
  });
});

describe('fetchTokens', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('calls fetch with the correct URL and auth header', async () => {
    mockFetch({ data: [{ attributes: mockToken }] });
    await fetchTokens();
    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com/api/tokens',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-token' },
      }),
    );
  });

  it('returns the list of token attributes on success', async () => {
    mockFetch({ data: [{ attributes: mockToken }] });
    expect(await fetchTokens()).toEqual([mockToken]);
  });

  it('extracts attributes from full JSON:API resource objects in a list response', async () => {
    mockFetch({
      data: [
        {
          type: 'api_tokens',
          id: mockToken.id,
          attributes: mockToken,
          links: { self: `/api/tokens/${mockToken.id}` },
        },
      ],
    });
    expect(await fetchTokens()).toEqual([mockToken]);
  });

  it('returns [] and surfaces error details when the response is ok but carries errors', async () => {
    mockFetch(
      { data: { errors: [{ title: 'Error', detail: 'Server error' }] } },
      true,
    );
    expect(await fetchTokens()).toEqual([]);
    expect(logErrorMessage).toHaveBeenCalledWith(
      'fetchTokens',
      'Error: Server error',
    );
  });

  it('returns [] and surfaces error details when the response is not ok', async () => {
    mockFetch(
      { data: { errors: [{ title: 'Error', detail: 'Server error' }] } },
      false,
    );
    expect(await fetchTokens()).toEqual([]);
    expect(logErrorMessage).toHaveBeenCalledWith(
      'fetchTokens',
      'Error: Server error',
    );
  });

  it('returns [] on network failure', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
    expect(await fetchTokens()).toEqual([]);
  });

  it('skips a resource with no attributes and reports the count', async () => {
    mockFetch({
      data: [{ attributes: mockToken }, { type: 'api_tokens', id: 'x' }],
    });

    expect(await fetchTokens()).toEqual([mockToken]);
    expect(logErrorMessage).toHaveBeenCalledWith(
      'fetchTokens',
      'Skipped 1 token(s) with no attributes',
    );
  });

  it('skips a resource with attributes explicitly null', async () => {
    mockFetch({
      data: [
        { attributes: mockToken },
        { type: 'api_tokens', attributes: null },
      ],
    });

    expect(await fetchTokens()).toEqual([mockToken]);
    expect(logErrorMessage).toHaveBeenCalledWith(
      'fetchTokens',
      'Skipped 1 token(s) with no attributes',
    );
  });
});

describe('createToken', () => {
  const mintedToken = { ...mockToken, token: 'mp_live_rawsecretvalue' };

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('calls fetch with POST, correct headers, and JSON:API body', async () => {
    mockFetch({ data: { attributes: mintedToken } });
    await createToken({ name: 'CI token' });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com/api/tokens',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/vnd.api+json',
          Authorization: 'Bearer test-token',
        },
        body: JSON.stringify({
          data: {
            type: 'api_tokens',
            attributes: { name: 'CI token' },
          },
        }),
      }),
    );
  });

  it('includes expiresInDays in the request body when given', async () => {
    mockFetch({ data: { attributes: mintedToken } });
    await createToken({ name: 'CI token', expiresInDays: 90 });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com/api/tokens',
      expect.objectContaining({
        body: JSON.stringify({
          data: {
            type: 'api_tokens',
            attributes: { name: 'CI token', expiresInDays: 90 },
          },
        }),
      }),
    );
  });

  it('returns the token attributes, including the revealed secret, on success', async () => {
    mockFetch({ data: { attributes: mintedToken } });
    expect(await createToken({ name: 'CI token' })).toEqual(mintedToken);
  });

  it('extracts attributes from a full JSON:API resource object (type/id/links included)', async () => {
    mockFetch({
      data: {
        type: 'api_tokens',
        id: mockToken.id,
        attributes: mintedToken,
        links: { self: `/api/tokens/${mockToken.id}` },
      },
    });
    expect(await createToken({ name: 'CI token' })).toEqual(mintedToken);
  });

  it('returns null and surfaces error details when the response contains errors', async () => {
    mockFetch(
      {
        data: {
          errors: [
            {
              title: 'Invalid Attribute',
              detail:
                'ExpiresInDays must be a whole number between 1 and 3650',
            },
          ],
        },
      },
      false,
    );
    const result = await createToken({ name: 'CI token', expiresInDays: -1 });
    expect(result).toBeNull();
    expect(logErrorMessage).toHaveBeenCalledWith(
      'createToken["CI token"]',
      'Invalid Attribute: ExpiresInDays must be a whole number between 1 and 3650',
    );
  });

  it('returns null on network failure', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
    expect(await createToken({ name: 'CI token' })).toBeNull();
  });
});

describe('revokeToken', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('calls fetch with DELETE and the id in the URL', async () => {
    mockFetch({ data: null });
    await revokeToken('tok-abc-123');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com/api/tokens/tok-abc-123',
      expect.objectContaining({
        method: 'DELETE',
        headers: { Authorization: 'Bearer test-token' },
      }),
    );
  });

  it('encodes the id into the URL path', async () => {
    mockFetch({ data: null });
    await revokeToken('a/../b');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com/api/tokens/a%2F..%2Fb',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('returns true on success', async () => {
    mockFetch({ data: null });
    expect(await revokeToken('tok-abc-123')).toBe(true);
  });

  it('returns false and surfaces error details when the id is not found', async () => {
    mockFetch(
      {
        data: {
          errors: [{ title: 'Not Found', detail: 'Token not found' }],
        },
      },
      false,
    );
    const result = await revokeToken('missing-id');
    expect(result).toBe(false);
    expect(logErrorMessage).toHaveBeenCalledWith(
      'revokeToken["missing-id"]',
      'Not Found: Token not found',
    );
  });

  it('returns false on network failure', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
    expect(await revokeToken('tok-abc-123')).toBe(false);
  });
});
