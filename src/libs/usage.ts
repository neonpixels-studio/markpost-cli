import chalk from 'chalk';
import { JSON_ERROR_USAGE, printJsonError } from '@/libs/output.js';

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
