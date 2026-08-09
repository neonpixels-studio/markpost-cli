import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRecord,
  deleteRecords,
  fetchAllRecords,
  fetchPaginatedRecords,
  fetchRecord,
  markRecordSynced,
} from '@/libs/records.js';
import { ApiDeleteMeta } from '@/types/api.types.js';
import { Record } from '@/types/records.types.js';

// @/libs/api.js imports @/libs/config.js, which constructs a real
// `conf`-backed store (touching the developer's actual config directory) as
// soon as it's loaded. Mock it so loading api.js doesn't pull in that side
// effect — the stubbed API_TOKEN below resolves the token before the store is
// consulted.
vi.mock('@/libs/config.js', () => ({
  config: { get: vi.fn() },
}));

// Drive the external-service seams (base URL, token) through the env vars the
// real `getBaseUrl`/`getApiToken` read, so the shared `authedRequest` helper
// in @/libs/api.js resolves them the same way production does. Overriding the
// exports wouldn't reach `authedRequest`, which calls those functions
// internally. `vi.stubEnv` scopes and auto-restores the values so nothing
// leaks into other test files sharing the worker. Everything else —
// formatErrorMessages, assertApiSuccess — stays real so these tests exercise
// production error-parsing logic instead of a hand-copied stand-in that could
// silently drift from it.
beforeEach(() => {
  vi.stubEnv('BASE_URL', 'https://example.com');
  vi.stubEnv('API_TOKEN', 'test-token');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const mockRecord: Record = {
  uuid: 'abc-123',
  title: 'Test Title',
  content: 'Test Content',
  createdAt: '2024-01-01T00:00:00Z',
};

const mockMeta: ApiDeleteMeta = { deleted: 1 };

const mockPaginatedMeta = { total: 1, size: 100, hasMore: false };

function mockFetch(responseBody: object, ok = true) {
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    json: () => Promise.resolve(responseBody),
  });
}

const mockRecord2: Record = {
  uuid: 'def-456',
  title: 'Test Title 2',
  content: 'Test Content 2',
  createdAt: '2024-01-02T00:00:00Z',
};

