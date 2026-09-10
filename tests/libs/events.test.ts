import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchAllEvents, fetchPaginatedEvents } from '@/libs/events.js';
import { Event } from '@/types/events.types.js';

// @/libs/api.js imports @/libs/config.js, which constructs a real
// `conf`-backed store as soon as it's loaded — mock it so loading api.js
// doesn't pull in that side effect (mirrors tests/libs/records.test.ts).
vi.mock('@/libs/config.js', () => ({
  config: { get: vi.fn() },
}));

beforeEach(() => {
  vi.stubEnv('BASE_URL', 'https://example.com');
  vi.stubEnv('API_TOKEN', 'test-token');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function mockFetch(responseBody: object, ok = true, status = ok ? 200 : 400) {
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(responseBody),
  });
}

function mockFetchTimeout() {
  global.fetch = vi
    .fn()
    .mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
}

const mockEvent: Event = {
  id: 'evt-1',
  userId: 'user-1',
  ts: '2024-01-01T00:00:00Z',
  kind: 'ok',
  message: 'Ingested record from webhook',
  recordUuid: 'rec-1',
  sourceId: 'src-1',
};

const mockEvent2: Event = {
  id: 'evt-2',
  userId: 'user-1',
  ts: '2024-01-02T00:00:00Z',
  kind: 'err',
  message: 'Signature verification failed',
  recordUuid: null,
  sourceId: 'src-1',
};

function eventResource(event: Event) {
  return {
    type: 'events',
    id: event.id,
    attributes: event,
    links: { self: `/api/events/${event.id}` },
  };
}

describe('fetchPaginatedEvents', () => {
  it('fetches and unwraps a page of events', async () => {
    mockFetch({
      data: [eventResource(mockEvent)],
      meta: { total: 1, size: 100, hasMore: false },
      links: { next: null },
    });

    const result = await fetchPaginatedEvents();

    expect(result).toEqual({
      events: [mockEvent],
      meta: { total: 1, size: 100, hasMore: false },
      links: { next: null, prev: null },
    });
  });

  it('sends page[size] and page[after] as query params', async () => {
    mockFetch({ data: [], meta: { total: 0, size: 50, hasMore: false } });

    await fetchPaginatedEvents('cursor-1', 50);

    const requestedUrl = vi.mocked(global.fetch).mock.calls[0][0] as string;
    expect(requestedUrl).toContain('page[size]=50');
    expect(requestedUrl).toContain(
      `page[after]=${encodeURIComponent('cursor-1')}`,
    );
  });

  // markpost's eventPaginationLinks sends only `next` (no `prev`), unlike
  // records/sources — a missing `prev` is on-contract, not a malformed
  // fallback, and `ApiPaginationLinks.prev` is already optional.
  it('defaults a missing prev link to null without treating the response as malformed', async () => {
    mockFetch({
      data: [eventResource(mockEvent)],
      meta: { total: 1, size: 100, hasMore: false },
      links: { next: null },
    });

    const result = await fetchPaginatedEvents();

    expect(result?.links).toEqual({ next: null, prev: null });
  });

  // A malformed/missing meta or links must fall back to conservative
  // defaults (hasMore: false, next: null) rather than crashing on
  // `undefined.hasMore`, mirroring fetchPaginatedRecords.
  it('falls back to conservative defaults when meta/links are missing', async () => {
    mockFetch({ data: [eventResource(mockEvent)] });

    const result = await fetchPaginatedEvents();

    expect(result?.meta).toEqual({ total: 1, size: 100, hasMore: false });
    expect(result?.links).toEqual({ next: null, prev: null });
  });

  it('returns null and logs on a non-systemic failure', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const result = await fetchPaginatedEvents();

    expect(result).toBeNull();
    expect(console.error).toHaveBeenCalled();
  });

  // A systemic auth failure dooms every page of the read, so it must
  // propagate rather than collapse to null (mirrors fetchPaginatedRecords).
  it('propagates a systemic auth (401) failure instead of returning null', async () => {
    mockFetch(
      {
        errors: [
          { status: '401', title: 'Unauthorized', detail: 'Invalid token' },
        ],
      },
      false,
      401,
    );

    await expect(fetchPaginatedEvents()).rejects.toThrow();
  });
});

