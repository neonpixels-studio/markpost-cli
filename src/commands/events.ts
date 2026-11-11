import { parseArgs } from 'node:util';
import chalk from 'chalk';
import {
  EVENT_FILTER_PARSE_OPTIONS,
  filterEventRows,
  resolveEventFilters,
} from '#src/libs/event-filters.js';
import { fetchAllEvents } from '#src/libs/events.js';
import { fetchEventExport } from '#src/libs/export.js';
import {
  parseExportArgs,
  reportIncompleteExport,
  writeToOutputFile,
} from '#src/libs/export-command.js';
import { describeApiError } from '#src/libs/api.js';
import { checkConfig } from '#src/libs/config.js';
import { failWithMessage, warnPartialRead } from '#src/libs/errors.js';
import { sanitizeForTerminal } from '#src/libs/terminal.js';
import {
  failWithSubcommandUsage,
  parseOrFailWithUsage,
} from '#src/libs/usage.js';
import { hasJsonFlag, printJson } from '#src/libs/output.js';
import {
  EVENT_KINDS,
  EventExportRow,
  EventFilters,
  EventKind,
} from '#src/types/events.types.js';

export const USAGE = `Usage: markpost events <list|export> [options]

  list    List the ingestion activity log (ok/dim/warn/err entries), newest first
  export  Export the whole activity log (inside markpost's retention window),
          newest first, via markpost's dedicated export endpoint. Needs a token
          with the events:read scope. markpost caps the export at its row
          limit; a capped export (or one where the server returned a malformed
          row) still writes/prints the rows it did get, but warns and exits
          non-zero so a script can detect an incomplete export.

Options:
  --kind <kind>  Only events of one kind: ok, dim, warn, or err
  --source <id>  Only events for one source (its uuid, see \`sources list\`)
  --json        Print the events as JSON instead of formatted text (export:
                cannot be combined with --out)
  --out <path>  (export) Write the export as JSON to <path> instead of
                printing to stdout (creates parent directories as needed)
  --force       (export) Overwrite <path> if it already exists (--out only)`;

export const runEventsCommand = async (args: string[]): Promise<void> => {
  // Read `--json` straight from argv so every failure below is rendered in
  // whichever contract the caller asked for, even one thrown before parsing.
  const json = hasJsonFlag(args);
  const [subcommand] = args;

  // Validate before the config check so a bad subcommand fails on usage
  // alone, without needing a configured account.
  if (subcommand === 'export') {
    await runEventsExport(args.slice(1), json);
    return;
  }

  if (subcommand !== 'list') {
    failWithSubcommandUsage(subcommand, USAGE, json);
    return;
  }

  // Validates the filters and rejects a stray argument before checkConfig.
  // Parsed via parseOrFailWithUsage so a usage throw reports the `usage` JSON
  // code, not `fetch_failed`.
  const parsedList = parseOrFailWithUsage(
    () => parseListArgs(args),
    USAGE,
    json,
  );

  if (!parsedList) {
    return;
  }

  try {
    if (!(await checkConfig(json))) {
      return;
    }

    await listEvents(json, parsedList.filters);
  } catch (error) {
    // A systemic auth/5xx failure re-throws from fetchAllEvents; surface its
    // classified, actionable message with a non-zero exit rather than the
    // generic "Failed to fetch events" a null return produces. Sanitize — the
    // message can be server-derived.
    failWithMessage(sanitizeForTerminal(describeApiError(error)), json);
  }
};

// `parseArgs` throws on an unknown flag and hands back every positional, so a
// bad invocation (`events list --bogus`, `events list webhook`) fails loud
// here rather than silently ignored. positionals[0] is the `list` subcommand
// itself; anything past it is a stray argument.
const parseListArgs = (args: string[]): { filters: EventFilters } => {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      ...EVENT_FILTER_PARSE_OPTIONS,
    },
  });

  if (positionals.length > 1) {
    throw new Error(
      `Unexpected argument "${positionals[1]}". \`events list\` takes no positional arguments. Filter with --kind or --source.`,
    );
  }

  return { filters: resolveEventFilters(values) };
};

// One color function per markpost event kind, keyed off the local
// `EventKind` union (src/types/events.types.ts) so a kind added to that list
// can't ship without a color. `EVENT_KINDS` is copied by hand from
// markpost's server/db/schema.ts (it isn't part of the vendored contract
// sync — see src/types/api.types.ts), so a kind added only on the server
// side won't fail the build here; it just prints uncolored via the
// `isEventKind` fallback below.
const KIND_COLORS: Record<EventKind, (text: string) => string> = {
  ok: chalk.green,
  dim: chalk.dim,
  warn: chalk.yellow,
  err: chalk.redBright,
};

