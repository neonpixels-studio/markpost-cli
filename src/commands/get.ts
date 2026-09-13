import { parseArgs } from 'node:util';
import chalk from 'chalk';
import { fetchRecord } from '@/libs/records.js';
import { describeApiError } from '@/libs/api.js';
import { checkConfig } from '@/libs/config.js';
import { failWithMessage } from '@/libs/errors.js';
import {
  sanitizeBlockForTerminal,
  sanitizeForTerminal,
} from '@/libs/terminal.js';
import { failWithUsage } from '@/libs/usage.js';
import { hasJsonFlag, printJson } from '@/libs/output.js';
import { Record } from '@/types/records.types.js';

export const USAGE = `Usage: markpost get <uuid...> [--json]

  uuid    One or more UUIDs of records to fetch and display
  --json  Print the record(s) as JSON instead of formatted text`;

export const runGetCommand = async (args: string[]): Promise<void> => {
  // Read `--json` straight from argv so every failure below — including an
  // unknown flag that makes `parseGetArgs` throw before it can report the
  // flag — is rendered in whichever contract the caller asked for.
  const json = hasJsonFlag(args);

  try {
    const { uuids } = parseGetArgs(args);

    if (uuids.length === 0) {
      failWithUsage('No uuid given.', USAGE, json);
      return;
    }

    if (!(await checkConfig(json))) {
      return;
    }

    // Fetch every uuid, one at a time (mirroring push's per-file loop): a
    // batch lookup is cheap since `fetchRecord` is already a single-uuid
    // request, and sequential requests keep output ordered and the server
    // unhammered. A systemic failure (auth/5xx) re-throws from `fetchRecord`
    // and propagates straight out of this loop to the outer catch below,
    // aborting any not-yet-fetched uuids exactly like the single-uuid path
    // already did.
    const results: GetResult[] = [];

    for (const uuid of uuids) {
      results.push({ uuid, record: await fetchRecord(uuid) });
    }

    reportResults(results, json);
  } catch (error) {
    // A systemic auth/5xx failure now re-throws from fetchRecord (issue #89):
    // surface its classified, actionable message with a non-zero exit rather
    // than the generic "Failed to fetch record" a not-found (null) produces.
    // Sanitize — the message can be server-derived.
    failWithMessage(sanitizeForTerminal(describeApiError(error)), json);
  }
};

// `parseArgs` accepts any number of uuids and `--json` in either order and
// throws on an unknown flag (the command's outer catch surfaces it). Every
// positional is a requested uuid — none are silently dropped (issue #173).
// Positionals are filtered for blanks so a stray empty-string argument can't
// masquerade as a requested uuid.
const parseGetArgs = (args: string[]): { uuids: string[] } => {
  // `--json` is still declared so `parseArgs` accepts it rather than rejecting
  // it as unknown; its value is read from argv by `hasJsonFlag` in the caller,
  // which also survives an unrelated bad flag that makes this throw.
  const { positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
    },
  });

  return { uuids: positionals.filter((positional) => positional.length > 0) };
};

// One requested uuid's outcome: the record it resolved to, or `null` when
// `fetchRecord` classified it as a genuine not-found (a systemic failure
// throws instead and is handled by the caller's try/catch, not this shape).
interface GetResult {
  uuid: string;
  record: Record | null;
}

const reportMissing = (uuid: string, json: boolean): void => {
  failWithMessage(`Failed to fetch record "${uuid}".`, json);
};

// A single requested uuid keeps the original, unwrapped shapes (one printed
// record, or nothing on stdout when it's missing) so an existing
// `markpost get <uuid> --json | jq '.title'` script or a single-record
// terminal read keeps working unchanged. Two or more uuids print every found
// record — as a JSON array in `--json` mode, or one after another separated
// by a blank line in text mode — and report each missing uuid without
// dropping the rest of the batch.
const reportResults = (results: GetResult[], json: boolean): void => {
  if (json) {
    reportJsonResults(results);
    return;
  }

  reportTextResults(results);
};

const reportJsonResults = (results: GetResult[]): void => {
  const [single] = results;

  if (results.length === 1) {
    if (!single.record) {
      reportMissing(single.uuid, true);
      return;
    }

    printJson(single.record);
    return;
  }

  for (const result of results) {
    if (!result.record) {
      reportMissing(result.uuid, true);
    }
  }

  const records = results
    .filter((result): result is GetResult & { record: Record } =>
      Boolean(result.record),
    )
    .map((result) => result.record);

  printJson(records);
};

const reportTextResults = (results: GetResult[]): void => {
  let printedFirst = false;

  for (const result of results) {
    if (!result.record) {
      reportMissing(result.uuid, false);
      continue;
    }

    // Separate multiple printed records with a blank line; the very first one
    // (and the only one, in the single-uuid case) prints with no leading gap,
    // matching the prior single-uuid output exactly.
    if (printedFirst) {
      console.log('');
    }

    printRecord(result.record);
    printedFirst = true;
  }
};

// Every field here comes from the untrusted API response, so each is stripped
// of control/ANSI escapes before printing (see terminal.ts). The single-line
// fields use the strict sanitizer; the multi-line markdown body uses the block
// sanitizer so its newlines and indentation survive (a run-on single line would
// also break `markpost get <uuid> > note.md`).
const printRecord = (record: Record): void => {
  console.log(chalk.bold(sanitizeForTerminal(record.title)));
  console.log(`  uuid:       ${sanitizeForTerminal(record.uuid)}`);
  console.log(`  created at: ${sanitizeForTerminal(record.createdAt)}`);

  // status and syncedAt are printed only when present: markpost sends both on
  // every record, but they stay optional in the type for off-contract
  // responses, and a missing value shouldn't print a blank label.
  if (record.status) {
    console.log(`  status:     ${sanitizeForTerminal(record.status)}`);
  }

  if (record.syncedAt) {
    console.log(`  synced at:  ${sanitizeForTerminal(record.syncedAt)}`);
  }

  console.log('');
  console.log(sanitizeBlockForTerminal(record.content));
};
