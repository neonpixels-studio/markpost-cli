import { parseArgs } from 'node:util';
import chalk from 'chalk';
import { fetchRecord } from '@/libs/records.js';
import { describeApiError } from '@/libs/api.js';
import { checkConfig } from '@/libs/config.js';
import {
  sanitizeBlockForTerminal,
  sanitizeForTerminal,
} from '@/libs/terminal.js';
import { failWithUsage } from '@/libs/usage.js';
import { printJson } from '@/libs/output.js';
import { Record } from '@/types/records.types.js';

export const USAGE = `Usage: markpost get <uuid> [--json]

  uuid    UUID of the record to fetch and display
  --json  Print the record as JSON instead of formatted text`;

export const runGetCommand = async (args: string[]): Promise<void> => {
  try {
    const { uuid, json } = parseGetArgs(args);

    if (!uuid) {
      failWithUsage('No uuid given.', USAGE);
      return;
    }

    await checkConfig(json);

    const record = await fetchRecord(uuid);

    if (!record) {
      console.error(chalk.redBright(`Failed to fetch record "${uuid}".`));
      process.exitCode = 1;
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
    console.error(
      chalk.redBright(sanitizeForTerminal(describeApiError(error))),
    );
    process.exitCode = 1;
  }
};

// `parseArgs` accepts the uuid and `--json` in either order and throws on an
// unknown flag (the command's outer catch surfaces it). The uuid is the first
// positional; any extra positional is ignored, matching the prior behavior.
const parseGetArgs = (
  args: string[],
): { uuid: string | undefined; json: boolean } => {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
    },
  });

  return { uuid: positionals[0], json: values.json ?? false };
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
  console.log('');
  console.log(sanitizeBlockForTerminal(record.content));
};
