import {
  ApiTimeoutError,
  authedRequest,
  isFatalRequestError,
  isPermanentApiFailure,
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
// Whether an abort ALSO stops the autoSync daemon is a run-level decision, not a
// per-record tag: a permanent systemic failure (dead token / forbidden account:
// 401/403) recurs every pass, so the run reports `abortReason: 'permanent'` (see
// `MarkAbortReason`) and the caller shuts the daemon down. A transient systemic
// failure (429/5xx) still aborts the remaining chunks but keeps the daemon alive
// to retry next pass. Either way the affected records stay `MARK_FAILED`.
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

// Why a mark-synced run stopped early, or `null` if it ran every chunk. One
// discriminant (not adjacent booleans) so the reason can't be self-contradictory.
// `'timeout'` — a chunk hit the request timeout (hung server), retried next pass.
// `'permanent'` — a chunk hit a permanent systemic failure (dead token / forbidden
// account: 401/403) that recurs every pass, so the caller ALSO stops the autoSync
// daemon. `'transient'` — a chunk hit a transient systemic failure (429/5xx): the
// run stops early to back off (trailing chunks skipped) but the daemon stays alive
// to retry, and the caller can say the run stopped short. `'request-shape'` — two
// consecutive chunks were rejected with the SAME request-shape 4xx (400/422) and
// nothing had synced, so the payload envelope itself is wrong: the run aborts (its
// stopping chunk re-tagged `MARK_ABORTED`) but the daemon stays alive, since the
// next pass may build a valid request. `null` — the run completed every chunk (any
// failures were per-chunk, not systemic).
export type MarkAbortReason =
  'timeout' | 'permanent' | 'transient' | 'request-shape' | null;

// Outcome of a whole bulk mark-synced run. `outcomes` holds one entry per
// record in the ORIGINAL input order, so the caller can align each result back
// to its record by index. On an abort (a timeout, a systemic auth/rate-limit/
// 5xx failure, or a repeated request-shape 4xx) it's shorter than the input: the
// chunk that aborted and every chunk after it were never confirmed, so those
// trailing records have no outcome and the caller treats them as still pending.
// `abortReason` records why (if) the run stopped early — the caller words its
// report from it and, in particular, stops the daemon only on `'permanent'`.
export type MarkSyncedResult = {
  outcomes: MarkSyncedOutcome[];
  abortReason: MarkAbortReason;
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

// The result of PATCHing one chunk, from the chunk's OWN perspective: a per-item
// outcome list, why (if) the chunk failed in a way that bears on the run, and (for
// a `'request-shape'` failure only) the server's error message. `abortReason`
// carries WHY: `'timeout'` and `'permanent'` distinguish the hung-server and
// dead-token cases (the latter also stops the daemon), `'transient'` a systemic
// 429/5xx (aborts this run, daemon lives), and `'request-shape'` a 400/422 whose
// envelope looks wrong. `'timeout' | 'permanent' | 'transient'` each doom every
// remaining chunk, so `markRecordsSynced` aborts on them immediately; a lone
// `'request-shape'` does NOT — the run aborts only once a SECOND consecutive chunk
// is rejected with the SAME `message` (see `markRecordsSynced`), so `message` lets
// the caller compare a categorical envelope rejection (same message twice) against
// two isolated per-record rejections that only happen to both 4xx. `null` is the
// plain success/per-chunk-failure case that doesn't abort. `message` is null for
// every non-request-shape result.
type MarkSyncedChunkResult = {
  outcomes: MarkSyncedOutcome[];
  abortReason: MarkAbortReason;
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
// A timeout maps every item to `MARK_TIMED_OUT` and reports `abortReason:
// 'timeout'` (a hung server would burn the full request timeout on every
// remaining chunk). A PERMANENT systemic failure (dead token / forbidden account:
// 401/403) maps every item to `MARK_FAILED` and reports `'permanent'` so the
// caller aborts AND additionally stops the autoSync daemon, which can't clear it
// on retry (matching the delete path). A transient systemic failure (rate-limit/
// 5xx) reports `'transient'` — the caller aborts to back off rather than hammering
// a server that just rejected the burst (the same rule the fetch helpers apply via
// `isSystemicApiFailure`), but keeps the daemon alive. A request-shape 4xx (a
// malformed-payload 400 or a contract-validation 422) maps every item to
// `MARK_FAILED` and reports `'request-shape'` plus the server's error message: the
// chunk was attempted and rejected, so its records are a plain failure UNLESS the
// run actually aborts — `markRecordsSynced` aborts only on a SECOND consecutive
// same-message rejection and re-tags just the chunk it stops on to `MARK_ABORTED`,
// so a completed run never leaves a stray `MARK_ABORTED`. Any other (per-chunk)
// failure maps to `MARK_FAILED` with `abortReason: null` — a later chunk may still
// succeed. A 4xx delivered as an HTML error page (a WAF/proxy interstitial) throws
// unparseable before it can be classified, so it degrades to that plain failure
// rather than aborting on a misread status.
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
      abortReason: null,
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

    // A timeout gets its own outcome and aborts so the caller doesn't pay the
    // full request timeout on every remaining chunk.
    if (error instanceof ApiTimeoutError) {
      return {
        outcomes: items.map(() => MARK_TIMED_OUT),
        abortReason: 'timeout',
        message: null,
      };
    }

    // Every failed record in the chunk stays `MARK_FAILED` (pending, retried next
    // run); only the `abortReason` classification differs. A PERMANENT failure
    // (dead token / forbidden account: 401/403) reports `'permanent'` and also
    // stops the daemon. A transient systemic failure (rate-limit/5xx that may be a
    // blip) reports `'transient'` to back off — a sustained 429 stops after the
    // first chunk rather than firing the whole burst — but keeps the daemon alive.
    // A request-shape 4xx (400/422) reports `'request-shape'` plus the server's
    // message so the caller can abort only on a SECOND consecutive same-message
    // rejection. A plain per-chunk failure is `null` and doesn't abort, since a
    // later chunk may still succeed.
    const failedOutcomes: MarkSyncedOutcome[] = items.map(() => MARK_FAILED);

    if (isPermanentApiFailure(error)) {
      return {
        outcomes: failedOutcomes,
        abortReason: 'permanent',
        message: null,
      };
    }

    if (isSystemicApiFailure(error)) {
      return {
        outcomes: failedOutcomes,
        abortReason: 'transient',
        message: null,
      };
    }

    if (isFatalRequestError(error)) {
      return {
        outcomes: failedOutcomes,
        abortReason: 'request-shape',
        message: error.message,
      };
    }

    return { outcomes: failedOutcomes, abortReason: null, message: null };
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
// a later chunk may still succeed. `abortReason` carries why (if) the run stopped
// early — the caller words its report from it and stops the autoSync daemon only
// on `'permanent'` (see `MarkAbortReason`).
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
      abortReason,
      message,
    } = await markSyncedChunk(chunk, syncedAt);

    outcomes.push(...chunkOutcomes);
    anySynced = anySynced || chunkOutcomes.includes(MARK_SYNCED);

    // A timeout or a systemic failure (permanent or transient) dooms every
    // remaining chunk, so abort here and surface why, leaving the trailing chunks
    // unsent (their records get no outcome, read as pending). Only `'permanent'`
    // additionally stops the daemon; that decision lives in the caller.
    if (
      abortReason === 'timeout' ||
      abortReason === 'permanent' ||
      abortReason === 'transient'
    ) {
      return { outcomes, abortReason };
    }

    if (abortReason !== 'request-shape') {
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
        abortReason: 'request-shape',
      };
    }

    lastRequestShapeMessage = message;
  }

  return { outcomes, abortReason: null };
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
