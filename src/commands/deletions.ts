import { parseArgs } from 'node:util';
import chalk from 'chalk';
import { describeApiError } from '#src/libs/api.js';
import { checkConfig } from '#src/libs/config.js';
import {
  applyPrune,
  DeletionFeed,
  fetchDeletionFeed,
  planPrune,
  PruneItem,
  PrunePlan,
} from '#src/libs/deletions.js';
import { failWithMessage, warnMessage } from '#src/libs/errors.js';
import { ensureOutputDirectory } from '#src/libs/markdown.js';
import { printJson } from '#src/libs/output.js';
import { sanitizeForTerminal } from '#src/libs/terminal.js';
import { parseOrFailWithUsage } from '#src/libs/usage.js';
import {
  getLastDeletionSync,
  setLastDeletionSync,
} from '#src/libs/vault-ledger.js';

export const DELETIONS_USAGE = `Deletions options:
  --apply           Remove the vault files the CLI wrote for records deleted on the
                    server. Without it nothing is changed: the command only reports
                    what it would remove (dry run)
  --since <time>    ISO 8601 timestamp to read deletions from. Defaults to the last
                    time --apply completed. Markpost keeps deletions for 30 days; if
                    the window is older (or unknown) the command warns that the vault
                    may still hold notes deleted earlier
  --json            Print the result as JSON instead of formatted text`;

// The next pass starts a little before this one began, so a deletion that
// committed while this pass was reading is not missed (the feed's `since` is
// inclusive, and re-seeing a tombstone is harmless: its ledger entry is gone).
const BASELINE_OVERLAP_MS = 60_000;

const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

type DeletionsArgs = { apply: boolean; since?: string };

const parseDeletionsArgs = (args: string[]): DeletionsArgs => {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      apply: { type: 'boolean' },
      since: { type: 'string' },
      json: { type: 'boolean' },
    },
  });

  // positionals[0] is the `deletions` subcommand itself.
  if (positionals.length > 1) {
    throw new Error(`Unexpected argument "${positionals[1]}".`);
  }

  const { since } = values;

  if (since !== undefined && !ISO_TIMESTAMP_PATTERN.test(since)) {
    throw new Error(
      '--since must be an ISO 8601 timestamp with a timezone, e.g. 2026-11-01T00:00:00Z.',
    );
  }

  return { apply: values.apply ?? false, since };
};

const OUTCOME_LABELS = {
  remove: { applied: 'Removed', preview: 'Would remove' },
  missing: { applied: 'Already gone', preview: 'Already gone' },
  modified: {
    applied: 'Kept (edited since sync)',
    preview: 'Would keep (edited since sync)',
  },
  unsafe: {
    applied: 'Kept (not a plain file inside the vault)',
    preview: 'Would keep (not a plain file inside the vault)',
  },
} as const;

const describeItem = (item: PruneItem, apply: boolean): string => {
  const label = OUTCOME_LABELS[item.outcome][apply ? 'applied' : 'preview'];

  return `  ${label}: ${sanitizeForTerminal(item.path)}`;
};

const incompleteWarning = (since: string | undefined): string => {
  const reason = since
    ? 'older than the 30 days markpost keeps deletions'
    : 'unknown (no earlier deletion sync was recorded and --since was not given)';

  return `Deletion history is not complete: the starting point is ${reason}. Notes deleted before the retained window may still be in your vault; compare it against \`markpost export\` if that matters.`;
};

const printReport = (
  plan: PrunePlan,
  feed: DeletionFeed,
  since: string | undefined,
  apply: boolean,
): void => {
  if (!feed.complete) {
    warnMessage(incompleteWarning(since));
  }

  console.log(
    `${feed.tombstones.length} deleted record(s) on the server, ${plan.items.length} with a file the CLI wrote.`,
  );
  plan.items.forEach((item) => console.log(describeItem(item, apply)));

  if (!apply && plan.items.some((item) => item.outcome === 'remove')) {
    console.log(chalk.yellow('Dry run: re-run with --apply to remove them.'));
  }
};

const printJsonReport = (
  plan: PrunePlan,
  feed: DeletionFeed,
  since: string | undefined,
  apply: boolean,
): void => {
  printJson({
    applied: apply,
    since: since ?? null,
    complete: feed.complete,
    deletedOnServer: feed.tombstones.length,
    untracked: plan.untrackedCount,
    files: plan.items.map(({ uuid, path, outcome }) => ({
      uuid,
      path,
      outcome,
    })),
  });
};

const runDeletions = async (
  { apply, since: explicitSince }: DeletionsArgs,
  json: boolean,
): Promise<void> => {
  const startedAt = Date.now();
  const since = explicitSince ?? getLastDeletionSync();
  const feed = await fetchDeletionFeed(since);
  const vault = ensureOutputDirectory();
  const plan = planPrune(feed.tombstones, vault);

  if (apply) {
    applyPrune(plan, vault);
    // Only a fully paged feed gets here (fetchDeletionFeed throws otherwise),
    // so the baseline never advances past tombstones that were not read.
    setLastDeletionSync(
      new Date(startedAt - BASELINE_OVERLAP_MS).toISOString(),
    );
  }

  if (json) {
    printJsonReport(plan, feed, since, apply);
    return;
  }

  printReport(plan, feed, since, apply);
};

export const runDeletionsCommand = async (
  args: string[],
  json: boolean,
  usage: string,
): Promise<void> => {
  const parsed = parseOrFailWithUsage(
    () => parseDeletionsArgs(args),
    usage,
    json,
  );

  if (!parsed) {
    return;
  }

  try {
    if (!(await checkConfig(json))) {
      return;
    }

    await runDeletions(parsed, json);
  } catch (error) {
    failWithMessage(sanitizeForTerminal(describeApiError(error)), json);
  }
};
