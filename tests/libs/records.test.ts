import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRecord,
  deleteRecords,
  fetchAllRecords,
  fetchPaginatedRecords,
  fetchRecord,
  markRecordsSynced,
  MARK_FAILED,
  MARK_SYNCED,
  MARK_TIMED_OUT,
  MAX_MARK_SYNCED_BATCH_SIZE,
} from '@/libs/records.js';
import { ApiTimeoutError } from '@/libs/api.js';
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

function mockFetchTimeout() {
  global.fetch = vi
    .fn()
    .mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
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

  // A systemic auth (401) failure on the initial page must PROPAGATE (like a
  // timeout) rather than collapse to `{ ok: false }` — so the sync surfaces the
  // real, classified cause (expired token) instead of a generic failed-fetch
  // message (issue #89). Distinct from a 400 filter rejection above, which
  // stays `{ ok: false }`.
  it('propagates a systemic auth (401) failure instead of returning { ok: false }', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ data: { errors: [] } }),
    });

    await expect(fetchAllRecords()).rejects.toMatchObject({
      statusCode: 401,
      isSystemic: true,
    });
  });

  // A systemic failure partway through pagination must fail loud — discard the
  // pages already collected and propagate — never return page 1 as if complete
  // (mirrors the mid-pagination timeout behavior).
  it('propagates a systemic failure that strikes on a later page', async () => {
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
        ok: false,
        status: 500,
        json: () => Promise.resolve({ data: { errors: [] } }),
      });

    await expect(fetchAllRecords()).rejects.toMatchObject({
      statusCode: 500,
      isSystemic: true,
    });
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

  // Auth/5xx doom every page of the read, not just this one, so
  // fetchPaginatedRecords re-throws them (as a systemic ApiRequestError, like
  // createRecord) instead of collapsing to null — that distinction is what
  // lets the sync fail-fast on an expired token rather than report "no
  // records" and exit 0 (issue #89).
  it('re-throws a systemic auth (401) failure instead of returning null', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ data: { errors: [] } }),
    });

    await expect(fetchPaginatedRecords()).rejects.toMatchObject({
      statusCode: 401,
      isSystemic: true,
    });
  });

  it('re-throws a systemic server (5xx) failure instead of returning null', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({ data: { errors: [] } }),
    });

    await expect(fetchPaginatedRecords()).rejects.toMatchObject({
      statusCode: 503,
      isSystemic: true,
    });
  });

  // A per-request 4xx (a bad filter value the payload caused) is NOT systemic:
  // it stays a null return so the caller reports it as a failed fetch without
  // treating it as a batch-wide abort.
  it('returns null for a non-systemic 4xx failure', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () =>
        Promise.resolve({
          errors: [{ title: 'Invalid filter[source]', detail: 'bad' }],
        }),
    });

    expect(await fetchPaginatedRecords()).toBeNull();
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

  // A systemic auth (401) failure is not "record not found" — fetchRecord
  // re-throws it (like createRecord) so `get` reports the real cause with a
  // non-zero exit, distinct from the null a genuine 404 returns (issue #89).
  it('re-throws a systemic auth (401) failure instead of returning null', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ data: { errors: [] } }),
    });

    await expect(fetchRecord('abc-123')).rejects.toMatchObject({
      statusCode: 401,
      isSystemic: true,
    });
  });

  // A genuine 404 (markpost's notFoundError) is NOT systemic: it stays a null
  // return so `get` reports "Failed to fetch record", not an auth error.
  it('returns null for a non-systemic 404 (record not found)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: () =>
        Promise.resolve({
          errors: [{ title: 'Not Found', detail: 'No record was found' }],
        }),
    });

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

  // A systemic auth (401) failure will recur for the whole batch, so
  // deleteRecords re-throws it (like createRecord) rather than swallowing to
  // null — the sync then surfaces the real cause and leaves the records on the
  // server (issue #89).
  it('re-throws a systemic auth (401) failure instead of returning null', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ data: { errors: [] } }),
    });

    await expect(deleteRecords(['abc-123'])).rejects.toMatchObject({
      statusCode: 401,
      isSystemic: true,
    });
  });

  it('re-throws a systemic server (5xx) failure instead of returning null', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ data: { errors: [] } }),
    });

    await expect(deleteRecords(['abc-123'])).rejects.toMatchObject({
      statusCode: 500,
      isSystemic: true,
    });
  });
});