const isEventKind = (kind: string): kind is EventKind =>
  (EVENT_KINDS as readonly string[]).includes(kind);

// `event.kind` is untrusted API output typed as a bare `string` (see
// events.types.ts), so it's coerced through `String(... ?? '')` before
// `toUpperCase()` — an off-contract non-string value (null, a number) must
// not throw and take down the whole list. An off-contract *string* value
// (neither ok/dim/warn/err) still prints, just uncolored.
const colorizeKind = (kind: unknown): string => {
  const kindText = String(kind ?? '');
  const label = sanitizeForTerminal(kindText.toUpperCase());

  if (!isEventKind(kindText)) {
    return label;
  }

  return KIND_COLORS[kindText](label);
};

// ts, kind, and message come from the untrusted API response, so each is
// stripped of control/ANSI escapes before printing (see terminal.ts).
// sourceId/recordUuid print only when present — an event isn't always tied
// to a source (e.g. a system-level entry) or a record (an error before one
// was created).
const printEvent = (event: EventExportRow): void => {
  console.log(`${colorizeKind(event.kind)}  ${sanitizeForTerminal(event.ts)}`);
  console.log(`  ${sanitizeForTerminal(event.message)}`);

  if (event.sourceId) {
    console.log(`  source: ${sanitizeForTerminal(event.sourceId)}`);
  }

  if (event.recordUuid) {
    console.log(`  record: ${sanitizeForTerminal(event.recordUuid)}`);
  }
};

// Read-only view of the ingestion activity log — the diagnostic counterpart
// to `records list`: a source that silently stops ingesting shows up here as
// a warn/err entry even when it produced no record at all.
const listEvents = async (
  json: boolean,
  filters: EventFilters,
): Promise<void> => {
  const result = await fetchAllEvents(json, filters);

  // A failed fetch must not masquerade as "No events found." — throw so the
  // command's catch reports it loudly and exits non-zero, rather than
  // printing the same message an empty log would produce.
  if (!result.ok) {
    throw new Error('Failed to fetch events from the server.');
  }

  const { events, partial } = result;

  // A partial read (a later page failed mid-pagination) must not present a
  // truncated list as the full log. `warnPartialRead` reports it honestly —
  // chalk prose on stderr in plain mode, or the unified `{ error, message }`
  // JSON contract under `--json` — and sets a non-zero exit either way, so
  // the JSON path below still writes clean JSON to stdout while the caller
  // (and `--json`) still sees the failure.
  if (partial) {
    warnPartialRead(json);
  }

  // JSON mode prints the array (empty included, as `[]`) and nothing else —
  // no "No events found." line, so stdout stays valid JSON for `jq`.
  if (json) {
    printJson(events);
    return;
  }

  if (events.length === 0) {
    console.log(
      partial
        ? 'No events fetched — the read failed partway through.'
        : 'No events found.',
    );
    return;
  }

  events.forEach(printEvent);
};

// Mirrors runExportCommand in export.ts (the records backup), reusing its
// flag parsing and incomplete-export reporting from libs/export-command.ts.
const runEventsExport = async (
  exportArgs: string[],
  json: boolean,
): Promise<void> => {
  const parsed = parseOrFailWithUsage(
    () => parseEventExportArgs(exportArgs),
    USAGE,
    json,
  );

  if (!parsed) {
    return;
  }

  try {
    if (!(await checkConfig(json))) {
      return;
    }

    await exportEvents(parsed.outputPath, parsed.force, json, parsed.filters);
  } catch (error) {
    failWithMessage(sanitizeForTerminal(describeApiError(error)), json);
  }
};

const parseEventExportArgs = (exportArgs: string[]) => {
  const { extraValues, ...exportOptions } = parseExportArgs(
    exportArgs,
    'events export',
    EVENT_FILTER_PARSE_OPTIONS,
  );

  return {
    ...exportOptions,
    filters: resolveEventFilters(
      extraValues as Parameters<typeof resolveEventFilters>[0],
    ),
  };
};

const exportEvents = async (
  outputPath: string | undefined,
  force: boolean,
  json: boolean,
  filters: EventFilters,
): Promise<void> => {
  const result = await fetchEventExport(json);

  // Thrown before any write, so a failed fetch can never touch (or clobber) a
  // previous export file.
  if (!result.ok) {
    throw new Error('Failed to fetch the events export from the server.');
  }

  const { truncated, skippedCount } = result;
  const rows = filterEventRows(result.rows, filters);
  reportIncompleteExport(truncated, skippedCount, json);

  if (outputPath) {
    writeToOutputFile(outputPath, rows, force, skippedCount, 'event');
    return;
  }

  if (json) {
    printJson(rows);
    return;
  }

  if (rows.length === 0) {
    console.log('No events to export.');
    return;
  }

  rows.forEach(printEvent);
};
