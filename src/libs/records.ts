import {
  ApiTimeoutError,
  authedRequest,
  isSystemicApiFailure,
  logApiFailure,
  unwrapResourceAttributes,
  unwrapResourceCollection,
} from '@/libs/api.js';
import { logErrorMessage } from '@/libs/errors.js';
import {
  ApiDeleteMeta,
  ApiDeleteResponse,
  ApiPaginationLinks,
} from '@/types/api.types.js';
import {
  Record,
  PaginatedRecordsMeta,
  RecordApiResponse,
  RecordListApiResponse,
} from '@/types/records.types.js';

// markpost's record lifecycle statuses (server/db/schema.ts RECORD_STATUSES).
// The sync only ever wants records not yet written to disk, so it fetches
// `pending` and, once a record is written, PATCHes it to `synced`.
export const PENDING_STATUS = 'pending';
const SYNCED_STATUS = 'synced';

// Result of marking one record synced. `MARK_SYNCED` — the server accepted the
// PATCH. `MARK_FAILED` — a non-timeout error; the record stays pending and the
// rest of the batch still runs. `MARK_TIMED_OUT` — the PATCH hit the request
// timeout, a signal the server is hung; the batch runner stops on the first one
// rather than paying the full timeout on every remaining record.
//
// Values are prefixed (`mark-*`) so they never collide with the wire
// `SYNCED_STATUS = 'synced'` above: these are internal outcome tags, not the
// status string sent to the server, and an accidental cross-comparison should
// not silently type-check as equal.
export const MARK_SYNCED = 'mark-synced';
export const MARK_FAILED = 'mark-failed';
export const MARK_TIMED_OUT = 'mark-timed-out';

export type MarkSyncedOutcome =
  typeof MARK_SYNCED | typeof MARK_FAILED | typeof MARK_TIMED_OUT;

// markpost paginates with a cursor: each response's `links.next` embeds the
// `page[after]` cursor to request the following page, and is `null` once
// `meta.hasMore` is false. Extracting it from the link (rather than
// re-deriving it from the last record) keeps the CLI decoupled from the
// server's cursor implementation.
//
// This intentionally avoids `URLSearchParams`, which decodes
// `application/x-www-form-urlencoded` and would turn a literal `+` in the
// cursor value into a space; a plain percent-decode of the raw param
// preserves the cursor exactly as the server sent it. The key itself is
// matched after percent-decoding too, since markpost's own link builder
// (`server/utils/response.ts`) produces it as `page%5Bafter%5D=...` via
// `URLSearchParams`, not the literal `page[after]=...`.
// A malformed percent-encoding (e.g. a lone `%`) throws from
// `decodeURIComponent`. Treat that as "no cursor" rather than letting it
// crash `fetchAllRecords` and discard every page already collected.
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

// The list filters markpost's `GET /api/records` validates and applies (see
// markpost `server/api/records/index.get.ts`): `filter[source]`,
// `filter[status]`, and `filter[q]`. The CLI passes the raw values straight
// through and does not re-implement the server's validation logic here (an
// invalid `filter[source]` is rejected server-side and surfaced); markpost
// stays the single source of truth for which values are allowed, so the two
// can't drift.
export type RecordListFilters = {
  source?: string;
  status?: string;
  search?: string;
};

// A read either succeeded (`ok: true`) or the INITIAL page fetch failed
// (`ok: false`). Collapsing a failed initial fetch to an empty array — the old
// behavior — made a network/auth error indistinguishable from "no pending
// records", so `sync` reported success and exited 0 while syncing nothing: a
// fail-loud violation that silently masked sync failures in cron. This mirrors
// `fetchSettings`'s `SettingsReadResult` so the caller must handle the failure
// explicitly rather than reading a bare array that hides it.
//
// On success, `records` may be empty (a legitimately empty account) and
// `partial` reports whether a LATER page failed mid-pagination. We keep the
// pages already collected (discarding them would be worse), but flag the read
// incomplete rather than silently returning a truncated result the caller
// can't tell apart from a complete one — the same fail-loud concern one page
// in. The caller surfaces `partial` (warn + non-zero exit); the unfetched
// pages stay on the server for a later run.
//
// `partial` covers only NON-systemic later-page failures (a transient network
// blip, a malformed page). A systemic failure (auth/5xx) or a request timeout
// on ANY page — including a later one — rejects instead: `fetchPaginatedRecords`
// re-throws it and this function has no catch, so the whole read fails loud and
// discards the pages already collected (a dead token or down server will only
// keep failing). Those cases never reach the `{ ok: true, partial: true }`
// shape; the caller's catch surfaces the classified cause.
export type FetchAllRecordsResult =
  { ok: true; records: Record[]; partial: boolean } | { ok: false };

