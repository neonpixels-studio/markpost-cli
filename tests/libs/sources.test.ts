import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createSource,
  deleteSource,
  fetchSources,
  updateSource,
} from '@/libs/sources.js';
import { logErrorMessage } from '@/libs/errors.js';
import { ApiDeleteMeta } from '@/types/api.types.js';
import { Source } from '@/types/sources.types.js';

// @/libs/api.js imports @/libs/config.js, which constructs a real
// `conf`-backed store (touching the developer's actual config directory) as
// soon as it's loaded. Mock it so loading api.js doesn't pull in that side
// effect — API_TOKEN below resolves the token before the store is consulted.
vi.mock('@/libs/config.js', () => ({
  config: { get: vi.fn() },
}));

// Drive the external-service seams (base URL, token) through the env vars the
// real `getBaseUrl`/`getApiToken` read, so the shared `authedRequest` helper
// in @/libs/api.js resolves them the same way production does. Overriding the
// exports wouldn't reach `authedRequest`, which calls those functions
// internally. `vi.stubEnv` scopes and auto-restores the values so nothing
// leaks into other test files sharing the worker. Everything else —
// formatErrorMessages, unwrapResourceAttributes — stays real so these tests
// exercise production response-parsing logic instead of a hand-copied
// stand-in that could silently drift from it (see tests/libs/records.test.ts).
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

const mockSource: Source = {
  uuid: 'abc-123',
  createdAt: '2024-01-01T00:00:00Z',
  type: 'webhook',
  name: 'Test Source',
  provider: null,
  endpointSlug: 'wh_abc12345',
  routeFolder: '99-incoming/',
  lastHitAt: null,
  recordCount: 0,
};

const mockMeta: ApiDeleteMeta = { deleted: 1 };

function mockFetch(responseBody: object, ok = true) {
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    json: () => Promise.resolve(responseBody),
  });
}

describe('fetchSources', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('calls fetch with the correct URL and auth header', async () => {
    mockFetch({ data: [{ attributes: mockSource }] });
    await fetchSources();
    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com/api/sources',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-token' },
      }),
    );
  });

  it('returns the list of source attributes on success', async () => {
    mockFetch({ data: [{ attributes: mockSource }] });
    expect(await fetchSources()).toEqual([mockSource]);
  });

  // Regression coverage for #29: see the equivalent note in the createSource
  // describe block below.
  it('extracts attributes from full JSON:API resource objects in a list response', async () => {
    mockFetch({
      data: [
        {
          type: 'sources',
          id: mockSource.uuid,
          attributes: mockSource,
          links: { self: `/api/sources/${mockSource.uuid}` },
        },
      ],
    });
    expect(await fetchSources()).toEqual([mockSource]);
  });

  // Regression coverage for #29: authedSourcesRequest previously only
  // checked `!response.ok`, so a 200 whose body still carried `errors`
  // (e.g. `data.errors`) was treated as success everywhere in this file —
  // the same class of error-swallowing bug the CLI's records path had
  // already been fixed for (see tests/libs/records.test.ts). It now
  // delegates to `assertApiSuccess`, which checks both.
  it('returns [] and surfaces error details when the response is ok but carries errors', async () => {
    mockFetch(
      { data: { errors: [{ title: 'Error', detail: 'Server error' }] } },
      true,
    );
    expect(await fetchSources()).toEqual([]);
    expect(logErrorMessage).toHaveBeenCalledWith(
      'fetchSources',
      'Error: Server error',
    );
  });

  it('returns [] and surfaces error details when the response is not ok', async () => {
    mockFetch({ data: { errors: [{ title: 'Error', detail: 'Server error' }] } }, false);
    expect(await fetchSources()).toEqual([]);
    expect(logErrorMessage).toHaveBeenCalledWith('fetchSources', 'Error: Server error');
  });

  it('returns [] on network failure', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
    expect(await fetchSources()).toEqual([]);
  });

  // Regression coverage: a resource with no `attributes` at all must be
  // skipped (not passed through as `undefined`) and the skip must be
  // reported so it's visible instead of silently shrinking the result.
  it('skips a resource with no attributes and reports the count', async () => {
    mockFetch({
      data: [{ attributes: mockSource }, { type: 'sources', id: 'x' }],
    });

    expect(await fetchSources()).toEqual([mockSource]);
    expect(logErrorMessage).toHaveBeenCalledWith(
      'fetchSources',
      'Skipped 1 source(s) with no attributes',
    );
  });

  // Regression coverage: `attributes: null` is off-contract but must be
  // caught by the same skip logic as a missing `attributes` key, not passed
  // through as a `null` element typed as a `Source`.
  it('skips a resource with attributes explicitly null', async () => {
    mockFetch({
      data: [{ attributes: mockSource }, { type: 'sources', attributes: null }],
    });

    expect(await fetchSources()).toEqual([mockSource]);
    expect(logErrorMessage).toHaveBeenCalledWith(
      'fetchSources',
      'Skipped 1 source(s) with no attributes',
    );
  });
});

