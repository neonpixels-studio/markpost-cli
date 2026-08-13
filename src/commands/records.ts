import { parseArgs } from 'node:util';
import chalk from 'chalk';
import { fetchAllRecords, RecordListFilters } from '@/libs/records.js';
import { describeApiError } from '@/libs/api.js';
import { checkConfig } from '@/libs/config.js';
import { sanitizeForTerminal } from '@/libs/terminal.js';
import { failWithSubcommandUsage } from '@/libs/usage.js';
import { Record } from '@/types/records.types.js';

export const USAGE = `Usage: markpost records list [options]

  list  List records, optionally filtered by source, status, or search text

Options:
  --source <type>    Filter by source type (markpost reports the valid types if the value is rejected)
  --status <status>  Filter by record status (synced, pending, or error)
  --search <text>    Filter by text in the title or content`;

export const runRecordsCommand = async (args: string[]): Promise<void> => {
  const [subcommand] = args;

  // Validate before the config check so a bad subcommand fails on usage alone,
  // without needing a configured account.
  if (subcommand !== 'list') {
    failWithSubcommandUsage(subcommand, USAGE);
    return;
  }

  try {
    // Parse filters before checkConfig, which prompts for and persists an API
    // token/output directory when unset: a bad flag must fail on usage alone,
    // not after dragging the user through (or blocking a non-TTY run on) the
    // config prompts. Mirrors the subcommand validation above.
    const filters = parseListFilters(args);
    await checkConfig();
    await listRecords(filters);
  } catch (error) {
    // A systemic auth/5xx failure now re-throws from fetchAllRecords (issue
    // #89): surface its classified, actionable message with a non-zero exit,
    // distinct from the generic "Failed to fetch records" a non-systemic
    // failure produces. Sanitize — the message can be server-derived.
    console.error(
      chalk.redBright(sanitizeForTerminal(describeApiError(error))),
    );
    process.exitCode = 1;
  }
};

// `parseArgs` handles both `--source webhook` and `--source=webhook`, and
// throws on an unknown flag or a missing value, which the command's outer
// catch surfaces to the user. The `list` subcommand itself lands in
// `positionals` and is skipped here.
const parseListFilters = (args: string[]): RecordListFilters => {
  // `multiple: true` collects repeats into an array so a flag passed twice
  // (`--source webhook --source email`) can be rejected rather than silently
  // last-winning, matching how stray positionals and empty values fail below.
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      source: { type: 'string', multiple: true },
      status: { type: 'string', multiple: true },
      search: { type: 'string', multiple: true },
    },
  });

  // positionals[0] is the `list` subcommand itself; anything past it is a
  // stray argument (e.g. `records list webhook`, a likely miss for
  // `--source webhook`) and must fail loudly rather than silently listing
  // everything unfiltered.
  if (positionals.length > 1) {
    throw new Error(
      `Unexpected argument "${positionals[1]}". Set filters with --source, --status, or --search.`,
    );
  }

  return {
    source: normalizeFilter('source', values.source),
    status: normalizeFilter('status', values.status),
    search: normalizeFilter('search', values.search),
  };
};

// Collapses a flag's parsed occurrences (an array under `multiple: true`)
// into a single validated value. A flag passed more than once is ambiguous
// and rejected. A present-but-empty or whitespace-only flag (`--source=`,
// `--search ' '`) would otherwise drop out of the query and list everything
// while the user believes they filtered, so it is rejected too. The trimmed
// value is what gets sent: markpost trims `filter[q]` server-side anyway, and
// a trimmed source/status is more forgiving than shipping surrounding spaces
// that match nothing.
const normalizeFilter = (
  flag: string,
  occurrences: string[] | undefined,
): string | undefined => {
  if (occurrences === undefined) {
    return undefined;
  }

  if (occurrences.length > 1) {
    throw new Error(`--${flag} was given more than once. Pass it only once.`);
  }

  const trimmed = occurrences[0].trim();

  if (trimmed.length === 0) {
    throw new Error(`--${flag} needs a non-empty value.`);
  }

  return trimmed;
};

// title, uuid, and createdAt all come from the untrusted API response, so each
// is stripped of control/ANSI escapes before printing (see terminal.ts).
const printRecord = (record: Record): void => {
  console.log(chalk.bold(sanitizeForTerminal(record.title)));
  console.log(`  uuid:       ${sanitizeForTerminal(record.uuid)}`);
  console.log(`  created at: ${sanitizeForTerminal(record.createdAt)}`);
};

// Read-only preview of the records on the server (optionally filtered).
// Deliberately never touches deleteRecords: this is the safe alternative to
// running the no-arg sync just to see what's there.
const listRecords = async (filters: RecordListFilters): Promise<void> => {
  const result = await fetchAllRecords(filters);

  // A failed fetch must not masquerade as "No records found." — throw so the
  // command's catch reports it loudly and exits non-zero, rather than printing
  // the same message an empty account would produce.
  if (!result.ok) {
    throw new Error('Failed to fetch records from the server.');
  }

  const { records, partial } = result;

  // A partial read (a later page failed mid-pagination) must not present a
  // truncated list as the full set. Warn and exit non-zero so the preview
  // stays honest — `fetchPaginatedRecords` already logged the cause.
  if (partial) {
    console.error(
      chalk.yellow(
        'Warning: a later page failed to fetch — this list may be incomplete.',
      ),
    );
    process.exitCode = 1;
  }

  if (records.length === 0) {
    // A partial read with zero records must not claim "No records found." — the
    // read failed before any page came back, which is not an empty account.
    console.log(
      partial
        ? 'No records fetched — the read failed partway through.'
        : 'No records found.',
    );
    return;
  }

  records.forEach(printRecord);
};
