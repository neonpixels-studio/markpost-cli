import chalk from 'chalk';
import { input, select } from '@inquirer/prompts';
import {
  createSource,
  deleteSource,
  fetchSources,
  updateSource,
} from '@/libs/sources.js';
import { checkConfig } from '@/libs/config.js';
import { sanitizeForTerminal } from '@/libs/terminal.js';
import { failWithSubcommandUsage } from '@/libs/usage.js';
import { Source, SOURCE_TYPES, SourceType } from '@/types/sources.types.js';

// Mirror the endpoint constants markpost's web app uses in
// app/composables/useSources.ts so the CLI shows the same URL a user would
// see there.
const WEBHOOK_INGEST_BASE = 'https://ingest.markpost.io/v1/hooks';
const EMAIL_DOMAIN = 'in.markpost.io';

export const USAGE = `Usage: markpost sources <list|create|update|delete> [uuid]

  list           List all sources
  create         Create a new source (prompts for details)
  update [uuid]  Update a source's route folder; prompts to pick one if uuid is omitted
  delete [uuid]  Delete a source; prompts to pick one if uuid is omitted`;

export const buildEndpointUrl = (
  sourceType: SourceType,
  endpointSlug: string,
): string => {
  if (sourceType === 'email') {
    return `${endpointSlug}@${EMAIL_DOMAIN}`;
  }

  return `${WEBHOOK_INGEST_BASE}/${endpointSlug}`;
};

// Membership check and handler come from the same Map, so a subcommand can
// never pass the guard without a handler (which would otherwise risk falling
// through to the destructive delete). A Map (not an object) keeps a subcommand
// named "toString" from resolving to a prototype member.
const SOURCES_HANDLERS = new Map<
  string,
  (uuid: string | undefined) => Promise<void>
>([
  ['list', () => listSources()],
  ['create', () => createSourceCommand()],
  ['update', (uuid) => updateSourceCommand(uuid)],
  ['delete', (uuid) => deleteSourceCommand(uuid)],
]);

export const runSourcesCommand = async (args: string[]): Promise<void> => {
  const [subcommand, uuid] = args;
  const handler = SOURCES_HANDLERS.get(subcommand);

  // Validate before the config check so a bad subcommand fails on usage alone,
  // without needing a configured account.
  if (!handler) {
    failWithSubcommandUsage(subcommand, USAGE);
    return;
  }

  try {
    await checkConfig();
    await handler(uuid);
  } catch (error) {
    // A deliberate Ctrl+C at a prompt throws @inquirer's `ExitPromptError`;
    // that's a user abort, not a command failure, so don't flag it non-zero.
    if (error instanceof Error && error.name === 'ExitPromptError') {
      return;
    }

    console.error(chalk.redBright(error));
    process.exitCode = 1;
  }
};

// name, type, endpoint (built from endpointSlug), routeFolder, and lastHitAt
// all come from the untrusted API response, so each is stripped of control/ANSI
// escapes before printing (see terminal.ts). recordCount is a number and needs
// no sanitizing.
const printSource = (source: Source): void => {
  console.log(chalk.bold(sanitizeForTerminal(source.name)));
  console.log(`  uuid:      ${sanitizeForTerminal(source.uuid)}`);
  console.log(`  type:      ${sanitizeForTerminal(source.type)}`);
  console.log(
    `  endpoint:  ${sanitizeForTerminal(
      buildEndpointUrl(source.type, source.endpointSlug),
    )}`,
  );
  console.log(`  folder:    ${sanitizeForTerminal(source.routeFolder)}`);
  console.log(`  records:   ${source.recordCount}`);
  console.log(
    `  last hit:  ${sanitizeForTerminal(source.lastHitAt ?? 'never hit')}`,
  );
};

const listSources = async (): Promise<void> => {
  const sources = await fetchSources();

  if (sources.length === 0) {
    console.log('No sources found.');
    return;
  }

  sources.forEach(printSource);
};

const createSourceCommand = async (): Promise<void> => {
  const type = await select({
    message: 'Source type',
    choices: SOURCE_TYPES.map((sourceType) => ({ value: sourceType })),
  });
  const name = await input({ message: 'Source name' });
  const routeFolder = await input({
    message: 'Route folder (e.g. 99-incoming/)',
  });
  const provider = await input({
    message: 'Provider (optional)',
    default: '',
  });

  const source = await createSource({
    type,
    name,
    routeFolder,
    provider: provider || undefined,
  });

  if (!source) {
    console.error(chalk.redBright('Failed to create source.'));
    return;
  }

  console.log(
    chalk.greenBright(`Created source "${sanitizeForTerminal(source.name)}"`),
  );
  printSource(source);
};

// Shared by update and delete: list existing sources and let the user pick
// one, or report there's nothing to act on.
const promptForSource = async (action: string): Promise<Source | null> => {
  const sources = await fetchSources();

  if (sources.length === 0) {
    console.log(`No sources to ${action}.`);
    return null;
  }

  const selectedUuid = await select({
    message: `Select a source to ${action}`,
    choices: sources.map((source) => ({
      name: sanitizeForTerminal(`${source.name} (${source.type})`),
      value: source.uuid,
    })),
  });

  return sources.find((source) => source.uuid === selectedUuid) ?? null;
};

const findSourceByUuid = async (uuid: string): Promise<Source | null> => {
  const sources = await fetchSources();
  const source = sources.find((candidate) => candidate.uuid === uuid);

  if (source) {
    return source;
  }

  // fetchSources() swallows transport errors (except a timeout, which
  // propagates) and returns [], so a uuid that doesn't match is
  // indistinguishable here from a failed lookup.
  console.error(
    chalk.redBright(
      'Source not found, or the source list could not be loaded.',
    ),
  );

  return null;
};

const promptAndApplyRouteFolder = async (target: Source): Promise<void> => {
  const routeFolder = (
    await input({
      message: 'Route folder (e.g. 99-incoming/)',
      default: target.routeFolder,
    })
  ).trim();

  if (!routeFolder) {
    console.error(chalk.redBright('Route folder cannot be empty.'));
    return;
  }

  if (routeFolder === target.routeFolder) {
    console.log('Route folder unchanged.');
    return;
  }

  const source = await updateSource(target.uuid, { routeFolder });

  if (!source) {
    console.error(chalk.redBright('Failed to update source.'));
    return;
  }

  console.log(
    chalk.greenBright(`Updated source "${sanitizeForTerminal(source.name)}"`),
  );
  printSource(source);
};

const updateSourceCommand = async (uuid?: string): Promise<void> => {
  const target = uuid
    ? await findSourceByUuid(uuid)
    : await promptForSource('update');

  if (!target) {
    return;
  }

  await promptAndApplyRouteFolder(target);
};

const deleteSourceCommand = async (uuid?: string): Promise<void> => {
  const targetUuid = uuid ?? (await promptForSource('delete'))?.uuid;

  if (!targetUuid) {
    return;
  }

  const meta = await deleteSource(targetUuid);

  if (!meta) {
    console.error(chalk.redBright('Failed to delete source.'));
    return;
  }

  console.log(chalk.greenBright(`Deleted ${meta.deleted} source(s).`));
};
