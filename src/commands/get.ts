import chalk from 'chalk';
import { fetchRecord } from '@/libs/records.js';
import { checkConfig } from '@/libs/config.js';
import { sanitizeForTerminal } from '@/libs/terminal.js';
import { failWithUsage } from '@/libs/usage.js';
import { Record } from '@/types/records.types.js';

export const USAGE = `Usage: markpost get <uuid>

  uuid  UUID of the record to fetch and display`;

export const runGetCommand = async (args: string[]): Promise<void> => {
  try {
    const [uuid] = args;

    if (!uuid) {
      failWithUsage('No uuid given.', USAGE);
      return;
    }

    await checkConfig();

    const record = await fetchRecord(uuid);

    if (!record) {
      console.error(chalk.redBright(`Failed to fetch record "${uuid}".`));
      process.exitCode = 1;
      return;
    }

    printRecord(record);
  } catch (error) {
    console.error(chalk.redBright(error));
    process.exitCode = 1;
  }
};

// Every field here comes from the untrusted API response, so each is stripped
// of control/ANSI escapes before printing (see terminal.ts sanitizeForTerminal).
const printRecord = (record: Record): void => {
  console.log(chalk.bold(sanitizeForTerminal(record.title)));
  console.log(`  uuid:       ${sanitizeForTerminal(record.uuid)}`);
  console.log(`  created at: ${sanitizeForTerminal(record.createdAt)}`);
  console.log('');
  console.log(sanitizeForTerminal(record.content));
};
