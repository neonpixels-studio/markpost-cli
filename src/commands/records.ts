import chalk from 'chalk';
import { fetchAllRecords } from '@/libs/records.js';
import { checkConfig } from '@/libs/config.js';
import { failWithSubcommandUsage } from '@/libs/usage.js';
import { Record } from '@/types/records.types.js';

export const USAGE = `Usage: markpost records <list>

  list  List all pending records without deleting them`;

export const runRecordsCommand = async (args: string[]): Promise<void> => {
  const [subcommand] = args;

  // Validate before the config check so a bad subcommand fails on usage alone,
  // without needing a configured account.
  if (subcommand !== 'list') {
    failWithSubcommandUsage(subcommand, USAGE);
    return;
  }

  try {
    await checkConfig();
    await listRecords();
  } catch (error) {
    console.error(chalk.redBright(error));
    process.exitCode = 1;
  }
};

const printRecord = (record: Record): void => {
  console.log(chalk.bold(record.title));
  console.log(`  uuid:       ${record.uuid}`);
  console.log(`  created at: ${record.createdAt}`);
};

// Read-only preview of what the default sync would fetch. Deliberately
// never touches deleteRecords: this is the safe alternative to running the
// no-arg sync just to see what's pending.
const listRecords = async (): Promise<void> => {
  const result = await fetchAllRecords();

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