describe('fetchAllRecords', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  // A failed INITIAL fetch must surface as `{ ok: false }` — never an empty
  // array, which the caller can't tell apart from a legitimately empty account
  // and would report as "No new records" while exiting 0 (issue #63).
  it('returns { ok: false } when the initial fetch fails', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
    expect(await fetchAllRecords()).toEqual({ ok: false });
  });

  // markpost answers an invalid filter[source] with a 400; that must surface as
  // `{ ok: false }`, never an empty array the caller renders as "No records
  // found." — the same silent-failure concern as a network error above.
  it('returns { ok: false } when the server rejects the request (e.g. an invalid filter)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: () =>
        Promise.resolve({
          errors: [
            {
              status: '400',
              title: 'Invalid filter[source]',
              detail: 'filter[source] must be one of: webhook, email',
            },
          ],
        }),
    });

    expect(await fetchAllRecords({ source: 'bogus' })).toEqual({ ok: false });
  });

  // A legitimately empty account is a success, distinct from a failed fetch.
  it('returns { ok: true, records: [] } when the account has no records', async () => {
    mockFetch({
      data: [],
      meta: { total: 0, size: 100, hasMore: false },
      links: { next: null, prev: null },
    });
    expect(await fetchAllRecords()).toEqual({
      ok: true,
      records: [],
      partial: false,
    });
  });

  it('returns records directly when there is only one page', async () => {
    mockFetch({
      data: [{ attributes: mockRecord }],
      meta: { total: 1, size: 100, hasMore: false },
      links: { next: null, prev: null },
    });
    expect(await fetchAllRecords()).toEqual({
      ok: true,
      records: [mockRecord],
      partial: false,
    });
    // A single page must not trigger a second fetch.
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  // The server can signal more pages via `meta.hasMore` even when `links.next`
  // is null (a malformed `links` is defaulted to `next: null` upstream). That
  // is still a truncation, so the read must be flagged `partial: true` rather
  // than reported complete.
  it('flags partial when meta.hasMore is true but links.next is null', async () => {
    mockFetch({
      data: [{ attributes: mockRecord }],
      meta: { total: 2, size: 1, hasMore: true },
      links: { next: null, prev: null },
    });
    expect(await fetchAllRecords()).toEqual({
      ok: true,
      records: [mockRecord],
      partial: true,
    });
    // No cursor to follow, so it must not fire a second fetch.
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('follows links.next until hasMore is false, combining all pages', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [{ attributes: mockRecord }],
            meta: { total: 2, size: 1, hasMore: true },
            links: {
              next: '/api/records?page[after]=abc-123&page[size]=1',
              prev: null,
            },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [{ attributes: mockRecord2 }],
            meta: { total: 2, size: 1, hasMore: false },
            links: { next: null, prev: null },
          }),
      });

    expect(await fetchAllRecords()).toEqual({
      ok: true,
      records: [mockRecord, mockRecord2],
      partial: false,
    });
    // This is the regression check for the bug in #15: the second page must
    // actually be requested using the cursor from `links.next`, not skipped.
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      'https://example.com/api/records?page[size]=100&page[after]=abc-123',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-token' },
      }),
    );
  });

  it('threads the filters into every page request', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [{ attributes: mockRecord }],
            meta: { total: 2, size: 1, hasMore: true },
            links: {
              next: '/api/records?page[after]=abc-123&page[size]=1',
              prev: null,
            },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [{ attributes: mockRecord2 }],
            meta: { total: 2, size: 1, hasMore: false },
            links: { next: null, prev: null },
          }),
      });

    await fetchAllRecords({ source: 'webhook', status: 'pending' });

    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      'https://example.com/api/records?page[size]=100&filter[source]=webhook&filter[status]=pending',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-token' },
      }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      'https://example.com/api/records?page[size]=100&page[after]=abc-123&filter[source]=webhook&filter[status]=pending',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-token' },
      }),
    );
  });

  it('keeps following the cursor across more than two pages', async () => {
    const mockRecord3: Record = {
      uuid: 'ghi-789',
      title: 'Test Title 3',
      content: 'Test Content 3',
      createdAt: '2024-01-03T00:00:00Z',
    };

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [{ attributes: mockRecord }],
            meta: { total: 3, size: 1, hasMore: true },
            links: {
              next: '/api/records?page[after]=abc-123&page[size]=1',
              prev: null,
            },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [{ attributes: mockRecord2 }],
            meta: { total: 3, size: 1, hasMore: true },
            links: {
              next: '/api/records?page[after]=def-456&page[size]=1',
              prev: null,
            },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [{ attributes: mockRecord3 }],
            meta: { total: 3, size: 1, hasMore: false },
            links: { next: null, prev: null },
          }),
      });

    expect(await fetchAllRecords()).toEqual({
      ok: true,
      records: [mockRecord, mockRecord2, mockRecord3],
      partial: false,
    });
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('returns partial results if a subsequent page fetch fails', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [{ attributes: mockRecord }],
            meta: { total: 2, size: 1, hasMore: true },
            links: {
              next: '/api/records?page[after]=abc-123&page[size]=1',
              prev: null,
            },
          }),
      })
      .mockRejectedValueOnce(new Error('Network error'));
    // A later page failing keeps the pages already collected but flags the
    // read `partial: true`, so the caller can surface the truncation rather
    // than presenting one page as the whole set.
    expect(await fetchAllRecords()).toEqual({
      ok: true,
      records: [mockRecord],
      partial: true,
    });
  });

  it('stops instead of looping forever if the server repeats the same cursor', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [{ attributes: mockRecord }],
          meta: { total: 2, size: 1, hasMore: true },
          links: {
            next: '/api/records?page[after]=abc-123&page[size]=1',
            prev: null,
          },
        }),
    });

    // A repeated cursor means the server still claims more pages while looping
    // us over ones already fetched, so the read is incomplete: `partial: true`.
    expect(await fetchAllRecords()).toEqual({
      ok: true,
      records: [mockRecord, mockRecord],
      partial: true,
    });
    // The second response repeats the same `page[after]=abc-123` cursor as
    // the first, so the loop must break rather than fetch forever.
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('stops instead of looping forever on a longer cursor cycle (A -> B -> A)', async () => {
    const mockRecord3: Record = {
      uuid: 'ghi-789',
      title: 'Test Title 3',
      content: 'Test Content 3',
      createdAt: '2024-01-03T00:00:00Z',
    };

    global.fetch = vi
      .fn()
      // Initial page (no incoming cursor) points to cursor-a.
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [{ attributes: mockRecord }],
            meta: { total: 3, size: 1, hasMore: true },
            links: {
              next: '/api/records?page[after]=cursor-a&page[size]=1',
              prev: null,
            },
          }),
      })
      // Fetched with cursor-a, points to cursor-b.
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [{ attributes: mockRecord2 }],
            meta: { total: 3, size: 1, hasMore: true },
            links: {
              next: '/api/records?page[after]=cursor-b&page[size]=1',
              prev: null,
            },
          }),
      })
      // Fetched with cursor-b, cycles back to the already-seen cursor-a.
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [{ attributes: mockRecord3 }],
            meta: { total: 3, size: 1, hasMore: true },
            links: {
              next: '/api/records?page[after]=cursor-a&page[size]=1',
              prev: null,
            },
          }),
      });

    // The cycle back to the already-seen cursor-a means the server still claims
    // more while looping us, so the read is incomplete: `partial: true`.
    expect(await fetchAllRecords()).toEqual({
      ok: true,
      records: [mockRecord, mockRecord2, mockRecord3],
      partial: true,
    });
    // Without cycle detection this would alternate between cursor-a and
    // cursor-b forever; cursor-a must not be re-fetched once seen.
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('follows a cursor containing a literal "+" without corrupting it', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [{ attributes: mockRecord }],
            meta: { total: 2, size: 1, hasMore: true },
            links: {
              next: '/api/records?page[after]=abc%2Bxyz&page[size]=1',
              prev: null,
            },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [{ attributes: mockRecord2 }],
            meta: { total: 2, size: 1, hasMore: false },
            links: { next: null, prev: null },
          }),
      });

    expect(await fetchAllRecords()).toEqual({
      ok: true,
      records: [mockRecord, mockRecord2],
      partial: false,
    });
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      'https://example.com/api/records?page[size]=100&page[after]=abc%2Bxyz',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-token' },
      }),
    );
  });

  it('extracts the cursor when links.next percent-encodes the key, matching markpost\'s own link builder', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [{ attributes: mockRecord }],
            meta: { total: 2, size: 1, hasMore: true },
            // markpost builds links with `new URLSearchParams(...).toString()`,
            // which percent-encodes `[` and `]` to `%5B`/`%5D`.
            links: {
              next: '/api/records?page%5Bafter%5D=abc-123&page%5Bsize%5D=1',
              prev: null,
            },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [{ attributes: mockRecord2 }],
            meta: { total: 2, size: 1, hasMore: false },
            links: { next: null, prev: null },
          }),
      });

    expect(await fetchAllRecords()).toEqual({
      ok: true,
      records: [mockRecord, mockRecord2],
      partial: false,
    });
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      'https://example.com/api/records?page[size]=100&page[after]=abc-123',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-token' },
      }),
    );
  });

  it('stops pagination instead of throwing when links.next has a malformed cursor', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [{ attributes: mockRecord }],
          meta: { total: 2, size: 1, hasMore: true },
          // A lone `%` is invalid percent-encoding and throws from
          // `decodeURIComponent`; this must not crash `fetchAllRecords` and
          // discard the page already fetched.
          links: {
            next: '/api/records?page[after]=50%off&page[size]=1',
            prev: null,
          },
        }),
    });

    // `links.next` was present but its cursor is undecodable, so the server had
    // a further page we can't follow: the read is incomplete (`partial: true`),
    // not a clean end of pagination.
    await expect(fetchAllRecords()).resolves.toEqual({
      ok: true,
      records: [mockRecord],
      partial: true,
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not truncate a cursor value containing an unencoded "="', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [{ attributes: mockRecord }],
            meta: { total: 2, size: 1, hasMore: true },
            links: {
              next: '/api/records?page[after]=YWJj==&page[size]=1',
              prev: null,
            },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [{ attributes: mockRecord2 }],
            meta: { total: 2, size: 1, hasMore: false },
            links: { next: null, prev: null },
          }),
      });

    expect(await fetchAllRecords()).toEqual({
      ok: true,
      records: [mockRecord, mockRecord2],
      partial: false,
    });
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      'https://example.com/api/records?page[size]=100&page[after]=YWJj%3D%3D',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-token' },
      }),
    );
  });
});