// A stalled request must fail loud, not degrade to an empty/`null` result:
// otherwise the sync reports "no records" (exit 0) on a hung server, the
// exact failure this timeout guards against. Each public function re-throws
// the timeout instead of swallowing it.
describe('records API timeout propagation', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('fetchPaginatedRecords rejects with ApiTimeoutError instead of returning null', async () => {
    mockFetchTimeout();
    await expect(fetchPaginatedRecords()).rejects.toBeInstanceOf(
      ApiTimeoutError,
    );
  });

  it('fetchAllRecords propagates the timeout rather than returning []', async () => {
    mockFetchTimeout();
    await expect(fetchAllRecords()).rejects.toBeInstanceOf(ApiTimeoutError);
  });

  // A timeout partway through pagination must discard the pages already
  // collected and fail loud, NOT return page 1 as if complete — otherwise
  // the sync would write and (with autoDelete) delete a partial set.
  it('fetchAllRecords rejects on a mid-pagination timeout instead of returning page 1', async () => {
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
      .mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));

    await expect(fetchAllRecords()).rejects.toBeInstanceOf(ApiTimeoutError);
  });

  it('createRecord rejects with ApiTimeoutError instead of returning null', async () => {
    mockFetchTimeout();
    await expect(createRecord('t', 'c')).rejects.toBeInstanceOf(
      ApiTimeoutError,
    );
  });

  it('fetchRecord rejects with ApiTimeoutError instead of returning null', async () => {
    mockFetchTimeout();
    await expect(fetchRecord('abc-123')).rejects.toBeInstanceOf(
      ApiTimeoutError,
    );
  });

  it('deleteRecords rejects with ApiTimeoutError instead of returning null', async () => {
    mockFetchTimeout();
    await expect(deleteRecords(['abc-123'])).rejects.toBeInstanceOf(
      ApiTimeoutError,
    );
  });
});