// Maps each CLI filter to the exact query-param name markpost expects. `q`
// (not `search`) is markpost's title/content search parameter.
// A mapped type, not `Record<...>`: this module imports a `Record` record
// type from records.types.js, which shadows TypeScript's global `Record`
// utility.
const FILTER_QUERY_KEYS: { [Key in keyof RecordListFilters]-?: string } = {
  source: 'filter[source]',
  status: 'filter[status]',
  search: 'filter[q]',
};

const DEFAULT_PAGE_SIZE = 100;

export const fetchAllRecords = async (
  filters: RecordListFilters = {},
): Promise<FetchAllRecordsResult> => {
  const initial = await fetchPaginatedRecords(
    undefined,
    DEFAULT_PAGE_SIZE,
    filters,
  );

  // Return `{ ok: false }` rather than `[]` so the caller can tell a failed
  // request apart from a genuinely empty result. This matters most for
  // filtered listings: markpost rejects an invalid `filter[source]` with a
  // 400, and returning `[]` here would render that as "No records found.", a
  // silent failure. fetchPaginatedRecords has already logged the underlying
  // cause; the command surfaces the failure and exits non-zero. A NON-systemic
  // subsequent-page failure (`null`) still returns the pages already collected
  // and flags `partial` so progress isn't discarded; a systemic failure or a
  // timeout on any page instead re-throws (see the type doc above), so the
  // whole read fails loud rather than writing/deleting a partial set.
  if (!initial) {
    return { ok: false };
  }

  const records = [initial.records];
  const seenCursors = new Set<string>();
  let partial = false;

  // Resolve the next cursor from a page. The server signals "more pages" via
  // either `links.next` or `meta.hasMore` — and since `fetchPaginatedRecords`
  // defaults a malformed `links` to `next: null`, `hasMore` can be the only
  // surviving signal. If the page says there's more but yields no usable cursor
  // (null/malformed link, missing `page[after]`, or the `hasMore`-only case),
  // the server had pages we can't follow, so flag the read incomplete rather
  // than treating it as a clean end of pagination.
  const nextCursorFrom = (page: {
    meta: PaginatedRecordsMeta;
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
    // `seenCursors` bounds the loop against any repeating cursor (not just an
    // immediate repeat), so a misbehaving server can't hang the CLI. A repeat
    // means the server looped us over already-fetched pages while still
    // advertising more, so stop but flag the truncation.
    if (seenCursors.has(after)) {
      partial = true;
      break;
    }

    seenCursors.add(after);
    const subsequent = await fetchPaginatedRecords(
      after,
      DEFAULT_PAGE_SIZE,
      filters,
    );

    if (!subsequent) {
      // A later page failed NON-systemically (`fetchPaginatedRecords` already
      // logged why). Stop, but mark the read incomplete so the caller doesn't
      // present a truncated set as the whole. A systemic failure or timeout on
      // this page wouldn't reach here — it re-throws out of this loop instead.
      partial = true;
      break;
    }

    records.push(subsequent.records);
    after = nextCursorFrom(subsequent);
  }

  return { ok: true, records: records.flat(1) as Record[], partial };
};

// Emits `page[size]`/`page[after]` plus whichever of markpost's list filters
// (`filter[source]`, `filter[status]`, `filter[q]`) the caller supplied.
// markpost's GET /api/records returns every status when no `filter[status]` is
// given (server/api/records/index.get.ts), so scoping the sync to pending is
// the caller's job (see the `PENDING_STATUS` call in src/index.ts) — this keeps
// `records list` free to page any status the user asks for.
const buildRecordsQuery = (
  size: number,
  after: string | undefined,
  filters: RecordListFilters,
): string => {
  const params = [`page[size]=${size}`];

  if (after) {
    params.push(`page[after]=${encodeURIComponent(after)}`);
  }

  const filterKeys = Object.keys(
    FILTER_QUERY_KEYS,
  ) as (keyof RecordListFilters)[];

  for (const filterKey of filterKeys) {
    const value = filters[filterKey];

    if (!value) {
      continue;
    }

    params.push(`${FILTER_QUERY_KEYS[filterKey]}=${encodeURIComponent(value)}`);
  }

  return params.join('&');
};

export const fetchPaginatedRecords = async (
  after?: string,
  size: number = DEFAULT_PAGE_SIZE,
  filters: RecordListFilters = {},
): Promise<{
  records: Record[];
  meta: PaginatedRecordsMeta;
  links: ApiPaginationLinks;
} | null> => {
  try {
    const body = (await authedRequest(
      `/api/records?${buildRecordsQuery(size, after, filters)}`,
    )) as RecordListApiResponse;

    const records = unwrapResourceCollection(
      'fetchPaginatedRecords',
      body,
      'record',
    );

    // `meta`/`links` fall back to conservative defaults, field by field
    // (rather than an unchecked cast of a possibly-partial object), if a
    // response is ever malformed: `hasMore: false` and `next: null` both
    // stop pagination instead of the caller crashing on `undefined.hasMore`
    // or looping forever chasing a cursor that was never there.
    //
    // `total` falls back to the pre-filter resource count (not
    // `records.length`, which has already dropped any unusable resources) —
    // when `meta` is also missing, the fallback should still describe how
    // many resources the server actually sent, not how many survived the
    // attributes check.
    const resourceCount = (body.data ?? []).length;
    const rawMeta = body.meta as Partial<PaginatedRecordsMeta> | undefined;
    const meta: PaginatedRecordsMeta = {
      total: rawMeta?.total ?? resourceCount,
      size: rawMeta?.size ?? size,
      hasMore: rawMeta?.hasMore ?? false,
    };
    const rawLinks = body.links as Partial<ApiPaginationLinks> | undefined;
    const links: ApiPaginationLinks = {
      next: rawLinks?.next ?? null,
      prev: rawLinks?.prev ?? null,
    };

    return { records, meta, links };
  } catch (error) {
    // Auth (401/403), rate-limit (429), and 5xx failures doom every page of
    // the read, not just this one, so surface them to the caller to fail-fast
    // (mirroring createRecord) instead of collapsing them to null — which
    // fetchAllRecords can't tell apart from a genuinely empty result and would
    // report as a silent "No new records" success (issue #89).
    if (isSystemicApiFailure(error)) {
      throw error;
    }

    logApiFailure(`fetchPaginatedRecords`, error);

    return null;
  }
};

export const createRecord = async (
  title: string,
  content: string,
): Promise<Record | null> => {
  try {
    const body = (await authedRequest('/api/records', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/vnd.api+json',
      },
      body: JSON.stringify({
        data: {
          type: 'records',
          attributes: {
            title,
            content,
          },
        },
      }),
    })) as RecordApiResponse;

    return unwrapResourceAttributes(body);
  } catch (error) {
    // Auth (401/403) and 5xx failures doom every other record in a bulk push,
    // so surface them to the caller to fail-fast rather than logging and
    // returning null (which the caller can't distinguish from a per-file 4xx).
    if (isSystemicApiFailure(error)) {
      throw error;
    }

    // `logApiFailure` re-throws a timeout (fail loud) and logs everything else.
    logApiFailure(`createRecord["${title}"]`, error);

    return null;
  }
};

