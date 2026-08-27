import {
  ApiTimeoutError,
  authedRequest,
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

// Result of marking one record synced. `MARK_SYNCED` — the server accepted the
// PATCH. `MARK_FAILED` — a non-timeout, non-permanent error (a lone 404 or bad
// body, but also a transient systemic 429/5xx that may be a one-off blip); the
// record stays pending and the rest of the batch still runs, since the next
// record may succeed. `MARK_TIMED_OUT` — the PATCH hit the request timeout, a
// signal the server is hung; the batch runner stops on the first one rather than
// paying the full timeout on every remaining record. `MARK_PERMANENTLY_FAILED` —
// a permanent systemic failure (a dead token or a forbidden account: 401/403)
// that will recur on every record and every pass, so the batch runner stops on
// it AND the caller shuts the autoSync daemon down rather than looping into the
// same failure forever — mirroring how the delete path stops the daemon only on
// a permanent delete failure (see runDefaultSync). A transient systemic failure
// deliberately stays `MARK_FAILED`: unlike a permanent one it isn't guaranteed to
// doom every other record (a lone 5xx can be a blip), so aborting the whole run
// would strand records that would have settled.
//
// Values are prefixed (`mark-*`) so they never collide with the wire
// `SYNCED_STATUS = 'synced'` above: these are internal outcome tags, not the
// status string sent to the server, and an accidental cross-comparison should
// not silently type-check as equal.
export const MARK_SYNCED = 'mark-synced';
export const MARK_FAILED = 'mark-failed';
export const MARK_TIMED_OUT = 'mark-timed-out';
export const MARK_PERMANENTLY_FAILED = 'mark-permanently-failed';

export type MarkSyncedOutcome =
  | typeof MARK_SYNCED
  | typeof MARK_FAILED
  | typeof MARK_TIMED_OUT
  | typeof MARK_PERMANENTLY_FAILED;

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

// Marks a single record synced after the CLI has written it to disk, via
// markpost's PATCH /api/records/[uuid] (server/api/records/[uuid].patch.ts),
// which accepts `status`, `syncedAt`, and `filePath`. This is the
// non-destructive counterpart to `deleteRecords`: with autoDelete off, moving
// the record out of `pending` is what stops the next run's pending-only fetch
// from re-writing it. `syncedAt` is injected (defaulting to now) so callers
// and tests can pin the timestamp. Content-Type mirrors createRecord/
// deleteRecords for consistency; markpost reads the body regardless.
//
// Goes through `authedRequest` so the PATCH inherits the same request timeout
// as every other API call (a stalled connection can't hang the sync forever).
// Unlike the fetch helpers above, a failure here is logged rather than
// re-thrown: this is non-critical post-write bookkeeping (the file is already
// on disk), so a failed mark simply leaves the record `pending` to re-sync
// next run, which is far less disruptive than aborting the whole sync after
// files have landed.
//
// Returns a discriminated outcome rather than a bare boolean so the caller can
// tell a per-record failure (`MARK_FAILED`, keep going — the next record may
// succeed) apart from a timeout (`MARK_TIMED_OUT`) and a permanent systemic
// failure (`MARK_PERMANENTLY_FAILED`). A timeout (hung server) stops the
// remaining batches to avoid paying the full timeout on each; a permanent
// failure (dead token / forbidden account) stops them because it will recur on
// every record — and additionally shuts the autoSync daemon down, since it can't
// clear on retry (matching the delete path). Both leave the affected records
// `pending`.
//
// Reading the body back as a resource would mis-report a legitimate 2xx
// that carries no `data` (markpost's PATCH always returns the record, but a
// `data: null` shape still counts as success here) as a failure, wrongly
// warning the user of duplicates. `filePath` is sent deliberately — markpost
// stores it on the record so its UI can show where a synced note landed; it's
// the user's own local path going to their own account, not a third-party leak.
export const markRecordSynced = async (
  uuid: string,
  filePath: string,
  syncedAt: string = new Date().toISOString(),
): Promise<MarkSyncedOutcome> => {
  try {
    // Route through the shared authedRequest seam (like createRecord/
    // fetchRecord): it attaches the bearer token and asserts success (throwing
    // on a non-2xx or an errors-carrying 2xx, and on an unparseable body such
    // as an HTML error page behind a 200), so a failure lands in the catch
    // below rather than being mistaken for a silent success that leaves the
    // record pending. We ignore the returned body — the caller only needs to
    // know the server accepted the change.
    await authedRequest(`/api/records/${encodeURIComponent(uuid)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/vnd.api+json',
      },
      body: JSON.stringify({
        data: {
          type: 'records',
          attributes: {
            status: SYNCED_STATUS,
            syncedAt,
            filePath,
          },
        },
      }),
    });

    return MARK_SYNCED;
  } catch (error) {
    logErrorMessage(
      `markRecordSynced["${uuid}"]`,
      error instanceof Error ? error.message : String(error),
    );

    // A timeout gets its own outcome so the caller can abort the remaining
    // marks on the first one.
    if (error instanceof ApiTimeoutError) {
      return MARK_TIMED_OUT;
    }

    // A permanent systemic failure (dead token / forbidden account: 401/403)
    // will recur on every subsequent record and every future pass, so the batch
    // runner stops on it and the caller shuts the autoSync daemon down instead
    // of re-PATCHing a server it already knows will reject.
    if (isPermanentApiFailure(error)) {
      return MARK_PERMANENTLY_FAILED;
    }

    // Every other error — a per-record 4xx or a transient systemic 5xx that may
    // be a one-off — leaves this record pending and lets the rest of the batch
    // proceed; aborting on a lone transient failure would strand records that
    // would have settled. The daemon stays alive to retry next pass.
    // @todo A sustained 429 (rate limit) would be better handled by aborting the
    // burst to back off (per the api.ts contract) while keeping the daemon alive;
    // out of scope for the permanent-failure fix — tracked as a follow-up.
    return MARK_FAILED;
  }
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
