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

export const USAGE = `Usage: markpost get <uuid> [--json]

  uuid    UUID of the record to fetch and display
  --json  Print the record as JSON instead of formatted text`;

export const runGetCommand = async (args: string[]): Promise<void> => {
  // Read `--json` straight from argv so every failure below — including an
  // unknown flag that makes `parseGetArgs` throw before it can report the
  // flag — is rendered in whichever contract the caller asked for.
  const json = hasJsonFlag(args);

  try {
    const { uuid } = parseGetArgs(args);

    if (!uuid) {
      failWithUsage('No uuid given.', USAGE, json);
      return;
    }

    if (!(await checkConfig(json))) {
      return;
    }

    const record = await fetchRecord(uuid);

    if (!record) {
      failWithMessage(`Failed to fetch record "${uuid}".`, json);
      return;
    }

    if (json) {
      printJson(record);
      return;
    }

    printRecord(record);
  } catch (error) {
    // A systemic auth/5xx failure now re-throws from fetchRecord (issue #89):
    // surface its classified, actionable message with a non-zero exit rather
    // than the generic "Failed to fetch record" a not-found (null) produces.
    // Sanitize — the message can be server-derived.
    failWithMessage(sanitizeForTerminal(describeApiError(error)), json);
  }
};

// `parseArgs` accepts the uuid and `--json` in either order and throws on an
// unknown flag (the command's outer catch surfaces it). The uuid is the first
// positional; any extra positional is ignored, matching the prior behavior.
const parseGetArgs = (args: string[]): { uuid: string | undefined } => {
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

  return { uuid: positionals[0] };
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
