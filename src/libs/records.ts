import {
  ApiTimeoutError,
  authedRequest,
  isFatalRequestError,
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

// Per-record result of a bulk mark-synced run (see `markRecordsSynced`, which
// PATCHes records in chunks of up to MAX_MARK_SYNCED_BATCH_SIZE). `MARK_SYNCED`
// — the server returned this record among the ones it updated. `MARK_FAILED` —
// the record's chunk failed (a non-timeout, non-request-shape error), or the
// server didn't return this uuid (partial success); it stays pending to re-sync
// next run. A plain chunk failure doesn't stop the run, but a systemic one
// (auth/rate-limit/5xx) aborts the remaining chunks — see `markSyncedChunk`.
// `MARK_TIMED_OUT` — the record's chunk hit the request timeout, a signal the
// server is hung; the run stops there rather than paying the full timeout on
// every remaining chunk. `MARK_ABORTED` — the chunk was rejected with a
// request-shape 4xx (a malformed-payload 400 or a contract-validation 422, NOT
// an auth 401/403 or a transient 429): the CLI builds every chunk's payload
// identically, so once a SECOND chunk is rejected the same way with nothing
// synced the run aborts rather than fire the same doomed request again (a lone
// rejection isn't enough — see `markRecordsSynced`).
//
// Values are prefixed (`mark-*`) so they never collide with the wire
// `SYNCED_STATUS = 'synced'` above: these are internal outcome tags, not the
// status string sent to the server, and an accidental cross-comparison should
// not silently type-check as equal.
export const MARK_SYNCED = 'mark-synced';
export const MARK_FAILED = 'mark-failed';
export const MARK_TIMED_OUT = 'mark-timed-out';
export const MARK_ABORTED = 'mark-aborted';

export type MarkSyncedOutcome =
  | typeof MARK_SYNCED
  | typeof MARK_FAILED
  | typeof MARK_TIMED_OUT
  | typeof MARK_ABORTED;

// Why a mark-synced run stopped early (a hung server or a categorically wrong
// request), or null if every record was attempted.
export type MarkSyncedStop = typeof MARK_TIMED_OUT | typeof MARK_ABORTED | null;

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
// to its record by index. On an abort (a timeout, a systemic auth/rate-limit/
// 5xx failure, or a request-shape 4xx) it's shorter than the input: the chunk
// that aborted and every chunk after it were never confirmed, so those trailing
// records have no outcome and the caller treats them as still pending.
// `stoppedBy` records which distinctly-reported reason ended the run early — a
// timeout (`MARK_TIMED_OUT`) or a wholesale request-shape rejection
// (`MARK_ABORTED`) — or null when the run finished or stopped on a systemic
// failure (reported as a plain mark failure), so the caller can word its report.
export type MarkSyncedResult = {
  outcomes: MarkSyncedOutcome[];
  stoppedBy: MarkSyncedStop;
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

// Reads the `meta.updated` count off a bulk-PATCH response, if present. markpost
// sends it alongside `data` (server/api/records/index.patch.ts); it's the
// corroborating signal used only when `data` itself is unreadable.
const updatedCountFromMeta = (
  body: RecordListApiResponse,
): number | undefined => {
  const meta = body.meta as { updated?: unknown } | undefined;

  return typeof meta?.updated === 'number' ? meta.updated : undefined;
};

// Maps one chunk's request outcome to a per-item result. markpost returns the
// records it actually updated as the `data` collection (always an array;
// foreign/nonexistent uuids are silently dropped, mirroring the bulk delete
// endpoint), so a uuid present there was synced and one absent stays `pending`
// and is reported `MARK_FAILED` — that per-uuid diff is what gives the CLI real
// partial-failure detection across a 100-record chunk, rather than trusting a
// bare 2xx.
//
// If `data` is ever NOT an array (an off-contract or proxied response the
// declared contract never produces), the per-uuid diff can't run, so fall back
// to the corroborating `meta.updated` count: a full count means the whole chunk
// was accepted (all `MARK_SYNCED`); anything else fails the chunk loud so its
// records retry next run rather than being silently reported synced.
const outcomesFromResponse = (
  items: MarkSyncedItem[],
  body: RecordListApiResponse,
): MarkSyncedOutcome[] => {
  if (!Array.isArray(body.data)) {
    const wholeChunkAccepted = updatedCountFromMeta(body) === items.length;

    return items.map(() => (wholeChunkAccepted ? MARK_SYNCED : MARK_FAILED));
  }

  const updated = unwrapResourceCollection('markRecordsSynced', body, 'record');
  const updatedUuids = new Set(updated.map((record) => record.uuid));

  return items.map((item) =>
    updatedUuids.has(item.uuid) ? MARK_SYNCED : MARK_FAILED,
  );
};

// How a chunk ended, from the chunk's OWN perspective — the run-level decision to
// stop is `markRecordsSynced`'s, which also weighs prior chunks. `STOP_TIMEOUT`
// (hung server) and `STOP_SYSTEMIC` (auth/rate-limit/5xx) each doom every
// remaining chunk, so the caller aborts immediately. `STOP_REQUEST_SHAPE` (a
// 400/422) means the payload envelope looks wrong, but the caller only aborts
// once a SECOND consecutive chunk is rejected with the SAME error (see
// `markRecordsSynced`) rather than strand records behind a single, possibly
// isolated rejection. `null` is a clean chunk or a plain per-chunk failure the
// caller runs past. Named constants (not bare literals) so the discriminant a
// third function might compare against can't silently drift on a typo.
const STOP_TIMEOUT = 'timeout';
const STOP_SYSTEMIC = 'systemic';
const STOP_REQUEST_SHAPE = 'request-shape';
type ChunkStop =
  typeof STOP_TIMEOUT | typeof STOP_SYSTEMIC | typeof STOP_REQUEST_SHAPE | null;

// The result of PATCHing one chunk: a per-item outcome list, how the chunk ended,
// and (for a `request-shape` stop only) the server's error message. The caller
// compares that message across chunks so a categorical envelope rejection (the
// same message twice) aborts, while two different per-record rejections that only
// happen to both 4xx do not — it keeps running past those. Null for every other
// stop kind.
type MarkSyncedChunkResult = {
  outcomes: MarkSyncedOutcome[];
  stop: ChunkStop;
  message: string | null;
};

// PATCHes one chunk (<= MAX_MARK_SYNCED_BATCH_SIZE records) synced in a single
// bulk request. Routes through the shared `authedRequest` seam (like every
// other call): it attaches the bearer token, asserts success (throwing on a
// non-2xx, an errors-carrying 2xx, or an unparseable body such as an HTML error
// page behind a 200), and inherits the request timeout so a stalled connection
// can't hang the sync forever. A failure here is logged, not re-thrown — this
// is non-critical post-write bookkeeping (the files are already on disk), so a
// failed chunk simply leaves its records `pending` to re-sync next run.
//
// A timeout maps every item to `MARK_TIMED_OUT` and reports `STOP_TIMEOUT` (a
// hung server would burn the full request timeout on every remaining chunk). A
// request-shape 4xx (a malformed-payload 400 or a contract-validation 422) maps
// every item to `MARK_FAILED` and reports `STOP_REQUEST_SHAPE` plus the server's
// error message: the chunk was attempted and rejected, so its records are a plain
// failure UNLESS the run actually aborts — `markRecordsSynced` re-tags only the
// chunk it stops on to `MARK_ABORTED`, so a completed run never leaves a stray
// `MARK_ABORTED`. A systemic failure (auth/rate-limit/5xx) reports `STOP_SYSTEMIC`
// — it will recur for every remaining chunk, so the caller backs off rather than
// hammering a server that just rejected the burst (the same rule the fetch helpers
// apply via `isSystemicApiFailure`) — but stays `MARK_FAILED`, reported as a plain
// failure. Any other (per-chunk) failure maps to `MARK_FAILED` with `stop: null` —
// a later chunk may still succeed. A 4xx delivered as an HTML error page (a
// WAF/proxy interstitial) throws unparseable before it can be classified, so it
// degrades to that plain failure rather than aborting on a misread status.
const markSyncedChunk = async (
  items: MarkSyncedItem[],
  syncedAt: string,
): Promise<MarkSyncedChunkResult> => {
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

    return {
      outcomes: outcomesFromResponse(items, body),
      stop: null,
      message: null,
    };
  } catch (error) {
    // Identify the chunk by its uuid range so a stderr reader can tell which
    // records this failure left pending without cross-referencing the caller's
    // own per-record report.
    const firstUuid = items[0]?.uuid;
    const lastUuid = items[items.length - 1]?.uuid;
    logErrorMessage(
      `markRecordsSynced[${firstUuid}..${lastUuid}, ${items.length} record(s)]`,
      error instanceof Error ? error.message : String(error),
    );

    if (error instanceof ApiTimeoutError) {
      return {
        outcomes: items.map(() => MARK_TIMED_OUT),
        stop: STOP_TIMEOUT,
        message: null,
      };
    }

    // A request-shape 4xx and any other (per-chunk/systemic) failure both leave
    // the whole chunk pending, so they share this outcome list; only the stop
    // classification differs.
    const failedOutcomes: MarkSyncedOutcome[] = items.map(() => MARK_FAILED);

    if (isFatalRequestError(error)) {
      return {
        outcomes: failedOutcomes,
        stop: STOP_REQUEST_SHAPE,
        message: error.message,
      };
    }

    return {
      outcomes: failedOutcomes,
      stop: isSystemicApiFailure(error) ? STOP_SYSTEMIC : null,
      message: null,
    };
  }
};

// Re-tag the final `count` outcomes as `MARK_ABORTED` — the chunk whose repeated
// request-shape rejection actually stopped the run. Returns a new array so the
// caller stays free of in-place mutation; earlier outcomes are untouched.
const withAbortedTail = (
  outcomes: MarkSyncedOutcome[],
  count: number,
): MarkSyncedOutcome[] => {
  const firstAbortedIndex = outcomes.length - count;

  return outcomes.map((outcome, index) =>
    index >= firstAbortedIndex ? MARK_ABORTED : outcome,
  );
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
// Returns one outcome per record in input order. A timeout or a systemic failure
// (auth/rate-limit/5xx) stops the run at that chunk rather than firing a burst
// that's already doomed. A request-shape 4xx (a 400/422) stops the run only once
// a SECOND chunk is rejected with the SAME error message and nothing has synced
// yet: the CLI builds every chunk's payload identically, so two chunks failing
// the same categorical way is strong evidence the envelope shape itself is wrong.
// A lone rejection, two rejections with DIFFERENT messages (which look like two
// isolated per-record problems, not one envelope fault), or any rejection after a
// success (a success proves the shape valid) all keep the run going rather than
// strand syncable records behind an unconfirmed abort. On any stop the trailing
// records get no outcome and stay `pending` (their outcome index is `undefined`,
// which the caller reads as not-synced). A plain per-chunk failure doesn't abort —
// a later chunk may still succeed. `stoppedBy` names the distinctly-reported stop
// reason (`MARK_TIMED_OUT` or `MARK_ABORTED`) or is null when the run finished or
// stopped on a systemic failure, so the caller can word its report accordingly.
export const markRecordsSynced = async (
  items: MarkSyncedItem[],
  syncedAt: string = new Date().toISOString(),
): Promise<MarkSyncedResult> => {
  const outcomes: MarkSyncedOutcome[] = [];
  let anySynced = false;
  let lastRequestShapeMessage: string | null = null;

  for (
    let start = 0;
    start < items.length;
    start += MAX_MARK_SYNCED_BATCH_SIZE
  ) {
    const chunk = items.slice(start, start + MAX_MARK_SYNCED_BATCH_SIZE);
    const {
      outcomes: chunkOutcomes,
      stop,
      message,
    } = await markSyncedChunk(chunk, syncedAt);

    outcomes.push(...chunkOutcomes);
    anySynced = anySynced || chunkOutcomes.includes(MARK_SYNCED);

    if (stop === STOP_TIMEOUT) {
      return { outcomes, stoppedBy: MARK_TIMED_OUT };
    }

    if (stop === STOP_SYSTEMIC) {
      return { outcomes, stoppedBy: null };
    }

    if (stop !== STOP_REQUEST_SHAPE) {
      // Reset so the match below stays CONSECUTIVE: a clean or plain-failure
      // chunk between two identical rejections breaks the "envelope is wrong"
      // evidence, so it must not count toward the two-in-a-row abort.
      lastRequestShapeMessage = null;
      continue;
    }

    // Abort only once a SECOND consecutive request-shape rejection carries the
    // SAME message, and only while nothing has synced — matching messages across
    // two independently-built chunks is what marks the failure as envelope-level
    // (categorical) rather than two isolated per-record rejections, and a success
    // would have proven the shape valid. Re-tag this stopping chunk's records
    // `MARK_ABORTED` (they were `MARK_FAILED` until now) so the outcome reflects
    // that the run stopped here, while the earlier chunks it ran past stay
    // `MARK_FAILED`.
    if (!anySynced && message !== null && message === lastRequestShapeMessage) {
      return {
        outcomes: withAbortedTail(outcomes, chunkOutcomes.length),
        stoppedBy: MARK_ABORTED,
      };
    }

    lastRequestShapeMessage = message;
  }

  return { outcomes, stoppedBy: null };
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
