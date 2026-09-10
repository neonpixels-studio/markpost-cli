import {
  authedRequest,
  isSystemicApiFailure,
  logApiFailure,
  unwrapResourceCollection,
} from '@/libs/api.js';
import { ApiPaginationLinks } from '@/types/api.types.js';
import {
  Event,
  EventListApiResponse,
  PaginatedEventsMeta,
} from '@/types/events.types.js';

// markpost paginates the events feed with the same cursor scheme as records
// (server/api/events/index.get.ts): each response's `links.next` embeds the
// `page[after]` cursor for the following page, and is `null` once
// `meta.hasMore` is false. This mirrors `extractAfterCursor` in records.ts —
// same avoidance of `URLSearchParams` (it would turn a literal `+` in the
// cursor into a space) and the same percent-decoded key match, since
// markpost's `eventPaginationLinks` (server/utils/response.ts) builds the
// link with `URLSearchParams` too, producing `page%5Bafter%5D=...`. Kept as
// its own small copy rather than importing records.ts's private helper: the
// two only share this one function today (not the rule-of-three's three
// occurrences), and pulling in the whole records module for it would be a
// worse coupling than the duplication. Flagged as a follow-up if a third
// cursor-paginated CLI resource shows up.
const decodePercentEncoding = (value: string): string | undefined => {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
};

const extractAfterCursor = (
  next: string | null | undefined,
): string | undefined => {
  if (!next) {
    return undefined;
  }

  const queryString = next.slice(next.indexOf('?') + 1);

  for (const pair of queryString.split('&')) {
    // Split on the first `=` only, so a value that itself contains an
    // unencoded `=` (e.g. base64 padding) isn't truncated.
    const separatorIndex = pair.indexOf('=');
    const rawKey = separatorIndex === -1 ? pair : pair.slice(0, separatorIndex);

    if (decodePercentEncoding(rawKey) !== 'page[after]') {
      continue;
    }

    const rawValue =
      separatorIndex === -1 ? '' : pair.slice(separatorIndex + 1);

    return decodePercentEncoding(rawValue);
  }

  return undefined;
};

const DEFAULT_PAGE_SIZE = 100;

// A read either succeeded (`ok: true`) or the INITIAL page fetch failed
// (`ok: false`) — mirrors `FetchAllRecordsResult` in records.ts and the same
// fail-loud rationale: collapsing a failed initial fetch to an empty array
// would make a network/auth error indistinguishable from "no activity",
// reporting `events list` as a clean empty log instead of a broken read.
//
// `partial` reports whether a LATER page failed mid-pagination (a
// non-systemic failure); the pages already collected are kept rather than
// discarded. A systemic failure (auth/5xx) or a request timeout on ANY page
// re-throws instead — see `fetchPaginatedEvents` — so the whole read fails
// loud and this type's `{ ok: true, partial: true }` shape is never reached
// for those.
export type FetchAllEventsResult =
  { ok: true; events: Event[]; partial: boolean } | { ok: false };

export const fetchAllEvents = async (): Promise<FetchAllEventsResult> => {
  const initial = await fetchPaginatedEvents(undefined, DEFAULT_PAGE_SIZE);

  if (!initial) {
    return { ok: false };
  }

  const events = [initial.events];
  const seenCursors = new Set<string>();
  let partial = false;

  // Resolve the next cursor from a page. The server signals "more pages" via
  // either `links.next` or `meta.hasMore` — and since `fetchPaginatedEvents`
  // defaults a malformed `links` to `next: null`, `hasMore` can be the only
  // surviving signal. If the page says there's more but yields no usable
  // cursor, the server had pages we can't follow, so flag the read
  // incomplete rather than treating it as a clean end of pagination.
  const nextCursorFrom = (page: {
    meta: PaginatedEventsMeta;
    links: ApiPaginationLinks;
  }): string | undefined => {
    const cursor = extractAfterCursor(page.links.next);

    if ((page.links.next || page.meta.hasMore) && !cursor) {
      partial = true;
    }

    return cursor;
  };

  let after = nextCursorFrom(initial);

  while (after) {
    // Bounds the loop against any repeating cursor, not just an immediate
    // repeat, so a misbehaving server can't hang the CLI.
    if (seenCursors.has(after)) {
      partial = true;
      break;
    }

    seenCursors.add(after);
    const subsequent = await fetchPaginatedEvents(after, DEFAULT_PAGE_SIZE);

    if (!subsequent) {
      // A later page failed NON-systemically (already logged). Stop, but
      // mark the read incomplete. A systemic failure or timeout on this page
      // wouldn't reach here — it re-throws out of this loop instead.
      partial = true;
      break;
    }

    events.push(subsequent.events);
    after = nextCursorFrom(subsequent);
  }

  return { ok: true, events: events.flat(1) as Event[], partial };
};

// Emits `page[size]`/`page[after]` — the only query params markpost's
// GET /api/events accepts (server/api/events/index.get.ts has no filter
// params, unlike GET /api/records).
const buildEventsQuery = (size: number, after: string | undefined): string => {
  const params = [`page[size]=${size}`];

  if (after) {
    params.push(`page[after]=${encodeURIComponent(after)}`);
  }

  return params.join('&');
};

export const fetchPaginatedEvents = async (
  after?: string,
  size: number = DEFAULT_PAGE_SIZE,
): Promise<{
  events: Event[];
  meta: PaginatedEventsMeta;
  links: ApiPaginationLinks;
} | null> => {
  try {
    const body = (await authedRequest(
      `/api/events?${buildEventsQuery(size, after)}`,
    )) as EventListApiResponse;

    const events = unwrapResourceCollection(
      'fetchPaginatedEvents',
      body,
      'event',
    );

    // `meta`/`links` fall back to conservative defaults, field by field, if a
    // response is ever malformed: `hasMore: false` and `next: null` both stop
    // pagination instead of crashing on `undefined.hasMore` or looping
    // forever chasing a cursor that was never there. `total` falls back to
    // the pre-filter resource count (not `events.length`, which has already
    // dropped any unusable resources).
    const resourceCount = (body.data ?? []).length;
    const rawMeta = body.meta as Partial<PaginatedEventsMeta> | undefined;
    const meta: PaginatedEventsMeta = {
      total: rawMeta?.total ?? resourceCount,
      size: rawMeta?.size ?? size,
      hasMore: rawMeta?.hasMore ?? false,
    };
    // markpost's eventPaginationLinks (server/utils/response.ts) sends only
    // `next` — unlike records/sources, there's no `prev` — but
    // `ApiPaginationLinks.prev` is already optional, so a missing `prev`
    // here is on-contract, not a malformed-response fallback.
    const rawLinks = body.links as Partial<ApiPaginationLinks> | undefined;
    const links: ApiPaginationLinks = {
      next: rawLinks?.next ?? null,
      prev: rawLinks?.prev ?? null,
    };

    return { events, meta, links };
  } catch (error) {
    // Auth (401/403), rate-limit (429), and 5xx failures doom every page of
    // the read, not just this one, so surface them to the caller to fail-fast
    // (mirroring fetchPaginatedRecords) instead of collapsing them to null,
    // which fetchAllEvents can't tell apart from a genuinely empty log.
    if (isSystemicApiFailure(error)) {
      throw error;
    }

    logApiFailure('fetchPaginatedEvents', error);

    return null;
  }
};
