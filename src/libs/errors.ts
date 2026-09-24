import chalk from 'chalk';
import {
  JSON_ERROR_FETCH_FAILED,
  JSON_ERROR_PARTIAL_READ,
  printJsonError,
} from '@/libs/output.js';
import { sanitizeForTerminal } from '@/libs/terminal.js';

export const logErrorMessage = (title: string, message: string) => {
  return console.error(chalk.redBright(`${title}\n${message}`));
};

// Pulls a printable string off an unknown thrown value: an `Error`'s
// message, otherwise its `String()` form. Not API-specific, so it lives here
// rather than in libs/api.ts, and is shared by callers across both API
// failures and local validation throws (e.g. the `records`/`events` `list`
// commands' argument-parsing catch) so neither re-derives the extraction.
export const messageFromError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// A command-level failure (a failed fetch, a null/absent result, or an
// unclassified throw) reported honestly on stderr with a non-zero exit. In
// `--json` mode it emits the unified failure contract so a script parsing
// stderr sees the same `{ error, message }` shape the config and usage paths
// produce; otherwise it keeps the human chalk prose. Callers pass an
// already-sanitized message — a server-derived string can carry a terminal
// escape, and the JSON path re-escapes residual controls on top of that.
export const failWithMessage = (message: string, json = false): void => {
  process.exitCode = 1;

  if (json) {
    printJsonError(JSON_ERROR_FETCH_FAILED, message);
    return;
  }

  console.error(chalk.redBright(message));
};

// A partial (truncated) read — a later page failed mid-pagination but the
// pages already collected are still usable — reported honestly: warn and set
// a non-zero exit so a script/cron job notices even though the request
// nominally succeeded. Shared by `records list`, `events list` (the CLI's two
// paginated read commands), and `export` (whose result can be incomplete via
// a server-side row cap and/or skipped malformed rows) so the wording and the
// `--json`/plain-text branching can't drift between them. `message` defaults
// to the paginated-read case; `export` overrides it to describe its own
// reason(s). In `--json` mode the warning reuses the same `{ error, message }`
// shape as every other `--json` failure — no separate JSON-error shape
// invented for this case — but under its own `partial_read` code (not
// `fetch_failed`): unlike every other `--json` failure, stdout still carries
// valid (if truncated) data here, and a script needs to tell that apart from
// a request that returned nothing at all. The plain-text path sanitizes
// `message` (mirroring `failWithMessage`'s callers) since, unlike the default
// constant, an override is caller-built text that isn't guaranteed
// terminal-safe.
const PARTIAL_READ_MESSAGE =
  'A later page failed to fetch — this list may be incomplete.';

export const warnPartialRead = (
  json: boolean,
  message: string = PARTIAL_READ_MESSAGE,
): void => {
  process.exitCode = 1;

  if (json) {
    printJsonError(JSON_ERROR_PARTIAL_READ, message);
    return;
  }

  console.error(chalk.yellow(`Warning: ${sanitizeForTerminal(message)}`));
};