// markpost's bulk update handler (server/api/records/index.patch.ts) caps each
// PATCH /api/records request at this many records (`MAX_UPDATE_BATCH_SIZE`); a
// larger `records[]` array is rejected with a 422. The CLI chunks to this size
// so a first sync of hundreds of records settles in `ceil(N / 100)` requests
// instead of one PATCH per record — the whole point of moving off the per-uuid
// endpoint (issue #123).
export const MAX_MARK_SYNCED_BATCH_SIZE = 100;

// One record the CLI wants marked synced: the uuid to update and the on-disk
// path markpost stores so its UI can show where the note landed.
export type MarkSyncedItem = {
  uuid: string;
  filePath: string;
};

// Outcome of a whole bulk mark-synced run. `outcomes` holds one entry per
// record in the ORIGINAL input order, so the caller can align each result back
// to its record by index. On a timeout abort it's shorter than the input: the
// chunk that timed out and every chunk after it were never confirmed, so those
// trailing records have no outcome and the caller treats them as still pending.
// `timedOut` records whether a request timeout stopped the run early.
export type MarkSyncedResult = {
  outcomes: MarkSyncedOutcome[];
  timedOut: boolean;
};

// The `records[]` item markpost's bulk PATCH expects: the uuid to match plus
// the attributes to set. The CLI always sets `status`, `syncedAt`, and
// `filePath` together — moving a written record out of `pending` so the next
// run's pending-only fetch skips it. `filePath` is sent deliberately: markpost
// stores it on the record so its UI can show where a synced note landed — the
// user's own local path going to their own account, not a third-party leak.
const buildBulkRecordPayload = (item: MarkSyncedItem, syncedAt: string) => {
  return {
    uuid: item.uuid,
    status: SYNCED_STATUS,
    syncedAt,
    filePath: item.filePath,
  };
};

