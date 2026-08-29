import chalk from 'chalk';
import { createRecord } from '@/libs/records.js';
import {
  ApiRequestError,
  describeSystemicFailure,
  isSystemicApiFailure,
  rethrowIfTimeout,
} from '@/libs/api.js';
import { readMarkdown } from '@/libs/markdown.js';
import { resolveMarkdownInputs } from '@/libs/files.js';
import { checkConfig } from '@/libs/config.js';
import { failWithUsage } from '@/libs/usage.js';
import { sanitizeForTerminal } from '@/libs/terminal.js';

export const USAGE = `Usage: markpost push [--dry-run] <path...>

  path       One or more markdown files, directories (recursed for .md files),
             or glob patterns to create records from
  --dry-run  Preview the resolved files (and any missing/unreadable inputs)
             without creating any records`;

// Preview flag: resolve the inputs and print the exact push plan without
// creating any server records. Named so the parse check and usage text share
// the one literal, mirroring sync's --dry-run.
const DRY_RUN_FLAG = '--dry-run';

// A leading `--` marks a long flag, not a path — used to reject a stray or
// mistyped long flag before it's mistaken for a file to push. A genuine
// dash-leading filename is still pushable after the OPTIONS_END separator below.
const FLAG_PREFIX = '--';

// POSIX end-of-options separator: everything after the first bare `--` is a
// literal path, even if it starts with dashes — the standard escape hatch for a
// file whose name would otherwise look like a flag (e.g. `push -- --notes.md`).
const OPTIONS_END = '--';

// `systemicError` is set only when this file failed for a reason that will
// recur for every other file (auth/5xx). Carrying it on the result rather than
// throwing lets `pushFiles` decide to abort with a flat check instead of a
// try/catch hop.
interface PushResult {
  filePath: string;
  pushed: boolean;
  systemicError?: ApiRequestError;
}

// Set only when a systemic failure stopped the run early. `unattempted` counts
// the files never sent because of it, so the summary can report them honestly.
interface PushAbort {
  reason: string;
  filePath: string;
  unattempted: number;
}

// Outcome of a whole batch. `abort` is null on a run that finished (even one
// with per-file failures); `total` is the resolved file count so the summary
// stays honest even when the run stopped short.
interface PushRun {
  results: PushResult[];
  abort: PushAbort | null;
  total: number;
}

const toMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

const pushFile = async (filePath: string): Promise<PushResult> => {
  try {
    const { title, content } = readMarkdown(filePath);
    const record = await createRecord(title, content);

    if (!record) {
      console.error(
        chalk.redBright(sanitizeForTerminal(`Failed to push "${filePath}".`)),
      );
      return { filePath, pushed: false };
    }

    // record.title/uuid come from the API response (untrusted, see terminal.ts),
    // and filePath can be a directory-walk name the user never typed — sanitize
    // every push output line so a crafted title or filename can't inject a live
    // escape into the terminal.
    console.log(
      chalk.greenBright(
        sanitizeForTerminal(`Pushed "${record.title}" (${record.uuid})`),
      ),
    );
    return { filePath, pushed: true };
  } catch (error) {
    // A timeout must abort the whole batch, not be logged per-file and
    // retried on the next one: 50 stalled files would otherwise burn
    // 50 × the timeout before reporting. `runPushCommand`'s catch reports it
    // with a non-zero exit.
    rethrowIfTimeout(error);

    // A systemic failure (auth/5xx/429) isn't this file's fault and will recur
    // for every other file, so hand it back for the batch to abort on rather
    // than logging it as a per-file failure and pressing on.
    if (isSystemicApiFailure(error)) {
      return { filePath, pushed: false, systemicError: error };
    }

    console.error(
      chalk.redBright(
        sanitizeForTerminal(
          `Failed to push "${filePath}": ${toMessage(error)}`,
        ),
      ),
    );
    return { filePath, pushed: false };
  }
};

// Push each file in turn rather than in parallel: a bulk import can be large
// and sequential requests keep the output ordered and the server unhammered.
// A systemic failure stops the run immediately — the remaining files would all
// hit the same wall, so firing those requests only wastes time and hammers a
// server that's already failing (or rejecting an expired token).
const pushFiles = async (filePaths: string[]): Promise<PushRun> => {
  const results: PushResult[] = [];
  const total = filePaths.length;

  for (const [index, filePath] of filePaths.entries()) {
    const result = await pushFile(filePath);
    results.push(result);

    if (result.systemicError) {
      const abort: PushAbort = {
        reason: describeSystemicFailure(result.systemicError),
        filePath,
        unattempted: total - (index + 1),
      };
      return { results, abort, total };
    }
  }

  return { results, abort: null, total };
};

const abortLine = (abort: PushAbort): string => {
  const head = `Aborted on "${abort.filePath}": ${abort.reason}.`;

  if (abort.unattempted === 0) {
    return head;
  }

  return `${head} ${abort.unattempted} file(s) not attempted.`;
};