describe('fetchPaginatedRecords', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  // An unfiltered request sends no filter[status], so `records list` can page
  // any status. Scoping the sync to pending (the #50 duplicate guard) is the
  // caller's job now — see index.test.ts, which asserts the sync passes
  // { status: 'pending' }.
  it('sends no filter[status] when no filters are given', async () => {
    mockFetch({ data: [mockRecord], meta: mockPaginatedMeta });
    await fetchPaginatedRecords();
    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com/api/records?page[size]=100',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-token' },
      }),
    );
  });

  it('calls fetch with the cursor and page[size] and auth header', async () => {
    mockFetch({ data: [mockRecord], meta: mockPaginatedMeta });
    await fetchPaginatedRecords('abc-123', 50);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com/api/records?page[size]=50&page[after]=abc-123',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-token' },
      }),
    );
  });

  it('appends filter[source], filter[status], and filter[q] when filters are given', async () => {
    mockFetch({ data: [mockRecord], meta: mockPaginatedMeta });
    await fetchPaginatedRecords(undefined, 100, {
      source: 'webhook',
      status: 'pending',
      search: 'notes',
    });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com/api/records?page[size]=100&filter[source]=webhook&filter[status]=pending&filter[q]=notes',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-token' },
      }),
    );
  });

  it('only appends the filters that are provided', async () => {
    mockFetch({ data: [mockRecord], meta: mockPaginatedMeta });
    await fetchPaginatedRecords(undefined, 100, { status: 'error' });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com/api/records?page[size]=100&filter[status]=error',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-token' },
      }),
    );
  });

  it('percent-encodes a search value containing spaces and special characters', async () => {
    mockFetch({ data: [mockRecord], meta: mockPaginatedMeta });
    await fetchPaginatedRecords(undefined, 100, { search: 'foo bar & baz' });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com/api/records?page[size]=100&filter[q]=foo%20bar%20%26%20baz',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-token' },
      }),
    );
  });

  it('keeps the cursor and filters together on a paged request', async () => {
    mockFetch({ data: [mockRecord], meta: mockPaginatedMeta });
    await fetchPaginatedRecords('abc-123', 100, { source: 'email' });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com/api/records?page[size]=100&page[after]=abc-123&filter[source]=email',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-token' },
      }),
    );
  });

  it('returns records, meta, and links on success', async () => {
    mockFetch({
      data: [{ attributes: mockRecord }],
      meta: mockPaginatedMeta,
      links: { next: null, prev: null },
    });
    expect(await fetchPaginatedRecords()).toEqual({
      records: [mockRecord],
      meta: mockPaginatedMeta,
      links: { next: null, prev: null },
    });
  });

  it('defaults links to { next: null, prev: null } when omitted', async () => {
    mockFetch({ data: [{ attributes: mockRecord }], meta: mockPaginatedMeta });
    expect(await fetchPaginatedRecords()).toEqual({
      records: [mockRecord],
      meta: mockPaginatedMeta,
      links: { next: null, prev: null },
    });
  });

  it('defaults meta to a stop-pagination-safe value when omitted', async () => {
    mockFetch({ data: [{ attributes: mockRecord }] });
    expect(await fetchPaginatedRecords()).toEqual({
      records: [mockRecord],
      meta: { total: 1, size: 100, hasMore: false },
      links: { next: null, prev: null },
    });
  });

  it('returns null when the response contains errors', async () => {
    mockFetch(
      { data: { errors: [{ title: 'Error', detail: 'Server error' }] } },
      false,
    );
    expect(await fetchPaginatedRecords()).toBeNull();
  });

  it('surfaces the API error detail instead of "Unknown error occurred"', async () => {
    mockFetch(
      {
        data: {
          errors: [{ title: 'Unauthorized', detail: 'Invalid API token' }],
        },
      },
      false,
    );

    expect(await fetchPaginatedRecords()).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unauthorized: Invalid API token'),
    );
    expect(consoleErrorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Unknown error occurred'),
    );
  });

  it('returns null on network failure', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
    expect(await fetchPaginatedRecords()).toBeNull();
  });

  // Regression coverage for #29: see the equivalent note in the createRecord
  // describe block above.
  it('extracts attributes from full JSON:API resource objects in a list response', async () => {
    mockFetch({
      data: [
        {
          type: 'records',
          id: mockRecord.uuid,
          attributes: mockRecord,
          links: { self: `/api/records/${mockRecord.uuid}` },
        },
      ],
      meta: mockPaginatedMeta,
      links: { next: null, prev: null },
    });
    expect(await fetchPaginatedRecords()).toEqual({
      records: [mockRecord],
      meta: mockPaginatedMeta,
      links: { next: null, prev: null },
    });
  });

  // Regression coverage: a resource with no `attributes` at all must be
  // skipped (not passed through as `undefined`) and the skip must be
  // reported so it's visible instead of silently shrinking the result.
  it('skips a resource with no attributes and reports the count', async () => {
    mockFetch({
      data: [{ attributes: mockRecord }, { type: 'records', id: 'x' }],
      meta: { total: 2, size: 100, hasMore: false },
      links: { next: null, prev: null },
    });

    expect(await fetchPaginatedRecords()).toEqual({
      records: [mockRecord],
      meta: { total: 2, size: 100, hasMore: false },
      links: { next: null, prev: null },
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Skipped 1 record(s) with no attributes'),
    );
  });

  // Regression coverage: `attributes: null` is off-contract but must be
  // caught by the same skip logic as a missing `attributes` key, not passed
  // through as a `null` element typed as a `Record`.
  it('skips a resource with attributes explicitly null', async () => {
    mockFetch({
      data: [{ attributes: mockRecord }, { type: 'records', attributes: null }],
      meta: { total: 2, size: 100, hasMore: false },
      links: { next: null, prev: null },
    });

    expect(await fetchPaginatedRecords()).toEqual({
      records: [mockRecord],
      meta: { total: 2, size: 100, hasMore: false },
      links: { next: null, prev: null },
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Skipped 1 record(s) with no attributes'),
    );
  });
});