// Maps one chunk's request outcome to a per-item result. markpost returns only
// the records it actually updated (foreign/nonexistent uuids are silently
// dropped, mirroring the bulk delete endpoint), so a uuid absent from the
// response was NOT marked — it stays `pending` and is reported `MARK_FAILED`
// so the caller can warn the user rather than silently losing it. Reading the
// returned collection (rather than trusting a bare 2xx) is what gives the CLI
// real partial-failure detection across a 100-record chunk.
const outcomesFromResponse = (
  items: MarkSyncedItem[],
  body: RecordListApiResponse,
): MarkSyncedOutcome[] => {
  const updated = unwrapResourceCollection('markRecordsSynced', body, 'record');
  const updatedUuids = new Set(updated.map((record) => record.uuid));

  return items.map((item) =>
    updatedUuids.has(item.uuid) ? MARK_SYNCED : MARK_FAILED,
  );
};

// PATCHes one chunk (<= MAX_MARK_SYNCED_BATCH_SIZE records) synced in a single
// bulk request. Routes through the shared `authedRequest` seam (like every
// other call): it attaches the bearer token, asserts success (throwing on a
// non-2xx, an errors-carrying 2xx, or an unparseable body such as an HTML error
// page behind a 200), and inherits the request timeout so a stalled connection
// can't hang the sync forever. A failure here is logged, not re-thrown — this
// is non-critical post-write bookkeeping (the files are already on disk), so a
// failed chunk simply leaves its records `pending` to re-sync next run. A
// timeout maps every item in the chunk to `MARK_TIMED_OUT` so the caller can
// stop the remaining chunks; any other failure maps them to `MARK_FAILED`.
const markSyncedChunk = async (
  items: MarkSyncedItem[],
  syncedAt: string,
): Promise<MarkSyncedOutcome[]> => {
  try {
    const body = (await authedRequest('/api/records', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/vnd.api+json',
      },
      body: JSON.stringify({
        data: {
          type: 'records',
          attributes: {
            records: items.map((item) =>
              buildBulkRecordPayload(item, syncedAt),
            ),
          },
        },
      }),
    })) as RecordListApiResponse;

    return outcomesFromResponse(items, body);
  } catch (error) {
    logErrorMessage(
      `markRecordsSynced[${items.length} record(s)]`,
      error instanceof Error ? error.message : String(error),
    );

    // A timeout gets its own outcome so the caller can abort the remaining
    // chunks on the first one; every other error just leaves this chunk's
    // records pending and lets the rest of the run proceed.
    const outcome =
      error instanceof ApiTimeoutError ? MARK_TIMED_OUT : MARK_FAILED;

    return items.map(() => outcome);
  }
};