describe('fetchAllEvents', () => {
  // A failed INITIAL fetch must surface as `{ ok: false }` — never an empty
  // array, which the caller can't tell apart from a genuinely empty log.
  it('returns { ok: false } when the initial fetch fails', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    expect(await fetchAllEvents()).toEqual({ ok: false });
  });

  it('returns an empty, non-partial result for an empty log', async () => {
    mockFetch({
      data: [],
      meta: { total: 0, size: 100, hasMore: false },
      links: { next: null },
    });

    expect(await fetchAllEvents()).toEqual({
      ok: true,
      events: [],
      partial: false,
    });
  });

  it('returns every event from a single page', async () => {
    mockFetch({
      data: [eventResource(mockEvent), eventResource(mockEvent2)],
      meta: { total: 2, size: 100, hasMore: false },
      links: { next: null },
    });

    expect(await fetchAllEvents()).toEqual({
      ok: true,
      events: [mockEvent, mockEvent2],
      partial: false,
    });
  });

  it('follows the cursor across multiple pages', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [eventResource(mockEvent)],
            meta: { total: 2, size: 1, hasMore: true },
            links: {
              next: '/api/events?page%5Bafter%5D=evt-1&page%5Bsize%5D=1',
            },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [eventResource(mockEvent2)],
            meta: { total: 2, size: 1, hasMore: false },
            links: { next: null },
          }),
      });
    global.fetch = fetchMock;

    const result = await fetchAllEvents();

    expect(result).toEqual({
      ok: true,
      events: [mockEvent, mockEvent2],
      partial: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondRequestUrl = fetchMock.mock.calls[1][0] as string;
    expect(secondRequestUrl).toContain(
      `page[after]=${encodeURIComponent('evt-1')}`,
    );
  });

  // A later page failing non-systemically must keep the pages already
  // collected but flag the read incomplete, not silently truncate.
  it('flags partial when a later page fails non-systemically', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [eventResource(mockEvent)],
            meta: { total: 2, size: 1, hasMore: true },
            links: {
              next: '/api/events?page%5Bafter%5D=evt-1&page%5Bsize%5D=1',
            },
          }),
      })
      .mockRejectedValueOnce(new Error('Network blip'));
    global.fetch = fetchMock;

    const result = await fetchAllEvents();

    expect(result).toEqual({
      ok: true,
      events: [mockEvent],
      partial: true,
    });
  });

  // A systemic failure on a LATER page must still propagate (fail loud),
  // not collapse into a partial success — the whole read is doomed.
  it('propagates a systemic failure encountered on a later page', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [eventResource(mockEvent)],
            meta: { total: 2, size: 1, hasMore: true },
            links: {
              next: '/api/events?page%5Bafter%5D=evt-1&page%5Bsize%5D=1',
            },
          }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () =>
          Promise.resolve({
            errors: [{ status: '500', title: 'Server error', detail: 'boom' }],
          }),
      });
    global.fetch = fetchMock;

    await expect(fetchAllEvents()).rejects.toThrow();
  });

  // A request timeout on the INITIAL page must propagate as an
  // ApiTimeoutError (fail loud), never collapse to `{ ok: false }`.
  it('propagates a timeout on the initial page', async () => {
    mockFetchTimeout();

    await expect(fetchAllEvents()).rejects.toThrow(/timed out/);
  });

  // A request timeout on a LATER page dooms the rest of the read the same
  // way a systemic failure does — it must propagate, not degrade to a
  // partial success (logApiFailure re-throws a timeout via rethrowIfTimeout).
  it('propagates a timeout encountered on a later page', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [eventResource(mockEvent)],
            meta: { total: 2, size: 1, hasMore: true },
            links: {
              next: '/api/events?page%5Bafter%5D=evt-1&page%5Bsize%5D=1',
            },
          }),
      })
      .mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));
    global.fetch = fetchMock;

    await expect(fetchAllEvents()).rejects.toThrow(/timed out/);
  });

  // A page claiming more results but yielding no usable cursor (malformed
  // link) must flag the read incomplete rather than silently ending.
  it('flags partial when a page claims more but the cursor is unreadable', async () => {
    mockFetch({
      data: [eventResource(mockEvent)],
      meta: { total: 2, size: 1, hasMore: true },
      links: { next: null },
    });

    expect(await fetchAllEvents()).toEqual({
      ok: true,
      events: [mockEvent],
      partial: true,
    });
  });

  // A present `next` link that carries no `page[after]` param (a malformed
  // link, distinct from a `null` link) must also flag the read incomplete.
  it('flags partial when the next link is present but has no page[after]', async () => {
    mockFetch({
      data: [eventResource(mockEvent)],
      meta: { total: 2, size: 1, hasMore: true },
      links: { next: '/api/events?page%5Bsize%5D=1' },
    });

    expect(await fetchAllEvents()).toEqual({
      ok: true,
      events: [mockEvent],
      partial: true,
    });
  });

  // A repeating cursor (a misbehaving server looping already-fetched pages)
  // must not hang the CLI — stop and flag the read incomplete.
  it('stops and flags partial on a repeating cursor', async () => {
    const pageBody = {
      data: [eventResource(mockEvent)],
      meta: { total: 5, size: 1, hasMore: true },
      links: { next: '/api/events?page%5Bafter%5D=evt-1&page%5Bsize%5D=1' },
    };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(pageBody),
    });

    const result = await fetchAllEvents();

    expect(result).toEqual({
      ok: true,
      events: [mockEvent, mockEvent],
      partial: true,
    });
  });
});