describe('createSource', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('calls fetch with POST, correct headers, and JSON:API body', async () => {
    mockFetch({ data: { attributes: mockSource } });
    await createSource({
      type: 'webhook',
      name: 'Test Source',
      routeFolder: '99-incoming/',
    });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com/api/sources',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/vnd.api+json',
          Authorization: 'Bearer test-token',
        },
        body: JSON.stringify({
          data: {
            type: 'sources',
            attributes: {
              type: 'webhook',
              name: 'Test Source',
              routeFolder: '99-incoming/',
            },
          },
        }),
      }),
    );
  });

  it('returns the source attributes on success', async () => {
    mockFetch({ data: { attributes: mockSource } });
    expect(
      await createSource({
        type: 'webhook',
        name: 'Test Source',
        routeFolder: '99-incoming/',
      }),
    ).toEqual(mockSource);
  });

  // Regression coverage for #29: markpost's real resource objects carry
  // `type`/`id`/`links` alongside `attributes` (see `sourceSerializer` in
  // markpost's server/utils/response.ts), which the CLI's old `ApiData` type
  // couldn't even describe. Extraction must still work with the full shape.
  it('extracts attributes from a full JSON:API resource object (type/id/links included)', async () => {
    mockFetch({
      data: {
        type: 'sources',
        id: mockSource.uuid,
        attributes: mockSource,
        links: { self: `/api/sources/${mockSource.uuid}` },
      },
    });
    expect(
      await createSource({
        type: 'webhook',
        name: 'Test Source',
        routeFolder: '99-incoming/',
      }),
    ).toEqual(mockSource);
  });

  it('returns null and surfaces error details when the response contains errors', async () => {
    mockFetch(
      {
        data: {
          errors: [{ title: 'Invalid Attribute', detail: 'Type must be one of: webhook, email' }],
        },
      },
      false,
    );
    const result = await createSource({
      type: 'bogus',
      name: 'Test Source',
      routeFolder: '99-incoming/',
    });
    expect(result).toBeNull();
    expect(logErrorMessage).toHaveBeenCalledWith(
      'createSource["Test Source"]',
      'Invalid Attribute: Type must be one of: webhook, email',
    );
  });

  it('returns null on network failure', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
    expect(
      await createSource({
        type: 'webhook',
        name: 'Test Source',
        routeFolder: '99-incoming/',
      }),
    ).toBeNull();
  });
});

describe('updateSource', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('calls fetch with PATCH, correct headers, and JSON:API body', async () => {
    mockFetch({ data: { attributes: mockSource } });
    await updateSource('abc-123', { routeFolder: '00-fixed/' });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com/api/sources/abc-123',
      expect.objectContaining({
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/vnd.api+json',
          Authorization: 'Bearer test-token',
        },
        body: JSON.stringify({
          data: {
            type: 'sources',
            attributes: { routeFolder: '00-fixed/' },
          },
        }),
      }),
    );
  });

  it('encodes the uuid into the URL path', async () => {
    mockFetch({ data: { attributes: mockSource } });
    await updateSource('a/../b', { routeFolder: '00-fixed/' });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com/api/sources/a%2F..%2Fb',
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it('sends only the fields provided, including fieldMapping', async () => {
    mockFetch({ data: { attributes: mockSource } });
    await updateSource('abc-123', { fieldMapping: { title: 'subject' } });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com/api/sources/abc-123',
      expect.objectContaining({
        body: JSON.stringify({
          data: {
            type: 'sources',
            attributes: { fieldMapping: { title: 'subject' } },
          },
        }),
      }),
    );
  });

  it('returns the updated source attributes on success', async () => {
    mockFetch({ data: { attributes: mockSource } });
    expect(
      await updateSource('abc-123', { routeFolder: '00-fixed/' }),
    ).toEqual(mockSource);
  });

  it('returns null and surfaces error details when the uuid is not found', async () => {
    mockFetch(
      {
        data: {
          errors: [
            { title: 'Not Found', detail: 'No source was found for the given uuid.' },
          ],
        },
      },
      false,
    );
    const result = await updateSource('missing-uuid', {
      routeFolder: '00-fixed/',
    });
    expect(result).toBeNull();
    expect(logErrorMessage).toHaveBeenCalledWith(
      'updateSource["missing-uuid"]',
      'Not Found: No source was found for the given uuid.',
    );
  });

  it('returns null and surfaces error details when no fields are provided', async () => {
    mockFetch(
      {
        data: {
          errors: [
            {
              title: 'Invalid Attribute',
              detail: 'At least one of routeFolder or fieldMapping must be provided.',
            },
          ],
        },
      },
      false,
    );
    const result = await updateSource('abc-123', {});
    expect(result).toBeNull();
    expect(logErrorMessage).toHaveBeenCalledWith(
      'updateSource["abc-123"]',
      'Invalid Attribute: At least one of routeFolder or fieldMapping must be provided.',
    );
  });

  it('returns null on network failure', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
    expect(
      await updateSource('abc-123', { routeFolder: '00-fixed/' }),
    ).toBeNull();
  });
});

describe('deleteSource', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('calls fetch with DELETE and the uuid in the URL', async () => {
    mockFetch({ meta: mockMeta });
    await deleteSource('abc-123');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com/api/sources/abc-123',
      expect.objectContaining({
        method: 'DELETE',
        headers: { Authorization: 'Bearer test-token' },
      }),
    );
  });

  it('encodes the uuid into the URL path', async () => {
    mockFetch({ meta: mockMeta });
    await deleteSource('a/../b');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com/api/sources/a%2F..%2Fb',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('returns meta on success', async () => {
    mockFetch({ meta: mockMeta });
    expect(await deleteSource('abc-123')).toEqual(mockMeta);
  });

  it('returns null and surfaces error details when the response contains errors', async () => {
    mockFetch(
      { data: { errors: [{ title: 'Not Found', detail: 'No source was found for the given uuid.' }] } },
      false,
    );
    const result = await deleteSource('missing-uuid');
    expect(result).toBeNull();
    expect(logErrorMessage).toHaveBeenCalledWith(
      'deleteSource["missing-uuid"]',
      'Not Found: No source was found for the given uuid.',
    );
  });

  it('returns null on network failure', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
    expect(await deleteSource('abc-123')).toBeNull();
  });
});