describe('createRecord', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('calls fetch with POST, correct headers, and JSON:API body', async () => {
    mockFetch({ data: { attributes: mockRecord } });
    await createRecord('Test Title', 'Test Content');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com/api/records',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/vnd.api+json',
          Authorization: 'Bearer test-token',
        },
        body: JSON.stringify({
          data: {
            type: 'records',
            attributes: { title: 'Test Title', content: 'Test Content' },
          },
        }),
      }),
    );
  });

  it('returns the record attributes on success', async () => {
    mockFetch({ data: { attributes: mockRecord } });
    expect(await createRecord('Test Title', 'Test Content')).toEqual(
      mockRecord,
    );
  });

  it('returns null when the response contains errors', async () => {
    mockFetch(
      { data: { errors: [{ title: 'Error', detail: 'Bad request' }] } },
      false,
    );
    expect(await createRecord('Test Title', 'Test Content')).toBeNull();
  });

  it('returns null on network failure', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
    expect(await createRecord('Test Title', 'Test Content')).toBeNull();
  });

  // A per-file 4xx (the payload's fault) must stay a null return so a bulk
  // push skips just this file and keeps going.
  it('returns null for a non-systemic 4xx failure', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: () =>
        Promise.resolve({
          data: { errors: [{ title: 'Unprocessable', detail: 'Bad' }] },
        }),
    });
    expect(await createRecord('Test Title', 'Test Content')).toBeNull();
  });

  // Auth/5xx doom every other file in a batch, so createRecord surfaces them
  // (as a systemic ApiRequestError) instead of swallowing them as null — that
  // distinction is what lets push fail-fast.
  it('re-throws a systemic auth (401) failure instead of returning null', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ data: { errors: [] } }),
    });

    await expect(
      createRecord('Test Title', 'Test Content'),
    ).rejects.toMatchObject({ statusCode: 401, isSystemic: true });
  });

  // End-to-end message check: a real bare-401 response (no data.errors, the
  // shape markpost's requireUser actually sends) must surface an actionable
  // message, not "Unknown error occurred", once composed for display.
  it('surfaces an actionable message for a real errorless 401 response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({}),
    });

    await expect(
      createRecord('Test Title', 'Test Content'),
    ).rejects.toMatchObject({
      statusCode: 401,
      message:
        'Invalid or missing API token — run `markpost config` to set a valid one',
    });
  });

  it('re-throws a systemic server (5xx) failure instead of returning null', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({ data: { errors: [] } }),
    });

    await expect(
      createRecord('Test Title', 'Test Content'),
    ).rejects.toMatchObject({ statusCode: 503, isSystemic: true });
  });

  // Regression coverage for #29: markpost's real resource objects carry
  // `type`/`id`/`links` alongside `attributes` (see `recordSerializer` in
  // markpost's server/utils/response.ts), which the CLI's old `ApiData` type
  // couldn't even describe. Extraction must still work with the full shape,
  // not just the attributes-only shape the old type modeled.
  it('extracts attributes from a full JSON:API resource object (type/id/links included)', async () => {
    mockFetch({
      data: {
        type: 'records',
        id: mockRecord.uuid,
        attributes: mockRecord,
        links: { self: `/api/records/${mockRecord.uuid}` },
      },
    });
    expect(await createRecord('Test Title', 'Test Content')).toEqual(
      mockRecord,
    );
  });
});