// Marks written records synced after the CLI has written them to disk, via
// markpost's bulk PATCH /api/records (server/api/records/index.patch.ts). This
// is the non-destructive counterpart to `deleteRecords`: with autoDelete off,
// moving each record out of `pending` is what stops the next run's pending-only
// fetch from re-writing it. `syncedAt` is injected (defaulting to now) so
// callers and tests can pin the timestamp.
//
// Chunks the input into `ceil(N / MAX_MARK_SYNCED_BATCH_SIZE)` requests so a
// large first sync settles up to 100 records per PATCH instead of one request
// per record — the rate-limit/connection pressure that motivated issue #123.
// Chunks run sequentially (not in parallel): the previous per-record path
// bounded concurrency for exactly this reason, and one request per 100 records
// is already few enough that firing them serially keeps the burst small without
// a concurrency limiter.
//
// Returns one outcome per record in input order. A timeout signals a hung
// server, so the run stops at the chunk that first timed out rather than paying
// the full request timeout on every remaining chunk; those trailing records get
// no outcome and stay `pending` (their outcome index is `undefined`, which the
// caller reads as not-synced). Non-timeout failures don't abort — a later chunk
// may still succeed.
export const markRecordsSynced = async (
  items: MarkSyncedItem[],
  syncedAt: string = new Date().toISOString(),
): Promise<MarkSyncedResult> => {
  const outcomes: MarkSyncedOutcome[] = [];

  for (
    let start = 0;
    start < items.length;
    start += MAX_MARK_SYNCED_BATCH_SIZE
  ) {
    const chunk = items.slice(start, start + MAX_MARK_SYNCED_BATCH_SIZE);
    const chunkOutcomes = await markSyncedChunk(chunk, syncedAt);

    outcomes.push(...chunkOutcomes);

    if (chunkOutcomes.includes(MARK_TIMED_OUT)) {
      return { outcomes, timedOut: true };
    }
  }

  return { outcomes, timedOut: false };
};

export const fetchRecord = async (uuid: string): Promise<Record | null> => {
  try {
    const body = (await authedRequest(
      `/api/records/${encodeURIComponent(uuid)}`,
    )) as RecordApiResponse;

    return unwrapResourceAttributes(body);
  } catch (error) {
    // A systemic auth/5xx failure is not "record not found" — re-throw it
    // (mirroring createRecord) so `get` reports the real cause with a non-zero
    // exit, instead of the generic "Failed to fetch record" a null return
    // produces. A genuine 404 stays non-systemic and still returns null.
    if (isSystemicApiFailure(error)) {
      throw error;
    }

    logApiFailure(`fetchRecord["${uuid}"]`, error);

    return null;
  }
};

export const deleteRecords = async (
  uuids: string[],
): Promise<ApiDeleteMeta | null> => {
  try {
    const body = (await authedRequest('/api/records', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/vnd.api+json',
      },
      body: JSON.stringify({
        data: {
          type: 'records',
          attributes: {
            uuids: uuids,
          },
        },
      }),
    })) as ApiDeleteResponse;

    return body.meta ?? null;
  } catch (error) {
    // A systemic auth/5xx failure will recur for the whole batch, so re-throw
    // it (mirroring createRecord) to surface the real cause rather than the
    // generic delete-failure message a null return produces. The sync's
    // inline catch prints it and still leaves the records on the server.
    if (isSystemicApiFailure(error)) {
      throw error;
    }

    logApiFailure(`deleteRecords["${uuids.join(', ')}"]`, error);

    return null;
  }
};
