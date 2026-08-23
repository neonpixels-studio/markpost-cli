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

export const USAGE = `Usage: markpost push <path...>

  path  One or more markdown files, directories (recursed for .md files),
        or glob patterns to create records from`;

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
      console.error(chalk.redBright(`Failed to push "${filePath}".`));
      return { filePath, pushed: false };
    }

    console.log(chalk.greenBright(`Pushed "${record.title}" (${record.uuid})`));
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
      chalk.redBright(`Failed to push "${filePath}": ${toMessage(error)}`),
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

const reportSummary = (run: PushRun, unresolvedCount: number): void => {
  const { results, abort, total } = run;
  const succeeded = results.filter((result) => result.pushed).length;
  const failed = results.length - succeeded;

  console.log(chalk.dim(`Pushed ${succeeded}/${total} file(s) successfully.`));

  if (abort) {
    console.error(chalk.redBright(abortLine(abort)));
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
    const paths = args.filter((arg) => arg.length > 0);

    if (paths.length === 0) {
      failWithUsage('No path given.', USAGE);
      return;
    }

    if (!(await checkConfig())) {
      return;
    }

    const { files, missing, skipped } = resolveMarkdownInputs(paths);

    for (const input of missing) {
      console.error(chalk.redBright(`No markdown files found for "${input}".`));
    }

    for (const path of skipped) {
      console.error(chalk.redBright(`Skipped unreadable path "${path}".`));
    }

    if (files.length === 0) {
      console.error(chalk.redBright('No markdown files to push.'));
      process.exitCode = 1;
      return;
    }

    const run = await pushFiles(files);
    reportSummary(run, missing.length + skipped.length);
  } catch (error) {
    console.error(chalk.redBright(toMessage(error)));
    process.exitCode = 1;
  }
};