describe('markRecordsSynced', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  // Build `count` items with predictable uuids/paths so a test can assert
  // per-record outcomes and chunk boundaries without hand-listing records.
  const items = (count: number) =>
    Array.from({ length: count }, (_item, index) => ({
      uuid: `uuid-${index}`,
      filePath: `/vault/note-${index}.md`,
    }));

  // Echoes back every requested uuid as an updated record, so each chunk resolves
  // MARK_SYNCED for all its items. Mirrors markpost returning the records it
  // actually updated; reading the response `data` is what gives per-record
  // outcomes rather than a bare 2xx.
  const mockBulkPatchEcho = () => {
    global.fetch = vi.fn().mockImplementation((_url, init) => {
      const body = JSON.parse(String(init.body));
      const records = body.data.attributes.records as { uuid: string }[];

      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            data: records.map((record) => ({
              type: 'records',
              attributes: { uuid: record.uuid },
            })),
            meta: { updated: records.length },
          }),
      });
    });
  };

  // The number of records in each chunk request, in call order.
  const chunkSizes = () =>
    vi.mocked(global.fetch).mock.calls.map((call) => {
      const body = JSON.parse(String(call[1]?.body));
      return body.data.attributes.records.length as number;
    });

  it('sends one bulk PATCH per record chunk with the synced attributes', async () => {
    mockBulkPatchEcho();
    await markRecordsSynced(
      [{ uuid: 'abc-123', filePath: '/vault/test-title.md' }],
      '2024-01-01T00:00:00.000Z',
    );
    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com/api/records',
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
              records: [
                {
                  uuid: 'abc-123',
                  status: 'synced',
                  syncedAt: '2024-01-01T00:00:00.000Z',
                  filePath: '/vault/test-title.md',
                },
              ],
            },
          },
        }),
      }),
    );
  });

  it('defaults syncedAt to the current time when not supplied', async () => {
    mockBulkPatchEcho();
    await markRecordsSynced([{ uuid: 'abc-123', filePath: '/vault/note.md' }]);
    const requestInit = vi.mocked(global.fetch).mock.calls[0]?.[1];
    const sentBody = JSON.parse(String(requestInit?.body));
    const sentRecord = sentBody.data.attributes.records[0];
    expect(sentRecord.syncedAt).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(sentRecord.syncedAt))).toBe(false);
  });

  it('sends nothing and reports no outcomes for an empty input', async () => {
    global.fetch = vi.fn();
    const result = await markRecordsSynced([]);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result).toEqual({ outcomes: [], timedOut: false });
  });

  it('marks every record synced in a single request at exactly the batch size', async () => {
    mockBulkPatchEcho();
    const result = await markRecordsSynced(items(MAX_MARK_SYNCED_BATCH_SIZE));
    // A full-but-not-over chunk is one request — the off-by-one boundary.
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(chunkSizes()).toEqual([MAX_MARK_SYNCED_BATCH_SIZE]);
    expect(result.outcomes).toHaveLength(MAX_MARK_SYNCED_BATCH_SIZE);
    expect(result.outcomes.every((outcome) => outcome === MARK_SYNCED)).toBe(
      true,
    );
    expect(result.timedOut).toBe(false);
  });

  it('splits one-over-the-batch-size into two requests (ceil(N/100))', async () => {
    mockBulkPatchEcho();
    const result = await markRecordsSynced(
      items(MAX_MARK_SYNCED_BATCH_SIZE + 1),
    );
    // 101 records must not go in one over-cap request markpost would 422.
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(chunkSizes()).toEqual([MAX_MARK_SYNCED_BATCH_SIZE, 1]);
    expect(result.outcomes).toHaveLength(MAX_MARK_SYNCED_BATCH_SIZE + 1);
    expect(result.outcomes.every((outcome) => outcome === MARK_SYNCED)).toBe(
      true,
    );
  });

  it('chunks 250 records into 100/100/50 requests, each within the cap', async () => {
    mockBulkPatchEcho();
    const result = await markRecordsSynced(items(250));
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(chunkSizes()).toEqual([100, 100, 50]);
    // No chunk may ever exceed the server cap.
    expect(chunkSizes().every((size) => size <= MAX_MARK_SYNCED_BATCH_SIZE)).toBe(
      true,
    );
    expect(result.outcomes).toHaveLength(250);
    expect(result.timedOut).toBe(false);
  });

  it('reports MARK_FAILED for a uuid the server did not return (partial success)', async () => {
    // The server updates every record except uuid-2 (e.g. it no longer exists);
    // an absent uuid in the response means that record stays pending.
    global.fetch = vi.fn().mockImplementation((_url, init) => {
      const body = JSON.parse(String(init.body));
      const records = body.data.attributes.records as { uuid: string }[];
      const updated = records.filter((record) => record.uuid !== 'uuid-2');

      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            data: updated.map((record) => ({
              type: 'records',
              attributes: { uuid: record.uuid },
            })),
            meta: { updated: updated.length },
          }),
      });
    });

    const result = await markRecordsSynced(items(5));
    expect(result.outcomes).toEqual([
      MARK_SYNCED,
      MARK_SYNCED,
      MARK_FAILED,
      MARK_SYNCED,
      MARK_SYNCED,
    ]);
    expect(result.timedOut).toBe(false);
  });

  it('aborts remaining chunks on a timeout and marks the timed-out chunk pending', async () => {
    // First chunk succeeds; the second times out. The third chunk must never be
    // sent — a hung server would otherwise burn the full timeout on every chunk.
    let call = 0;
    global.fetch = vi.fn().mockImplementation((_url, init) => {
      call += 1;
      if (call === 2) {
        return Promise.reject(new DOMException('timed out', 'TimeoutError'));
      }

      const body = JSON.parse(String(init.body));
      const records = body.data.attributes.records as { uuid: string }[];
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            data: records.map((record) => ({
              type: 'records',
              attributes: { uuid: record.uuid },
            })),
            meta: { updated: records.length },
          }),
      });
    });

    const result = await markRecordsSynced(items(250));
    // Only two requests fire — the third chunk is never attempted.
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(result.timedOut).toBe(true);
    // Chunk 1 synced (100), chunk 2 all timed out (100); chunk 3 has no outcome.
    expect(result.outcomes).toHaveLength(200);
    expect(
      result.outcomes.slice(0, 100).every((outcome) => outcome === MARK_SYNCED),
    ).toBe(true);
    expect(
      result.outcomes
        .slice(100, 200)
        .every((outcome) => outcome === MARK_TIMED_OUT),
    ).toBe(true);
  });

  it('marks a whole chunk MARK_FAILED when the request rejects with an error response', async () => {
    mockFetch(
      { data: { errors: [{ title: 'Unprocessable', detail: 'bad batch' }] } },
      false,
    );
    const result = await markRecordsSynced(items(3));
    expect(result.outcomes).toEqual([MARK_FAILED, MARK_FAILED, MARK_FAILED]);
    expect(result.timedOut).toBe(false);
  });

  it('marks a whole chunk MARK_FAILED on a network failure', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
    const result = await markRecordsSynced(items(2));
    expect(result.outcomes).toEqual([MARK_FAILED, MARK_FAILED]);
  });

  it('marks the chunk MARK_FAILED for a 2xx response whose body is not valid JSON', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.reject(new Error('Unexpected token < in JSON')),
    });
    const result = await markRecordsSynced(items(1));
    expect(result.outcomes).toEqual([MARK_FAILED]);
  });
});
