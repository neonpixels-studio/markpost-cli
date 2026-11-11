import chalk from 'chalk';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { writeExportFile } from '#src/libs/export.js';
import { warnPartialRead } from '#src/libs/errors.js';
import { hasJsonFlag } from '#src/libs/output.js';
import { sanitizeForTerminal } from '#src/libs/terminal.js';

// Argument parsing and result reporting shared by `export` (records) and
// `events export`: both endpoints share one contract (bare row array, row
// cap, truncation header), so the flags and incomplete-export handling are
// identical. `commandName` and `noun` only vary the wording.

// `parseArgs` handles both `--out path` and `--out=path`, and throws on an
// unknown flag or a missing value, which the command's usage catch surfaces
// to the user as a `usage` error, not `fetch_failed`. `--out` and `--json`
// are mutually exclusive: one writes a file, the other is a stdout data
// channel, and combining them would leave the caller guessing which one
// actually happened.
// `extraOptions` lets a command declare flags of its own (e.g. `events
// export --kind`); their raw parsed values come back as `extraValues`.
export const parseExportArgs = (
  args: string[],
  commandName: string,
  extraOptions: ParseArgsOptionsConfig = {},
): {
  outputPath: string | undefined;
  force: boolean;
  extraValues: Record<
    string,
    string | boolean | (string | boolean)[] | undefined
  >;
} => {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      force: { type: 'boolean' },
      json: { type: 'boolean' },
      ...extraOptions,
    },
  });

  if (positionals.length > 0) {
    throw new Error(
      `Unexpected argument "${positionals[0]}". \`${commandName}\` takes no positional arguments.`,
    );
  }

  // The `--out=--json` form is Node's documented escape hatch for a
  // dash-prefixed value (the space-separated `--out --json` is already
  // rejected by `parseArgs` itself as an ambiguous option value), so without
  // this check it would silently write a file literally named "--json".
  if (values.out !== undefined && values.out.startsWith('--')) {
    throw new Error(
      `--out was not given a path — got the flag "${values.out}" instead.`,
    );
  }

  // Read `--json` from argv directly (`hasJsonFlag`) rather than
  // `values.json`: in the `--out --json` case above, `parseArgs` throws
  // before `values.json` is ever set, so relying on it here would miss that
  // combination.
  if (values.out !== undefined && hasJsonFlag(args)) {
    throw new Error('Cannot combine --out and --json.');
  }

  if (values.out !== undefined && values.out.trim().length === 0) {
    throw new Error('--out needs a non-empty path.');
  }

  if (values.out === undefined && values.force) {
    throw new Error('--force has no effect without --out.');
  }

  return {
    outputPath: values.out?.trim(),
    force: Boolean(values.force),
    extraValues: values,
  };
};

// A capped export and a batch of malformed rows are independent reasons the
// export can be incomplete, so each gets its own complete sentence here; the
// caller below joins whichever sentences apply with a plain space — no
// capitalization/punctuation surgery on the combined string, so a sentence
// starting with a digit or quote can't break it.
const describeIncompleteExport = (
  truncated: boolean,
  skippedCount: number,
): string[] => {
  const reasons: string[] = [];

  if (truncated) {
    reasons.push(
      'The export was truncated at the server-side row limit — only the most recent rows were included.',
    );
  }

  if (skippedCount > 0) {
    reasons.push(
      `The server returned ${skippedCount} malformed row(s), which were skipped.`,
    );
  }

  return reasons;
};

// Joins every applicable reason into one sentence and reports it with a
// single call to `warnPartialRead` in libs/errors.ts — the same reporter
// records.ts/events.ts use for their own partial-read warning — rather than
// one call per reason or a local reimplementation of the `--json`/plain-text
// branching. One call keeps `warnPartialRead`'s "wording and branching can't
// drift between commands" guarantee (see its doc comment) intact, and keeps a
// `--json` consumer's parse simple: exactly one JSON object on stderr,
// matching every other `--json` failure's "one object" contract (see README
// "JSON failure contract"), even when both reasons apply.
export const reportIncompleteExport = (
  truncated: boolean,
  skippedCount: number,
  json: boolean,
): void => {
  const reasons = describeIncompleteExport(truncated, skippedCount);

  if (reasons.length === 0) {
    return;
  }

  warnPartialRead(json, reasons.join(' '));
};

// Writes the already-fetched rows to disk and reports where they landed. A
// filesystem failure here (EACCES, EISDIR, a full disk) is NOT a fetch
// failure — the rows were already fetched successfully — so this composes an
// error naming both facts explicitly, rather than letting the generic
// `describeApiError` in the command's outer catch describe a write error in
// fetch terms and leave the caller thinking nothing was retrieved.
export const writeToOutputFile = (
  outputPath: string,
  rows: readonly unknown[],
  force: boolean,
  skippedCount: number,
  noun: string,
): void => {
  let writtenPath: string;

  try {
    writtenPath = writeExportFile(outputPath, rows, force);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Fetched ${rows.length} ${noun}(s) but failed to write them to "${outputPath}": ${reason}`,
      { cause: error },
    );
  }

  const skippedSuffix =
    skippedCount > 0 ? ` (${skippedCount} malformed row(s) skipped)` : '';

  console.log(
    chalk.green(
      `Wrote ${rows.length} ${noun}(s) to ${sanitizeForTerminal(writtenPath)}.${skippedSuffix}`,
    ),
  );
};