describe('fetchRecord', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('calls fetch with the correct UUID in the URL', async () => {
    mockFetch({ data: { attributes: mockRecord } });
    await fetchRecord('abc-123');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com/api/records/abc-123',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-token' },
      }),
    );
  });

  it('returns the record attributes on success', async () => {
    mockFetch({ data: { attributes: mockRecord } });
    expect(await fetchRecord('abc-123')).toEqual(mockRecord);
  });

  it('returns null when the response contains errors', async () => {
    mockFetch(
      { data: { errors: [{ title: 'Not Found', detail: 'Record missing' }] } },
      false,
    );
    expect(await fetchRecord('abc-123')).toBeNull();
  });

  it('returns null on network failure', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
    expect(await fetchRecord('abc-123')).toBeNull();
  });

  // Regression coverage for #29: see the equivalent note in the createRecord
  // describe block above.
  it('extracts attributes from a full JSON:API resource object (type/id/links included)', async () => {
    mockFetch({
      data: {
        type: 'records',
        id: mockRecord.uuid,
        attributes: mockRecord,
        links: { self: `/api/records/${mockRecord.uuid}` },
      },
    });
    expect(await fetchRecord('abc-123')).toEqual(mockRecord);
  });
});

describe('deleteRecords', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('calls fetch with DELETE, correct headers, and JSON:API body', async () => {
    mockFetch({ meta: mockMeta });
    await deleteRecords(['abc-123', 'def-456']);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com/api/records',
      expect.objectContaining({
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/vnd.api+json',
          Authorization: 'Bearer test-token',
        },
        body: JSON.stringify({
          data: {
            type: 'records',
            attributes: { uuids: ['abc-123', 'def-456'] },
          },
        }),
      }),
    );
  });

  it('returns meta on success', async () => {
    mockFetch({ meta: mockMeta });
    expect(await deleteRecords(['abc-123'])).toEqual(mockMeta);
  });

  it('returns null when the response contains errors', async () => {
    mockFetch(
      { data: { errors: [{ title: 'Error', detail: 'Bad request' }] } },
      false,
    );
    expect(await deleteRecords(['abc-123'])).toBeNull();
  });

  it('returns null on network failure', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
    expect(await deleteRecords(['abc-123'])).toBeNull();
  });
});

