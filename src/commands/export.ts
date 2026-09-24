import { parseArgs } from 'node:util';
import chalk from 'chalk';
import { fetchRecordExport, writeExportFile } from '@/libs/export.js';
import { describeApiError } from '@/libs/api.js';
import { checkConfig } from '@/libs/config.js';
import { failWithMessage, warnPartialRead } from '@/libs/errors.js';
import { sanitizeForTerminal } from '@/libs/terminal.js';
import { hasJsonFlag, printJson } from '@/libs/output.js';
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

// A capped export and a batch of malformed rows are independent reasons the
// export can be incomplete, so each gets its own lowercase clause here; the
// caller below joins whichever clauses apply into one sentence.
const describeIncompleteExport = (
  truncated: boolean,
  skippedCount: number,
): string[] => {
  const reasons: string[] = [];

  if (truncated) {
    reasons.push(
      'the export was truncated at the server-side row limit — only the most recent rows were included',
    );
  }

  if (skippedCount > 0) {
    reasons.push(
      `the server returned ${skippedCount} malformed row(s), which were skipped`,
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
const reportIncompleteExport = (
  truncated: boolean,
  skippedCount: number,
  json: boolean,
): void => {
  const reasons = describeIncompleteExport(truncated, skippedCount);

  if (reasons.length === 0) {
    return;
  }

  const combinedReason = reasons.join('; ');
  const message = `${combinedReason.charAt(0).toUpperCase()}${combinedReason.slice(1)}.`;

  warnPartialRead(json, message);
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
