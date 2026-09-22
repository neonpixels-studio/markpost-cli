import chalk from 'chalk';
import { JSON_ERROR_FETCH_FAILED, printJsonError } from '@/libs/output.js';

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
// nominally succeeded. Shared by `records list` and `events list` (the CLI's
// two paginated read commands) so the wording and the `--json`/plain-text
// branching can't drift between them. In `--json` mode the warning is the
// same `{ error, message }` shape as every other `--json` failure — no
// separate JSON-error shape invented for this case — so a script parsing
// stderr never has to special-case a partial read.
const PARTIAL_READ_MESSAGE =
  'A later page failed to fetch — this list may be incomplete.';

export const warnPartialRead = (json: boolean): void => {
  process.exitCode = 1;

  if (json) {
    printJsonError(JSON_ERROR_FETCH_FAILED, PARTIAL_READ_MESSAGE);
    return;
  }

  console.error(chalk.yellow(`Warning: ${PARTIAL_READ_MESSAGE}`));
};
