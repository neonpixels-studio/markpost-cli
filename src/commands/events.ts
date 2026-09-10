import { parseArgs } from 'node:util';
import chalk from 'chalk';
import { fetchAllEvents } from '@/libs/events.js';
import { describeApiError } from '@/libs/api.js';
import { checkConfig } from '@/libs/config.js';
import { failWithMessage } from '@/libs/errors.js';
import { sanitizeForTerminal } from '@/libs/terminal.js';
import { failWithSubcommandUsage } from '@/libs/usage.js';
import { hasJsonFlag, printJson } from '@/libs/output.js';
import { Event, EVENT_KINDS, EventKind } from '@/types/events.types.js';

export const USAGE = `Usage: markpost events list [options]

  list  List the ingestion activity log (ok/dim/warn/err entries), newest first

Options:
  --json  Print the events as JSON instead of formatted text`;

export const runEventsCommand = async (args: string[]): Promise<void> => {
  // Read `--json` straight from argv so every failure below is rendered in
  // whichever contract the caller asked for, even one thrown before parsing.
  const json = hasJsonFlag(args);
  const [subcommand] = args;

  // Validate before the config check so a bad subcommand fails on usage
  // alone, without needing a configured account.
  if (subcommand !== 'list') {
    failWithSubcommandUsage(subcommand, USAGE, json);
    return;
  }

  try {
    // markpost's GET /api/events takes no filters (unlike /api/records), so
    // `events list` takes no flags of its own beyond `--json` — parsed here
    // only to reject a stray argument before dragging the user through (or
    // blocking a non-TTY run on) the config check.
    parseListArgs(args);

    if (!(await checkConfig(json))) {
      return;
    }

    await listEvents(json);
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
const parseListArgs = (args: string[]): void => {
  const { positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
    },
  });

  if (positionals.length > 1) {
    throw new Error(
      `Unexpected argument "${positionals[1]}". \`events list\` takes no arguments.`,
    );
  }
};

// One color function per markpost event kind (server/db/schema.ts
// EVENT_KINDS), keyed off the shared `EventKind` union so a kind added there
// can't silently ship with no color mapping here.
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
const printEvent = (event: Event): void => {
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
const listEvents = async (json: boolean): Promise<void> => {
  const result = await fetchAllEvents();

  // A failed fetch must not masquerade as "No events found." — throw so the
  // command's catch reports it loudly and exits non-zero, rather than
  // printing the same message an empty log would produce.
  if (!result.ok) {
    throw new Error('Failed to fetch events from the server.');
  }

  const { events, partial } = result;

  // A partial read (a later page failed mid-pagination) must not present a
  // truncated list as the full log. Warn and exit non-zero so the preview
  // stays honest. The warning goes to stderr, so the JSON path below still
  // writes clean JSON to stdout while the caller (and `--json`) still sees
  // the non-zero exit.
  if (partial) {
    console.error(
      chalk.yellow(
        'Warning: a later page failed to fetch — this list may be incomplete.',
      ),
    );
    process.exitCode = 1;
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
