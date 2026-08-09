import {
  apiFetch,
  assertApiSuccess,
  authedRequest,
  getApiToken,
  getBaseUrl,
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
const PENDING_STATUS = 'pending';
const SYNCED_STATUS = 'synced';

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
export type FetchAllRecordsResult =
  { ok: true; records: Record[]; partial: boolean } | { ok: false };

export const fetchAllRecords = async (): Promise<FetchAllRecordsResult> => {
  const initial = await fetchPaginatedRecords();

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
    const subsequent = await fetchPaginatedRecords(after);

    if (!subsequent) {
      // A later page failed (`fetchPaginatedRecords` already logged why). Stop,
      // but mark the read incomplete so the caller doesn't present a truncated
      // set as the whole.
      partial = true;
      break;
    }

    records.push(subsequent.records);
    after = nextCursorFrom(subsequent);
  }

  return { ok: true, records: records.flat(1) as Record[], partial };
};

// Always scope the fetch to pending records. markpost's GET /api/records
// supports `filter[status]` (server/api/records/index.get.ts); without it the
// server returns synced + pending + error every run, so records already
// written to disk get re-fetched and re-written as endless `-2`/`-3`
// duplicates under the suffix strategy. Filtering to pending is what lets the
// mark-synced step (below) actually close the loop.
const buildRecordsQuery = (size: number, after?: string): string => {
  const params = [`page[size]=${size}`];

  if (after) {
    params.push(`page[after]=${encodeURIComponent(after)}`);
  }

  params.push(`filter[status]=${PENDING_STATUS}`);

  return params.join('&');
};

export const fetchPaginatedRecords = async (
  after?: string,
  size: number = 100,
): Promise<{
  records: Record[];
  meta: PaginatedRecordsMeta;
  links: ApiPaginationLinks;
} | null> => {
  try {
    const body = (await authedRequest(
      `/api/records?${buildRecordsQuery(size, after)}`,
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
// Goes through `apiFetch` so the PATCH inherits the same request timeout as
// every other API call (a stalled connection can't hang the sync forever).
// Unlike the fetch helpers above, a failure here is logged and reported as
// `false` rather than re-thrown — including a timeout: this is non-critical
// post-write bookkeeping (the file is already on disk), so a failed mark
// simply leaves the record `pending` to re-sync next run, which is far less
// disruptive than aborting the whole sync after files have landed. The
// timeout's job here is purely to bound the wait, not to fail loud.
//
// Returns a plain success boolean rather than the updated record: the caller
// only needs to know whether the server accepted the change. Reading it back
// as a resource would mis-report a legitimate 2xx that carries no `data`
// (markpost's PATCH always returns the record, but a `data: null` shape still
// counts as success here) as a failure, wrongly warning the user of
// duplicates. `filePath` is sent deliberately — markpost stores it on the
// record so its UI can show where a synced note landed; it's the user's own
// local path going to their own account, not a third-party leak.
export const markRecordSynced = async (
  uuid: string,
  filePath: string,
  syncedAt: string = new Date().toISOString(),
): Promise<boolean> => {
  try {
    const { response, body } = await apiFetch(
      `${getBaseUrl()}/api/records/${encodeURIComponent(uuid)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/vnd.api+json',
          Authorization: `Bearer ${getApiToken()}`,
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
      },
    );

    // Assert exactly like the other request helpers: an error response (or an
    // unparseable body surfacing from `apiFetch` as a thrown error) is caught
    // below as a failure, rather than being mistaken for a silent success that
    // leaves the record pending.
    assertApiSuccess(response, body as RecordApiResponse);

    return true;
  } catch (error) {
    logErrorMessage(
      `markRecordSynced["${uuid}"]`,
      error instanceof Error ? error.message : String(error),
    );

    return false;
  }
};

export const fetchRecord = async (uuid: string): Promise<Record | null> => {
  try {
    const body = (await authedRequest(
      `/api/records/${encodeURIComponent(uuid)}`,
    )) as RecordApiResponse;

    return unwrapResourceAttributes(body);
  } catch (error) {
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
    logApiFailure(`deleteRecords["${uuids.join(', ')}"]`, error);

    return null;
  }
};
