import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';

import {
  authedRequestWithHeaders,
  isSystemicApiFailure,
  logApiFailure,
} from '@/libs/api.js';
import { logErrorMessage } from '@/libs/errors.js';
import { expandHomeDirectory } from '@/libs/paths.js';
import { RecordExportRow } from '@/types/records.types.js';

// Mirrors markpost's shared/utils/export.ts `EXPORT_TRUNCATED_HEADER` — the
// header markpost's export endpoints set to signal the result was capped at
// their row limit. Copied by hand, like `RecordExportRow`: it's a `shared/`
// constant, not part of the vendored `server/types/api.types.ts` contract.
export const EXPORT_TRUNCATED_HEADER = 'X-Export-Truncated';
const EXPORT_TRUNCATED_HEADER_TRUE = 'true';

// markpost sets this header unconditionally on every response (verified
// against server/api/records/export.get.ts: `setHeader(event,
// EXPORT_TRUNCATED_HEADER, String(exportPayload.isTruncated))`, not only when
// truncated), so an absent header only happens off-contract (e.g. a proxy
// stripped it). Fail closed in that case anyway, like markpost's own
// client-side download helper (app/utils/exportDownload.ts
// `isTruncatedResponse`). Casing is normalized so a header-rewriting proxy
// can't defeat the check.
const isExportTruncated = (headers: Headers): boolean => {
  const header = headers.get(EXPORT_TRUNCATED_HEADER);

  if (header === null) {
    return true;
  }

  return header.toLowerCase() === EXPORT_TRUNCATED_HEADER_TRUE;
};

export type RecordExportResult =
  | {
      ok: true;
      rows: RecordExportRow[];
      truncated: boolean;
      // Count of rows the server returned that failed the shape check below
      // and were dropped. Surfaced (not just logged) so the caller can warn
      // and exit non-zero — a written backup silently missing rows must not
      // report the same clean success as a complete one.
      skippedCount: number;
    }
  | { ok: false };

// A row missing one of these still passes `typeof === 'object'`, so each is
// checked individually rather than trusting a bare `Array.isArray` + cast.
const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

// Guards a single export row before it's trusted as a `RecordExportRow`,
// covering every field the CLI reads or persists (not just `uuid`) — a row
// missing `content`, for example, would otherwise still get written into the
// backup file and reported as a clean success.
const isRecordExportRow = (value: unknown): value is RecordExportRow => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.uuid === 'string' &&
    typeof candidate.title === 'string' &&
    typeof candidate.status === 'string' &&
    typeof candidate.createdAt === 'string' &&
    typeof candidate.content === 'string' &&
    isNullableString(candidate.source) &&
    isNullableString(candidate.sourceId) &&
    isNullableString(candidate.filePath) &&
    isNullableString(candidate.syncedAt) &&
    isNullableString(candidate.errorMessage)
  );
};

// Fetches every record in the account (all statuses) via markpost's dedicated
// backup endpoint (GET /api/records/export). Unlike `records list` and the
// sync — which only ever return pending or paginated/filtered records — this
// is a full-account dump, capped at markpost's export row limit and flagged
// via `EXPORT_TRUNCATED_HEADER` when it hits that cap. The response body is
// the bare row array with no JSON:API envelope (see
// server/api/records/export.get.ts), so it's read directly rather than
// through `unwrapResourceCollection`.
//
// `json` suppresses every plain-text diagnostic below (the malformed-row skip
// count and both `logApiFailure` calls) — mirroring `fetchPaginatedRecords`'s
// own `json` parameter in records.ts: under `--json`, stderr must carry only
// the unified `{ error, message }`/`partial_read` object the command layer
// writes once the read settles (see the JSON failure contract in the
// README), not this function's own prose line ahead of it. A systemic
// failure still throws unconditionally either way — that path is handled by
// the command's outer catch, which already respects `--json`.
export const fetchRecordExport = async (
  json = false,
): Promise<RecordExportResult> => {
  try {
    const { body, headers } = await authedRequestWithHeaders(
      '/api/records/export',
    );

    if (!Array.isArray(body)) {
      if (!json) {
        logApiFailure(
          'fetchRecordExport',
          new Error(
            'Unexpected response shape: expected an array of export rows.',
          ),
        );
      }

      return { ok: false };
    }

    const validRows = body.filter(isRecordExportRow);
    const skippedCount = body.length - validRows.length;

    if (skippedCount > 0 && !json) {
      logErrorMessage(
        'fetchRecordExport',
        `Skipped ${skippedCount} malformed export row(s)`,
      );
    }

    return {
      ok: true,
      rows: validRows,
      truncated: isExportTruncated(headers),
      skippedCount,
    };
  } catch (error) {
    // Auth (401/403) and 5xx failures doom the whole export, not just this
    // request, so surface them to the caller to fail-fast rather than
    // reporting the generic "Failed to fetch the export" a null return
    // produces — mirroring fetchRecord/fetchAllRecords.
    if (isSystemicApiFailure(error)) {
      throw error;
    }

    if (!json) {
      logApiFailure('fetchRecordExport', error);
    }

    return { ok: false };
  }
};

// A full-account export holds every record's private title/content — as
// sensitive as the API token itself — so the file is owner-readable only,
// matching config.ts's `configFileMode: 0o600`.
const EXPORT_FILE_MODE = 0o600;

export class ExportFileExistsError extends Error {
  constructor(path: string) {
    super(`"${path}" already exists. Pass --force to overwrite it.`);
    this.name = 'ExportFileExistsError';
  }
}

// Resolves a user-supplied `--out` path (which may start with `~`/`$HOME`,
// same as a configured output directory — see paths.ts) against the real
// home directory, creates its parent directory if needed, and writes the
// export as indented JSON. Isolated here (rather than inline in the command)
// so the filesystem write — an external service — can be stubbed in tests
// the way markdown.ts's writers are.
//
// Refuses to clobber an existing file unless `force` is set (mirroring
// `sources delete`'s confirm-or---yes convention for a destructive default).
// Writes to a sibling temp file and `renameSync`s it into place rather than
// writing the target directly: a same-directory rename is atomic on POSIX, so
// a mid-write failure (ENOSPC, a killed process) can't leave a truncated
// backup where a good one used to be, and — since `mode` applies only when a
// file is created — the new inode always gets `EXPORT_FILE_MODE`, even when
// `force` is overwriting a file some other process left world-readable.
export const writeExportFile = (
  outputPath: string,
  rows: RecordExportRow[],
  force = false,
): string => {
  const resolvedPath = expandHomeDirectory(outputPath, homedir);
  const parentDirectory = dirname(resolvedPath);

  mkdirSync(parentDirectory, { recursive: true });

  if (!force && existsSync(resolvedPath)) {
    throw new ExportFileExistsError(resolvedPath);
  }

  const temporaryPath = `${resolvedPath}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, JSON.stringify(rows, null, 2), {
    mode: EXPORT_FILE_MODE,
  });
  renameSync(temporaryPath, resolvedPath);

  return resolvedPath;
};
