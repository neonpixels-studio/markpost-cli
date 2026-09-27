import chalk from 'chalk';
import { messageFromError } from '@/libs/errors.js';
import { JSON_ERROR_USAGE, printJsonError } from '@/libs/output.js';
import { sanitizeForTerminal } from '@/libs/terminal.js';

// A missing or unknown subcommand (or required argument) is a usage error, not
// a no-op. Print the offending detail plus the command's usage to stderr and
// fail with exit 1 so a script or cron wrapper sees a failure instead of a
// silent "success". An explicit `--help`/`-h` is intercepted in index.ts's
// dispatch and never reaches a command, so anything that lands here is a
// genuine mistake worth failing on. In `--json` mode a `--json`-capable
// command routes the same detail through the unified failure serializer so a
// script parsing stderr sees the documented `{ error, message }` shape instead
// of chalk prose (the human-only usage block is dropped — it isn't parseable).
export const failWithUsage = (
  message: string,
  usage: string,
  json = false,
): void => {
  process.exitCode = 1;

  if (json) {
    printJsonError(JSON_ERROR_USAGE, message);
    return;
  }

  console.error(chalk.redBright(message));
  console.error(usage);
};

// Subcommand-dispatching groups (sources, records) share one shape for a bad
// subcommand: name the unknown token when given, or report the missing one,
// then fail with usage. Keeps the message wording in one place so the groups
// can't drift.
export const failWithSubcommandUsage = (
  subcommand: string | undefined,
  usage: string,
  json = false,
): void => {
  const message = subcommand
    ? `Unknown subcommand: ${subcommand}`
    : 'No subcommand given.';
  failWithUsage(message, usage, json);
};

// Shared by every "parse this command's (or subcommand's) own flags/
// positionals in a dedicated try/catch, before checkConfig and the fetch"
// call site (get.ts, export.ts, records.ts, events.ts, sources.ts,
// tokens.ts): a thrown parse error is a usage mistake, not a fetch failure,
// so it must report the `usage` JSON code (issue #208, and #218 for
// sources.ts/tokens.ts) rather than whatever the caller's own catch would
// otherwise miscode it as. Sanitizes the message — a thrown value can't be
// trusted not to carry a terminal escape, same as every API-error path.
export const failWithParseError = (
  error: unknown,
  usage: string,
  json = false,
): void => {
  failWithUsage(sanitizeForTerminal(messageFromError(error)), usage, json);
};

// Wraps the "parse, and treat a throw as a usage error" shape itself: every
// call site (sources.ts, tokens.ts's `list`/`create`/`revoke`) was writing the
// same `let parsed; try { parsed = parseX(args); } catch (error) {
// failWithParseError(...); return; }` block, one concern repeated past the
// rule-of-three line. `parse` is a thunk (not the parsed args directly) so the
// call, not just the catch, stays inside this function's own try. Returns
// `null` on failure (already reported) so the caller's guard clause reads as
// `if (!parsed) { return; }` rather than a second try/catch of its own.
export const parseOrFailWithUsage = <ParsedArgs>(
  parse: () => ParsedArgs,
  usage: string,
  json = false,
): ParsedArgs | null => {
  try {
    return parse();
  } catch (error) {
    failWithParseError(error, usage, json);
    return null;
  }
};
