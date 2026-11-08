import chalk from 'chalk';
import { fetchRecordExport } from '#src/libs/export.js';
import {
  parseExportArgs,
  reportIncompleteExport,
  writeToOutputFile,
} from '#src/libs/export-command.js';
import { describeApiError } from '#src/libs/api.js';
import { checkConfig } from '#src/libs/config.js';
import { failWithMessage } from '#src/libs/errors.js';
import { sanitizeForTerminal } from '#src/libs/terminal.js';
import { parseOrFailWithUsage } from '#src/libs/usage.js';
import { hasJsonFlag, printJson } from '#src/libs/output.js';
import { RecordExportRow } from '#src/types/records.types.js';

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

  // Parse via parseOrFailWithUsage, before the fetch path, so a bad flag or stray
  // argument reports the `usage` JSON code (and the usage block without --json)
  // rather than the fetch path's `fetch_failed`/generic prose — a usage error
  // is not a fetch failure (issue #208), mirroring records.ts/events.ts.
  const parsed = parseOrFailWithUsage(
    () => parseExportArgs(args, 'export'),
    USAGE,
    json,
  );

  if (!parsed) {
    return;
  }

  const { outputPath, force } = parsed;

  try {
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

const runExport = async (
  outputPath: string | undefined,
  force: boolean,
  json: boolean,
): Promise<void> => {
  const result = await fetchRecordExport(json);

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
    writeToOutputFile(outputPath, rows, force, skippedCount, 'record');
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
