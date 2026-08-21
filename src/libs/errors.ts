import chalk from 'chalk';
import { JSON_ERROR_FETCH_FAILED, printJsonError } from '@/libs/output.js';

export const logErrorMessage = (title: string, message: string) => {
  return console.error(chalk.redBright(`${title}\n${message}`));
};

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