describe('markRecordSynced', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('PATCHes the record uuid with status=synced, syncedAt, and filePath', async () => {
    mockFetch({ data: { attributes: mockRecord } });
    await markRecordSynced(
      'abc-123',
      '/vault/test-title.md',
      '2024-01-01T00:00:00.000Z',
    );
    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com/api/records/abc-123',
      expect.objectContaining({
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/vnd.api+json',
          Authorization: 'Bearer test-token',
        },
        body: JSON.stringify({
          data: {
            type: 'records',
            attributes: {
              status: 'synced',
              syncedAt: '2024-01-01T00:00:00.000Z',
              filePath: '/vault/test-title.md',
            },
          },
        }),
      }),
    );
  });

  it('defaults syncedAt to the current time when not supplied', async () => {
    mockFetch({ data: { attributes: mockRecord } });
    await markRecordSynced('abc-123', '/vault/test-title.md');
    const requestInit = vi.mocked(global.fetch).mock.calls[0]?.[1];
    const sentBody = JSON.parse(String(requestInit?.body));
    expect(sentBody.data.attributes.syncedAt).toEqual(expect.any(String));
    expect(
      Number.isNaN(Date.parse(sentBody.data.attributes.syncedAt)),
    ).toBe(false);
  });

  it('returns true on success', async () => {
    mockFetch({ data: { attributes: mockRecord } });
    expect(await markRecordSynced('abc-123', '/vault/test-title.md')).toBe(
      true,
    );
  });

  // A 2xx that carries no resource body must count as success, not a spurious
  // failure that warns the user of duplicates that never appear.
  it('returns true for a 2xx response with a null data body', async () => {
    mockFetch({ data: null });
    expect(await markRecordSynced('abc-123', '/vault/test-title.md')).toBe(
      true,
    );
  });

  // A 200 carrying an unparseable body (e.g. an HTML page from a proxy) must
  // fail rather than be reported as a silent success that leaves the record
  // pending and re-duplicated next run.
  it('returns false for a 2xx response whose body is not valid JSON', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.reject(new Error('Unexpected token < in JSON')),
    });
    expect(await markRecordSynced('abc-123', '/vault/test-title.md')).toBe(
      false,
    );
  });

  it('returns false when the response contains errors', async () => {
    mockFetch(
      { data: { errors: [{ title: 'Not Found', detail: 'Record missing' }] } },
      false,
    );
    expect(await markRecordSynced('abc-123', '/vault/test-title.md')).toBe(
      false,
    );
  });

  it('returns false on network failure', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
    expect(await markRecordSynced('abc-123', '/vault/test-title.md')).toBe(
      false,
    );
  });
});
