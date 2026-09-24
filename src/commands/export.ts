import { parseArgs } from 'node:util';
import chalk from 'chalk';
import { fetchRecordExport, writeExportFile } from '@/libs/export.js';
import { describeApiError } from '@/libs/api.js';
import { checkConfig } from '@/libs/config.js';
import { failWithMessage } from '@/libs/errors.js';
import { sanitizeForTerminal } from '@/libs/terminal.js';
import {
  hasJsonFlag,
  JSON_ERROR_PARTIAL_READ,
  printJson,
  printJsonError,
} from '@/libs/output.js';
import { RecordExportRow } from '@/types/records.types.js';

export const USAGE = `Usage: markpost export [options]

  Export every record in your account (all statuses) as a full-account
  backup, via markpost's dedicated export endpoint — distinct from
  \`records list\` (paginated/filtered) and \`sync\`/\`push\` (pending records
  only). markpost caps the export at its row limit; a capped export (or one
  where the server returned a malformed row) still writes/prints the rows it
  did get, but warns and exits non-zero so a script can detect an incomplete
  backup via its exit code.

Options:
  --out <path>  Write the export as JSON to <path> instead of printing to
                stdout (creates parent directories as needed)
  --force       Overwrite <path> if it already exists (--out only; refused by
                default so a mistyped path can't destroy an existing file)
  --json        Print the export as a single JSON array instead of a
                per-record summary. Cannot be combined with --out.`;

export const runExportCommand = async (args: string[]): Promise<void> => {
  // Read `--json` straight from argv so every failure below is rendered in
  // whichever contract the caller asked for, even one thrown before parsing
  // (mirroring get/records/events).
  const json = hasJsonFlag(args);

  try {
    const { outputPath, force } = parseExportArgs(args);

    if (!(await checkConfig(json))) {
      return;
    }

    await runExport(outputPath, force, json);
  } catch (error) {
    // A systemic auth/5xx failure re-throws from fetchRecordExport; surface
    // its classified, actionable message with a non-zero exit rather than the
    // generic failure a null/ok:false return produces. Sanitize — the message
    // can be server-derived.
    failWithMessage(sanitizeForTerminal(describeApiError(error)), json);
  }
};

// `parseArgs` handles both `--out path` and `--out=path`, and throws on an
// unknown flag or a missing value, which the command's outer catch surfaces
// to the user. `--out` and `--json` are mutually exclusive: one writes a file,
// the other is a stdout data channel, and combining them would leave the
// caller guessing which one actually happened.
const parseExportArgs = (
  args: string[],
): { outputPath: string | undefined; force: boolean } => {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      force: { type: 'boolean' },
      json: { type: 'boolean' },
    },
  });

  if (positionals.length > 0) {
    throw new Error(
      `Unexpected argument "${positionals[0]}". \`export\` takes no positional arguments.`,
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

  return { outputPath: values.out?.trim(), force: Boolean(values.force) };
};

// Every field comes from the untrusted API response, so each is stripped of
// control/ANSI escapes before printing (see terminal.ts) — mirroring
// records.ts's printRecord.
const printExportRow = (row: RecordExportRow): void => {
  console.log(chalk.bold(sanitizeForTerminal(row.title)));
  console.log(`  uuid:       ${sanitizeForTerminal(row.uuid)}`);
  console.log(`  created at: ${sanitizeForTerminal(row.createdAt)}`);
  console.log(`  status:     ${sanitizeForTerminal(row.status)}`);

  if (row.source) {
    console.log(`  source:     ${sanitizeForTerminal(row.source)}`);
  }

  if (row.syncedAt) {
    console.log(`  synced at:  ${sanitizeForTerminal(row.syncedAt)}`);
  }

  if (row.filePath) {
    console.log(`  file path:  ${sanitizeForTerminal(row.filePath)}`);
  }

  if (row.errorMessage) {
    console.log(`  error:      ${sanitizeForTerminal(row.errorMessage)}`);
  }
};

// Shared by both `reportIncompleteExport` conditions below: chalk prose on
// stderr in plain mode, or the unified `{ error, message }` JSON contract
// under `--json` — mirroring `warnPartialRead` in libs/errors.ts (used by
// records.ts/events.ts for their own partial-read warning) so a script
// parsing stderr never has to distinguish export's warning shape from theirs.
const warnIncomplete = (message: string, json: boolean): void => {
  if (json) {
    printJsonError(JSON_ERROR_PARTIAL_READ, message);
    return;
  }

  console.error(chalk.yellow(`Warning: ${message}`));
};

// A capped export or a batch of malformed rows both mean the returned data is
// incomplete even though the request succeeded, so both warn (stderr, so
// `--json`/`--out` output stays clean on its own channel) AND set a non-zero
// exit — mirroring the partial-read convention in records.ts/events.ts, since
// the warning alone is invisible to a script or cron job checking `$?`.
const reportIncompleteExport = (
  truncated: boolean,
  skippedCount: number,
  json: boolean,
): void => {
  if (truncated) {
    warnIncomplete(
      'The export was truncated at the server-side row limit — only the most recent rows were included.',
      json,
    );
  }

  if (skippedCount > 0) {
    warnIncomplete(
      `The server returned ${skippedCount} malformed row(s), which were skipped.`,
      json,
    );
  }

  if (truncated || skippedCount > 0) {
    process.exitCode = 1;
  }
};

// Writes the already-fetched rows to disk and reports where they landed. A
// filesystem failure here (EACCES, EISDIR, a full disk) is NOT a fetch
// failure — the rows were already fetched successfully — so this composes an
// error naming both facts explicitly, rather than letting the generic
// `describeApiError` in the command's outer catch describe a write error in
// fetch terms and leave the caller thinking nothing was retrieved.
const writeToOutputFile = (
  outputPath: string,
  rows: RecordExportRow[],
  force: boolean,
  skippedCount: number,
): void => {
  let writtenPath: string;

  try {
    writtenPath = writeExportFile(outputPath, rows, force);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Fetched ${rows.length} record(s) but failed to write them to "${outputPath}": ${reason}`,
      { cause: error },
    );
  }

  const skippedSuffix =
    skippedCount > 0 ? ` (${skippedCount} malformed row(s) skipped)` : '';

  console.log(
    chalk.green(
      `Wrote ${rows.length} record(s) to ${sanitizeForTerminal(writtenPath)}.${skippedSuffix}`,
    ),
  );
};

const runExport = async (
  outputPath: string | undefined,
  force: boolean,
  json: boolean,
): Promise<void> => {
  const result = await fetchRecordExport();

  // A failed fetch must not masquerade as an empty backup — throw so the
  // command's catch reports it loudly and exits non-zero, mirroring
  // records.ts/events.ts's listRecords/listEvents. Thrown before any write, so
  // a failed fetch can never touch (or clobber) a previous backup file.
  if (!result.ok) {
    throw new Error('Failed to fetch the export from the server.');
  }

  const { rows, truncated, skippedCount } = result;
  reportIncompleteExport(truncated, skippedCount, json);

  if (outputPath) {
    writeToOutputFile(outputPath, rows, force, skippedCount);
    return;
  }

  // JSON mode prints the array (empty included, as `[]`) and nothing else —
  // no summary line — so stdout stays valid JSON for `jq`. The incompleteness
  // warning above already went to stderr, matching records.ts/events.ts.
  if (json) {
    printJson(rows);
    return;
  }

  if (rows.length === 0) {
    console.log('No records to export.');
    return;
  }

  rows.forEach(printExportRow);
};