// The push dry run mirrors sync's --dry-run output style (a yellow preview
// header over a dim "would" list) and, like reportSummary, owns the failure
// exit code the real run would set for unresolved inputs — so a script
// previewing a wrong glob still learns it matched nothing. It can't reuse sync's
// reportDryRunPlan: that previews server records written to local files, whereas
// push previews local files sent to the server — disjoint inputs, so only the
// visual style is shared. Paths are sanitized like sync's printWritePreview: a
// directory/glob walk can surface a filename the user never typed and doesn't
// control (a synced folder, a cloned repo), so an escape sequence in a name
// can't reach the terminal live.
const reportPushDryRun = (
  filePaths: string[],
  unresolvedCount: number,
): void => {
  console.log(
    chalk.yellow(
      `Dry run — previewing ${filePaths.length} file(s); nothing will be pushed.`,
    ),
  );
  console.log(chalk.dim(`Would push ${filePaths.length} file(s):`));
  filePaths.forEach((filePath) => {
    console.log(chalk.dim(sanitizeForTerminal(`  -> ${filePath}`)));
  });

  // A wrong glob (missing/unreadable inputs) is exactly what --dry-run exists to
  // catch, so it exits non-zero like the real run would — minus the per-file
  // push failures a dry run can't produce.
  if (unresolvedCount === 0) {
    return;
  }

  process.exitCode = 1;
};

const reportSummary = (run: PushRun, unresolvedCount: number): void => {
  const { results, abort, total } = run;
  const succeeded = results.filter((result) => result.pushed).length;
  const failed = results.length - succeeded;

  console.log(chalk.dim(`Pushed ${succeeded}/${total} file(s) successfully.`));

  if (abort) {
    // abort.filePath and abort.reason (a server-classified failure) are both
    // untrusted, so sanitize the composed line like the per-file output above.
    console.error(chalk.redBright(sanitizeForTerminal(abortLine(abort))));
  }

  // `abort` always leaves a `pushed: false` result behind, so `failed` already
  // covers it; it's named here too to make the abort-forces-failure intent
  // explicit rather than incidental.
  if (failed > 0 || unresolvedCount > 0 || abort) {
    process.exitCode = 1;
  }
};

export const runPushCommand = async (args: string[]): Promise<void> => {
  try {
    const dryRun = args.includes(DRY_RUN_FLAG);

    // Split on the first `--`: args before it are flag-checked, args after it
    // are literal paths (so a dash-leading filename stays pushable). The
    // separator itself belongs to neither slice.
    const separatorIndex = args.indexOf(OPTIONS_END);
    const optionArgs =
      separatorIndex === -1 ? args : args.slice(0, separatorIndex);
    const literalPaths =
      separatorIndex === -1 ? [] : args.slice(separatorIndex + 1);

    // Reject a stray or mistyped flag (`--dryrun`, `--dry-run=1`) rather than
    // letting it fall through as a bogus path: push creates server records, so a
    // fat-fingered --dry-run must fail loud, never silently run the real push
    // when the user asked for a preview — the guard sync gives its one
    // destructive command.
    const unexpectedFlags = optionArgs.filter(
      (arg) => arg.startsWith(FLAG_PREFIX) && arg !== DRY_RUN_FLAG,
    );

    if (unexpectedFlags.length > 0) {
      failWithUsage(
        `Unexpected arguments: ${unexpectedFlags.join(' ')}`,
        USAGE,
      );
      return;
    }

    const paths = [
      ...optionArgs.filter((arg) => arg.length > 0 && arg !== DRY_RUN_FLAG),
      ...literalPaths.filter((arg) => arg.length > 0),
    ];

    if (paths.length === 0) {
      failWithUsage('No path given.', USAGE);
      return;
    }

    // A dry run makes no network calls, so it doesn't need a configured token or
    // output directory — let a user confirm which files a glob matches before
    // setting up auth. The real push still requires config.
    if (!dryRun && !(await checkConfig())) {
      return;
    }

    const { files, missing, skipped } = resolveMarkdownInputs(paths);

    // Sanitize both unresolved-input lines: a `skipped` path is discovered by
    // walking a directory (resolveMarkdownInputs), so it can carry a filename
    // the user never typed and doesn't control — an escape sequence in that name
    // must not reach the terminal live. `missing` echoes a user-typed glob (lower
    // risk), but keeping both branches identical stops a reader having to work
    // out which one is trusted.
    for (const input of missing) {
      console.error(
        chalk.redBright(
          sanitizeForTerminal(`No markdown files found for "${input}".`),
        ),
      );
    }

    for (const path of skipped) {
      console.error(
        chalk.redBright(
          sanitizeForTerminal(`Skipped unreadable path "${path}".`),
        ),
      );
    }

    if (files.length === 0) {
      console.error(chalk.redBright('No markdown files to push.'));
      process.exitCode = 1;
      return;
    }

    const unresolvedCount = missing.length + skipped.length;

    // A dry run stops before any createRecord call: report the resolved plan
    // (which sets its own failure exit code for unresolved inputs) and return.
    if (dryRun) {
      reportPushDryRun(files, unresolvedCount);
      return;
    }

    const run = await pushFiles(files);
    reportSummary(run, unresolvedCount);
  } catch (error) {
    console.error(chalk.redBright(toMessage(error)));
    process.exitCode = 1;
  }
};
