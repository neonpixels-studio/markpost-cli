import { parseArgs } from 'node:util';
import chalk from 'chalk';
import { confirm, input, password, select } from '@inquirer/prompts';
import {
  createSource,
  deleteSource,
  fetchSources,
  rotateSourceSecret,
  testSource,
  updateSource,
} from '@/libs/sources.js';
import { checkConfig } from '@/libs/config.js';
import { failWithMessage, messageFromError } from '@/libs/errors.js';
import { isInteractiveTerminal, sanitizeForTerminal } from '@/libs/terminal.js';
import {
  failWithSubcommandUsage,
  failWithUsage,
  parseOrFailWithUsage,
} from '@/libs/usage.js';
import { hasJsonFlag, printJson } from '@/libs/output.js';
import {
  FIELD_MAPPING_KEYS,
  FieldMappingConfig,
  FieldMappingKey,
  isManualSecretProvider,
  isRotatableProvider,
  MANUAL_SECRET_PROVIDERS,
  ROTATABLE_PROVIDERS,
  RotateSourceSecretInput,
  Source,
  SOURCE_TYPES,
  SourceTestResult,
  SourceTestSignatureStatus,
  SourceType,
  UpdateSourceInput,
} from '@/types/sources.types.js';

// Mirror the endpoint constants markpost's web app uses in
// app/composables/useSources.ts so the CLI shows the same URL a user would
// see there. Exported so tests/libs/source-endpoints-drift.test.ts can guard
// them against markpost's real values (see README.md#source-endpoint-sync).
export const WEBHOOK_INGEST_BASE = 'https://ingest.markpost.io/v1/hooks';
export const EMAIL_DOMAIN = 'in.markpost.io';

export const USAGE = `Usage: markpost sources <list|create|update|delete|rotate-secret|test> [uuid]

  list                  List all sources (pass --json for machine-readable output)
  create                Create a new source (prompts for details)
  update [uuid]         Update a source's route folder and/or field mapping; prompts to pick one if uuid is omitted
  delete [uuid]         Delete a source; prompts to pick one if uuid is omitted. Asks to confirm first; pass a uuid with --yes to skip the prompt (for scripts)
  rotate-secret [uuid]  Rotate a provider source's signing secret; prompts to pick one if uuid is omitted
  test <uuid>           Preview signature verification and field mapping for a source against a sample payload, without a real delivery (pass --json for machine-readable output, --payload '<json object>' to test against a custom sample instead of the server's default)`;

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
// Which subcommands render JSON is decided once, by JSON_SUBCOMMANDS below.
const LIST_SUBCOMMAND = 'list';
const CREATE_SUBCOMMAND = 'create';
const UPDATE_SUBCOMMAND = 'update';
// `delete` is the only subcommand `--yes` applies to, so it's named for the
// guard that rejects the flag elsewhere as well as its handler-map key.
const DELETE_SUBCOMMAND = 'delete';
const ROTATE_SECRET_SUBCOMMAND = 'rotate-secret';
// `test` is non-interactive (it takes a required uuid, never a picker) and, like
// `list`, renders JSON — so it's the second subcommand `--json` applies to.
const TEST_SUBCOMMAND = 'test';

// The subcommands `--json` is meaningful for: `list` (renders a JSON array) and
// `test` (renders a JSON diagnostic). Every other subcommand is interactive or
// emits a one-off human result, so --json is rejected for them (see usageErrorFor).
const JSON_SUBCOMMANDS = new Set([LIST_SUBCOMMAND, TEST_SUBCOMMAND]);

// `list` acts on every source and `create` always prompts for its own
// details, so neither handler reads the `uuid` positional at all (see
// SOURCES_HANDLERS below) — a uuid-shaped argument given to either must fail
// loudly (see usageErrorFor) rather than being silently accepted and ignored.
const NO_UUID_SUBCOMMANDS = new Set([LIST_SUBCOMMAND, CREATE_SUBCOMMAND]);

const SOURCES_HANDLERS = new Map<
  string,
  (
    uuid: string | undefined,
    json: boolean,
    skipConfirm: boolean,
    payload: Record<string, unknown> | undefined,
  ) => Promise<void>
>([
  [LIST_SUBCOMMAND, (_uuid, json) => listSources(json)],
  [CREATE_SUBCOMMAND, () => createSourceCommand()],
  [UPDATE_SUBCOMMAND, (uuid) => updateSourceCommand(uuid)],
  [
    DELETE_SUBCOMMAND,
    (uuid, _json, skipConfirm) => deleteSourceCommand(uuid, skipConfirm),
  ],
  [ROTATE_SECRET_SUBCOMMAND, (uuid) => rotateSecretCommand(uuid)],
  [
    TEST_SUBCOMMAND,
    (uuid, json, _skipConfirm, payload) =>
      testSourceCommand(uuid, json, payload),
  ],
]);

// The message for the subcommand (if any) that can't complete without an
// interactive terminal — inquirer needs both stdin and stdout to be a TTY to
// render and read a prompt, so a redirected/non-interactive run would
// otherwise hang, or (for delete) abort via the swallowed-Ctrl+C path below
// yet still exit 0. `delete` is only guarded when `--yes` is absent (its
// documented escape hatch); `create` and `update` have no such flag — `create`
// always prompts, and `update` always prompts for the route folder (and, if
// accepted, field mapping), whether the target came from an explicit uuid or
// the interactive picker — so both are guarded outright. `rotate-secret`
// only prompts when no uuid is given (the picker), which is what's guarded
// here — its other prompt (a
// manual-secret provider's password) is guarded separately inside
// collectRotateInput, since the provider isn't known this early (see there).
const interactiveGuardMessageFor = (
  subcommand: string | undefined,
  uuid: string | undefined,
  skipConfirm: boolean,
): string | null => {
  if (subcommand === DELETE_SUBCOMMAND && !skipConfirm) {
    return `\`sources delete\` needs an interactive terminal to confirm; pass a uuid with --yes (\`markpost sources ${DELETE_SUBCOMMAND} <uuid> --yes\`) to delete without a prompt.`;
  }

  if (subcommand === CREATE_SUBCOMMAND) {
    return `\`sources ${CREATE_SUBCOMMAND}\` needs an interactive terminal — it always prompts for the source details.`;
  }

  if (subcommand === UPDATE_SUBCOMMAND) {
    return `\`sources ${UPDATE_SUBCOMMAND}\` needs an interactive terminal — it prompts for the route folder and field mapping, and to pick a source when no uuid is given.`;
  }

  if (subcommand === ROTATE_SECRET_SUBCOMMAND && !uuid) {
    return `\`sources ${ROTATE_SECRET_SUBCOMMAND}\` needs an interactive terminal to pick a source when no uuid is given; pass a uuid (\`markpost sources ${ROTATE_SECRET_SUBCOMMAND} <uuid>\`) to skip the picker — unless the source turns out to be a manual-secret provider (${MANUAL_SECRET_PROVIDERS.join(', ')}), which still prompts for the new secret and needs a terminal either way.`;
  }

  return null;
};

// Bridges --payload (a raw argv string) to `SourceTestInput.payload` (a
// parsed plain object). `JSON.parse`'s own error message can quote back
// characters from the input it rejected (e.g. an unexpected token), so it is
// sanitized here — the same untrusted-terminal-output risk `sanitizeForTerminal`
// guards everywhere else in this file, just sourced from argv instead of an
// API response.
const parseTestPayload = (raw: string): Record<string, unknown> => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `--payload must be valid JSON: ${sanitizeForTerminal(messageFromError(error))}`,
      { cause: error },
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `--payload must be a JSON object, e.g. --payload '{"foo":"bar"}'.`,
    );
  }

  return parsed as Record<string, unknown>;
};

// Parses --payload exactly once, up front, so both `usageErrorFor` (the
// message) and `testSourceCommand` (the value) read the same result instead
// of re-parsing.
const parsePayloadFlag = (
  payloadFlag: string | undefined,
): { payload?: Record<string, unknown>; error?: string } => {
  if (payloadFlag === undefined) {
    return {};
  }

  try {
    return { payload: parseTestPayload(payloadFlag) };
  } catch (error) {
    return { error: messageFromError(error) };
  }
};

// The invocation-level usage checks that all fail the same way (one usage
// message, non-zero exit). Returns the message to show, or null when the
// invocation is valid. Kept in one place so their ordering is a single unit
// rather than four near-identical guard blocks in the runner.
const usageErrorFor = (
  subcommand: string | undefined,
  uuid: string | undefined,
  json: boolean,
  skipConfirm: boolean,
  isInteractive: boolean,
  // Bundled into one object (rather than two adjacent `string | undefined`
  // positional args) so the two can't be silently swapped at the call site —
  // that would type-check either way and let a malformed --payload pass
  // validation.
  payloadInput: { flag: string | undefined; error: string | undefined },
): string | null => {
  const { flag: payloadFlag, error: payloadError } = payloadInput;
  // Reject --json where it does nothing rather than silently ignoring it:
  // `sources create --json | jq` would otherwise "succeed" with human text on
  // stdout, losing the one-time signing secret it was trying to capture.
  if (json && (subcommand === undefined || !JSON_SUBCOMMANDS.has(subcommand))) {
    return `--json is only supported by \`sources ${LIST_SUBCOMMAND}\` and \`sources ${TEST_SUBCOMMAND}\`.`;
  }

  // A stray positional past the subcommand itself, mistaken for a uuid —
  // `list`/`create` never read one (issue #218: silently accepting and
  // discarding it would be exactly the un-validated stray argument the
  // parseSourcesArgs's own third-positional check exists to catch). The
  // `subcommand !== undefined` half is only for the type checker: by the time
  // this runs the caller has already rejected a missing subcommand, via the
  // `!handler` guard.
  if (
    uuid !== undefined &&
    subcommand !== undefined &&
    NO_UUID_SUBCOMMANDS.has(subcommand)
  ) {
    return `\`sources ${subcommand}\` takes no arguments.`;
  }

  // `test` acts on exactly one source and never opens a picker, so it needs an
  // explicit uuid — mirroring the `--yes` delete contract. Checked before the
  // interactivity guard since it holds whether or not the terminal is a TTY.
  if (subcommand === TEST_SUBCOMMAND && !uuid) {
    return `\`sources ${TEST_SUBCOMMAND}\` requires a uuid: \`markpost sources ${TEST_SUBCOMMAND} <uuid>\`.`;
  }

  // --yes only skips the delete confirmation; reject it elsewhere so a
  // misplaced flag fails loudly instead of appearing to take effect.
  if (skipConfirm && subcommand !== DELETE_SUBCOMMAND) {
    return `--yes is only supported by \`sources ${DELETE_SUBCOMMAND}\`.`;
  }

  // --payload only makes sense for `test` (it's the sample the field mapping
  // is previewed against); reject it elsewhere for the same reason --yes is
  // rejected outside `delete`.
  if (payloadFlag !== undefined && subcommand !== TEST_SUBCOMMAND) {
    return `--payload is only supported by \`sources ${TEST_SUBCOMMAND}\`.`;
  }

  // `payloadError` is already the fully-formed message from `parsePayloadFlag`
  // — fail on it directly rather than re-parsing --payload here too. Checked
  // against `undefined`, not truthiness, so an (unexpected) empty-string
  // message still fails loud instead of silently passing validation.
  if (payloadError !== undefined) {
    return payloadError;
  }

  // --yes promises a non-interactive delete, so it needs an explicit uuid —
  // without one the picker still opens and a script blocks on it forever.
  if (skipConfirm && !uuid) {
    return `--yes requires a uuid: \`markpost sources ${DELETE_SUBCOMMAND} <uuid> --yes\`.`;
  }

  if (!isInteractive) {
    return interactiveGuardMessageFor(subcommand, uuid, skipConfirm);
  }

  return null;
};

// `parseArgs` keeps --json out of the uuid slot (so `sources delete --json`
// still prompts rather than trying to delete a source named "--json") and
// throws on an unknown/mistyped flag, which the caller's `parseOrFailWithUsage`
// surfaces as a `usage` error, not `fetch_failed` (issue #218, mirroring
// #208's fix to get.ts/export.ts/records.ts/events.ts). A third positional —
// `uuid` is the only one any subcommand takes — is likewise a stray argument
// and must fail loudly rather than being silently discarded.
const parseSourcesArgs = (
  args: string[],
): {
  subcommand: string | undefined;
  uuid: string | undefined;
  skipConfirm: boolean;
  payloadFlag: string | undefined;
} => {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      yes: { type: 'boolean' },
      payload: { type: 'string' },
    },
  });

  if (positionals.length > 2) {
    throw new Error(`Unexpected argument "${positionals[2]}".`);
  }

  const [subcommand, uuid] = positionals;

  return {
    subcommand,
    uuid,
    skipConfirm: Boolean(values.yes),
    payloadFlag: values.payload,
  };
};

export const runSourcesCommand = async (args: string[]): Promise<void> => {
  // Read `--json` straight from argv so every failure below is rendered in
  // whichever contract the caller asked for, even one thrown before parsing.
  const json = hasJsonFlag(args);

  // Parsed before the config check and the handler dispatch below (see
  // parseSourcesArgs above for why a throw here is a usage error).
  const parsed = parseOrFailWithUsage(
    () => parseSourcesArgs(args),
    USAGE,
    json,
  );

  if (!parsed) {
    return;
  }

  const { subcommand, uuid, skipConfirm, payloadFlag } = parsed;
  // Parsed exactly once, ahead of both the usage check and the handler call —
  // see `parsePayloadFlag`.
  const { payload, error: payloadError } = parsePayloadFlag(payloadFlag);
  // `subcommand` is `undefined` for a bare `sources` invocation (no
  // positionals at all) — `Map.get` needs a `string` key, and no subcommand
  // is ever named the empty string, so it's a safe stand-in that still misses
  // the lookup exactly like `undefined` would.
  const handler = SOURCES_HANDLERS.get(subcommand ?? '');

  // Validate before the config check so a bad subcommand fails on usage
  // alone, without needing a configured account. The bad-subcommand case
  // fails differently (it prints the subcommand), so it stays here; the rest
  // share one usage-error shape and live in `usageErrorFor`.
  if (!handler) {
    failWithSubcommandUsage(subcommand, USAGE, json);
    return;
  }

  // A prompt needs both streams to be a terminal: inquirer reads stdin and
  // renders to stdout, so a redirect on either makes create/update/delete's
  // prompts (and rotate-secret's picker) unanswerable.
  const isInteractive = isInteractiveTerminal();
  const usageError = usageErrorFor(
    subcommand,
    uuid,
    json,
    skipConfirm,
    isInteractive,
    { flag: payloadFlag, error: payloadError },
  );

  if (usageError) {
    failWithUsage(usageError, USAGE, json);
    return;
  }

  try {
    if (!(await checkConfig(json))) {
      return;
    }

    await handler(uuid, json, skipConfirm, payload);
  } catch (error) {
    // A deliberate Ctrl+C at a prompt throws @inquirer's `ExitPromptError`;
    // that's a user abort, not a command failure, so don't flag it non-zero.
    if (error instanceof Error && error.name === 'ExitPromptError') {
      return;
    }

    // Sanitize — an error surfaced from a sources API call can be
    // server-derived and carry a terminal escape.
    failWithMessage(sanitizeForTerminal(String(error)), json);
  }
};

const PROVIDER_SECRET_NOTICE =
  'Signing secret (shown once — copy it now, it cannot be retrieved later):';

// markpost reveals the generated signing secret exactly once — in the create
// response for a secret-backed provider (github/zapier/shortcuts). It is null
// everywhere else, so this only surfaces a non-empty value, and only from
// `create` (never list/update, which is why it lives outside `printSource`).
const printProviderSecret = (
  providerSecret: string | null | undefined,
): void => {
  if (!providerSecret) {
    return;
  }

  console.log('');
  console.log(chalk.yellowBright(`  ${PROVIDER_SECRET_NOTICE}`));
  // The secret is untrusted API output like every other field printSource
  // handles, so it's sanitized too — lossless for a real signing secret, which
  // never carries control bytes, but it stops a hostile response overwriting
  // the "copy it now" warning above with a CSI payload.
  console.log(chalk.bold(`  ${sanitizeForTerminal(providerSecret)}`));
};

// Every field here comes from the untrusted API response, so each is stripped
// of control/ANSI escapes before printing (see terminal.ts): name, uuid, type,
// endpoint (built from endpointSlug), routeFolder, recordCount, and lastHitAt.
// recordCount is typed as a number but the type is only a compile-time claim
// over parsed JSON — a hostile server could return a string carrying an escape,
// so it goes through the sanitizer too (which coerces non-strings). The
// 'never hit' fallback is a local literal, so only the untrusted lastHitAt
// branch is sanitized.
const printFieldMapping = (
  fieldMapping: FieldMappingConfig | null | undefined,
): void => {
  const configuredKeys = FIELD_MAPPING_KEYS.filter((key) =>
    Boolean(fieldMapping?.[key]),
  );

  if (configuredKeys.length === 0) {
    return;
  }

  console.log('  mapping:');
  configuredKeys.forEach((key) => {
    console.log(
      `    ${key}: ${sanitizeForTerminal(fieldMapping?.[key] as string)}`,
    );
  });
};

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
  printFieldMapping(source.fieldMapping);
  console.log(`  records:   ${sanitizeForTerminal(source.recordCount)}`);
  console.log(
    `  last hit:  ${source.lastHitAt ? sanitizeForTerminal(source.lastHitAt) : 'never hit'}`,
  );
};

// The JSON view of a source: the Source contract fields plus the computed
// `endpoint` so consumers get the same ingest URL the pretty output shows
// without re-deriving it. Fields are enumerated (not spread) on purpose — a
// spread would carry a `providerSecret` if a malformed/hostile list response
// ever attached one, and list must never surface that one-time secret (only
// `create` does). This whitelist is what keeps the JSON path as safe as the
// pretty printer, which likewise names each field it prints. The record JSON
// paths (`get`, `records list`) intentionally pass the whole record through
// instead: a record carries no secret sibling field, and a faithful passthrough
// keeps new server fields visible rather than silently dropping them. The
// `Required<Source> & { endpoint: string }` return type makes a future Source
// field — required or optional — fail the build here until it is deliberately
// included or excluded.
const serializeSourceForJson = (
  source: Source,
): Required<Source> & { endpoint: string } => ({
  uuid: source.uuid,
  createdAt: source.createdAt,
  type: source.type,
  name: source.name,
  provider: source.provider,
  endpointSlug: source.endpointSlug,
  endpoint: buildEndpointUrl(source.type, source.endpointSlug),
  routeFolder: source.routeFolder,
  fieldMapping: source.fieldMapping ?? null,
  lastHitAt: source.lastHitAt,
  recordCount: source.recordCount,
});

const listSources = async (json: boolean): Promise<void> => {
  const sources = await fetchSources();

  // JSON mode prints the array (empty included, as `[]`) with no "No sources
  // found." line so the stdout stays valid JSON for `jq`.
  if (json) {
    printJson(sources.map(serializeSourceForJson));
    return;
  }

  if (sources.length === 0) {
    console.log('No sources found.');
    return;
  }

  sources.forEach(printSource);
};

// One prompt per key markpost's field-mapping contract recognizes (see
// FIELD_MAPPING_KEYS in src/types/sources.types.ts), in the same order
// markpost's own FieldMappingModal.vue presents them. Answers are collected
// first and filtered after the loop (rather than branching inside it) so a
// blank answer is dropped without nesting an `if` inside the `for` — matching
// the server's own normalization (server/utils/fieldMappingValidation.ts's
// normalizeAndValidate), which likewise drops anything blank rather than
// storing it.
const collectFieldMapping = async (
  current: FieldMappingConfig | null = null,
): Promise<FieldMappingConfig> => {
  const answers: [FieldMappingKey, string][] = [];

  for (const key of FIELD_MAPPING_KEYS) {
    const value = (
      await input({
        message: `Field mapping: ${key} (dot path into the raw ingest payload, e.g. "data.subject") — blank to skip`,
        default: current?.[key],
      })
    ).trim();

    answers.push([key, value]);
  }

  return Object.fromEntries(
    answers.filter(([, value]) => value.length > 0),
  ) as FieldMappingConfig;
};

// Field mapping is optional and easy to configure later via `sources update`,
// so it stays behind an explicit opt-in rather than always asking six more
// questions up front. Returns undefined when declined *or* when every answer
// came back blank — markpost's PATCH/POST handlers treat a supplied
// fieldMapping as the complete replacement for whatever is stored (there is
// no per-key merge; see server/api/sources/[uuid].patch.ts and
// server/utils/fieldMappingValidation.ts), so an all-blank result must read
// as "nothing to change" rather than as a deliberate clear-to-null — the
// opt-in's whole point is to leave an untouched mapping alone when nothing
// is actually typed. Omitting the attribute entirely lets `create` fall back
// to markpost's own `attributes.fieldMapping ?? null` default, and lets
// `update` leave whatever is already stored untouched (see
// server/api/sources/[uuid].patch.ts's `"fieldMapping" in attributes` check).
// Re-accepting every prefilled default yields the stored mapping verbatim;
// that is "nothing to change", not a PATCH worth sending.
const isSameFieldMapping = (
  next: FieldMappingConfig,
  current: FieldMappingConfig | null,
): boolean =>
  FIELD_MAPPING_KEYS.every(
    (key) => (next[key] ?? '') === (current?.[key] ?? ''),
  );

const promptFieldMapping = async (
  confirmMessage: string,
  current: FieldMappingConfig | null = null,
): Promise<FieldMappingConfig | undefined> => {
  const configureFieldMapping = await confirm({
    message: confirmMessage,
    default: false,
  });

  if (!configureFieldMapping) {
    return undefined;
  }

  const fieldMapping = await collectFieldMapping(current);

  if (
    Object.keys(fieldMapping).length === 0 ||
    isSameFieldMapping(fieldMapping, current)
  ) {
    return undefined;
  }

  return fieldMapping;
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
  const fieldMapping = await promptFieldMapping(
    'Configure field mapping now? (maps ingest payload fields to title/content/etc — optional, can be set later with `sources update`)',
  );

  const created = await createSource({
    type,
    name,
    routeFolder,
    provider: provider || undefined,
    ...(fieldMapping !== undefined ? { fieldMapping } : {}),
  });

  if (!created) {
    // A secret-backed source may still have been created server-side with its
    // one-time secret in the response the CLI just discarded; that secret is
    // now unrecoverable, so point the user at how to recover deliberately
    // rather than letting a blind retry orphan a source.
    console.error(
      chalk.redBright(
        'Failed to create source. Run `markpost sources list` to check whether it was created anyway — if it was, its one-time signing secret is unrecoverable, so delete and recreate the source to mint a new one.',
      ),
    );
    return;
  }

  // Peel the one-time secret off before handing the rest to the shared
  // `printSource`, so the secret physically isn't on the object any list/update
  // printer ever receives.
  const { providerSecret, ...source } = created;

  console.log(
    chalk.greenBright(`Created source "${sanitizeForTerminal(source.name)}"`),
  );
  printSource(source);
  printProviderSecret(providerSecret);
};

// Shared by update, delete, and rotate-secret: list existing sources and let
// the user pick one, or report there's nothing to act on. `filter` narrows the
// choices to the sources an action can apply to (rotate-secret only offers
// provider-backed sources); it defaults to every source for update/delete.
// `emptyFilteredMessage` replaces the generic "no sources" line when sources
// exist but the filter removed all of them — so a user with only webhook/email
// sources learns rotate-secret needs a provider source, instead of being told
// they have none at all.
const promptForSource = async (
  action: string,
  filter: (source: Source) => boolean = () => true,
  emptyFilteredMessage?: string,
): Promise<Source | null> => {
  const allSources = await fetchSources();
  const sources = allSources.filter(filter);

  if (sources.length === 0) {
    const filteredOutSome = allSources.length > 0;
    console.log(
      filteredOutSome && emptyFilteredMessage
        ? emptyFilteredMessage
        : `No sources to ${action}.`,
    );
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

// Fetch the source list and pick one out by uuid, or null if none matches.
// fetchSources() swallows transport errors (except a timeout, which
// propagates) into [], so a missing uuid is indistinguishable here from a
// failed load. Shared by the reporting `findSourceByUuid` and the best-effort
// delete label so the fetch+find isn't written three ways.
const lookupSourceByUuid = async (uuid: string): Promise<Source | null> => {
  const sources = await fetchSources();
  return sources.find((candidate) => candidate.uuid === uuid) ?? null;
};

const findSourceByUuid = async (uuid: string): Promise<Source | null> => {
  const source = await lookupSourceByUuid(uuid);

  if (source) {
    return source;
  }

  console.error(
    chalk.redBright(
      'Source not found, or the source list could not be loaded.',
    ),
  );

  return null;
};

// Prompts for both updatable attributes and sends whichever actually
// changed in one PATCH. The field-mapping prompt prefills each key with the
// stored value (`Source.fieldMapping`), so accepting a default keeps that key;
// a supplied mapping still fully replaces (never merges with) whatever is
// there already (see promptFieldMapping). Declining the opt-in, accepting it
// and leaving every field blank, or re-accepting every stored value all leave
// the stored mapping untouched.
const promptAndApplyUpdates = async (target: Source): Promise<void> => {
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

  const routeFolderChanged = routeFolder !== target.routeFolder;
  const fieldMapping = await promptFieldMapping(
    'Update field mapping now? (maps ingest payload fields to title/content/etc — each field is prefilled with the stored value and the result replaces the entire stored mapping; decline to keep it as is)',
    target.fieldMapping,
  );

  // Covers both "nothing typed differs" (route folder re-accepted as-is,
  // field mapping declined) and "field mapping was offered but left blank" —
  // either way there is nothing to send.
  if (!routeFolderChanged && fieldMapping === undefined) {
    console.log('Nothing to update: route folder and field mapping unchanged.');
    return;
  }

  const updateInput: UpdateSourceInput = {
    ...(routeFolderChanged ? { routeFolder } : {}),
    ...(fieldMapping !== undefined ? { fieldMapping } : {}),
  };

  const source = await updateSource(target.uuid, updateInput);

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

  await promptAndApplyUpdates(target);
};

// Deleting a source is irreversible: it drops the ingest config and the
// one-time signing secret, which can never be retrieved again. The label is
// sanitized because it may have come from an untrusted API response via the
// interactive picker. Defaults to "no" so a bare Enter cancels rather than
// deletes. Isolated here so the delete flow stays unit-testable by mocking the
// prompt.
const confirmDeletion = async (label: string): Promise<boolean> =>
  confirm({
    message: `Delete source ${sanitizeForTerminal(
      label,
    )}? This drops its ingest config and one-time signing secret and cannot be undone.`,
    default: false,
  });

// An empty list from lookupSourceByUuid can't tell a genuine non-match from a
// swallowed load failure — fetchSources() folds transport errors (all but a
// timeout) into []. So this can't claim the source is absent; it mirrors
// findSourceByUuid's wording and leaves both possibilities open.
const NO_MATCH_NOTE =
  'no matching source found, or the list could not be loaded';
// The lookup itself failed (e.g. a timeout, which fetchSources re-throws), so
// the name is simply unknown — distinct from a confirmed non-match, and never
// claiming the source doesn't exist.
const LOOKUP_FAILED_NOTE = 'source name unavailable — could not load the list';

// Build the confirmation label. The interactive pick already carries the
// Source; a bare-uuid delete looks the source up so the prompt names it —
// surfacing a wrong-but-valid (or non-existent) copy-pasted uuid before it
// destroys anything, rather than echoing back the exact string the user typed.
// The lookup is purely cosmetic, so it's best-effort: any failure falls back to
// the bare uuid rather than blocking a delete that would otherwise succeed. The
// three outcomes stay distinct in the label so a failed load is never
// mis-reported as a confirmed non-match. `undefined` marks a thrown lookup,
// `null` a loaded-but-missing one.
const deleteConfirmationLabel = async (
  picked: Source | null | undefined,
  targetUuid: string,
): Promise<string> => {
  if (picked) {
    return `${picked.name} (${targetUuid})`;
  }

  const source = await lookupSourceByUuid(targetUuid).catch(() => undefined);

  if (source === undefined) {
    return `${targetUuid} (${LOOKUP_FAILED_NOTE})`;
  }

  return source
    ? `${source.name} (${targetUuid})`
    : `${targetUuid} (${NO_MATCH_NOTE})`;
};

// Compose label-building with the prompt into one named step so the call site
// reads as a sentence; the `||` at the call site is what short-circuits this
// away (label lookup included) under `--yes`.
const confirmSourceDeletion = async (
  picked: Source | null | undefined,
  targetUuid: string,
): Promise<boolean> =>
  confirmDeletion(await deleteConfirmationLabel(picked, targetUuid));

const deleteSourceCommand = async (
  uuid: string | undefined,
  skipConfirm: boolean,
): Promise<void> => {
  const picked = uuid ? undefined : await promptForSource('delete');
  // `||` (not `??`) so an empty-string uuid falls through to the picked source,
  // matching the truthiness branch above — otherwise `delete ""` would open the
  // picker, take a selection, then silently discard it on the `!targetUuid` guard.
  const targetUuid = uuid || picked?.uuid;

  if (!targetUuid) {
    return;
  }

  const confirmed =
    skipConfirm || (await confirmSourceDeletion(picked, targetUuid));

  if (!confirmed) {
    console.log('Deletion cancelled.');
    return;
  }

  const meta = await deleteSource(targetUuid);

  if (!meta) {
    // Exit non-zero (not a bare console.error) so a scripted `delete <uuid>
    // --yes || notify` catches a failed delete instead of reading it as done —
    // delete now carries a documented --yes contract, like rotate-secret below.
    failWithMessage('Failed to delete source.');
    return;
  }

  console.log(chalk.greenBright(`Deleted ${meta.deleted} source(s).`));
};

// A manual-secret provider (stripe) issues its own secret, so rotation collects
// the new value from the user; a generated provider (github/zapier/shortcuts)
// sends no attributes and lets markpost mint one. Returns null when the secret
// can't be collected: either a blank answer (reported via console.error, exit
// 0 — a deliberate user choice, mirrors updateSource's empty-route-folder
// guard) or a non-interactive terminal (reported via failWithMessage, exit 1
// — the environment could never have answered the prompt at all).
const collectRotateInput = async (
  target: Source,
): Promise<RotateSourceSecretInput | null> => {
  if (!isManualSecretProvider(target.provider)) {
    return {};
  }

  // The provider isn't known until fetchSources resolves, so this guard sits
  // here rather than in usageErrorFor (see the function header above for why
  // it fails via failWithMessage instead of the empty-secret check's plain
  // console.error).
  if (!isInteractiveTerminal()) {
    failWithMessage(
      `\`sources ${ROTATE_SECRET_SUBCOMMAND}\` needs an interactive terminal to enter the new signing secret for "${sanitizeForTerminal(
        target.provider,
      )}" — both stdin and stdout must be a terminal.`,
    );
    return null;
  }

  // Masked: this is the one place the CLI accepts a signing secret, so it must
  // not echo it into terminal scrollback, `script`/tmux captures, or CI logs.
  const providerSecret = (
    await password({
      message: `New signing secret from ${sanitizeForTerminal(target.provider)}`,
      mask: true,
    })
  ).trim();

  if (!providerSecret) {
    console.error(chalk.redBright('Signing secret cannot be empty.'));
    return null;
  }

  return { providerSecret };
};

const rotateSecretForSource = async (target: Source): Promise<void> => {
  if (!isRotatableProvider(target.provider)) {
    console.error(
      chalk.redBright(
        `Source "${sanitizeForTerminal(target.name)}" has no rotatable secret — only ${ROTATABLE_PROVIDERS.join(', ')} sources do.`,
      ),
    );
    return;
  }

  const rotateInput = await collectRotateInput(target);

  if (!rotateInput) {
    return;
  }

  const rotated = await rotateSourceSecret(target.uuid, rotateInput);

  if (!rotated) {
    // Exit non-zero (via failWithMessage) so a wrapper script/cron never reads
    // a failed rotation as success. Unlike a failed create (nothing depended on
    // the source yet), a failed rotate may already have committed server-side —
    // a 5xx or unparseable body after the secret was replaced — leaving the old
    // secret dead, so warn conditionally rather than implying nothing changed.
    failWithMessage(
      'Failed to rotate source secret. If the rotation was applied server-side the previous secret no longer works — run `markpost sources rotate-secret <uuid>` again to mint a secret you can copy.',
    );
    return;
  }

  // Peel the one-time secret off before the shared `printSource`, exactly as
  // `createSourceCommand` does, so no printer that receives the source ever
  // sees it. It is null for a manual-secret provider (the user already has it).
  const { providerSecret, ...source } = rotated;
  const isManual = isManualSecretProvider(target.provider);

  // A generated provider's whole point is the one-time reveal; a response that
  // omits it means the secret was rotated but is now unrecoverable, so the live
  // integration is broken. Fail before printing any success line, so stdout
  // never ends on "Rotated ..." for a broken integration.
  if (!isManual && !providerSecret) {
    failWithMessage(
      'The secret was rotated but the server did not return it — the previous secret no longer works. Run `markpost sources rotate-secret <uuid>` again to mint one you can copy.',
    );
    return;
  }

  console.log(
    chalk.greenBright(
      `Rotated signing secret for "${sanitizeForTerminal(source.name)}"`,
    ),
  );
  printSource(source);

  // Reveal only for a generated provider. A manual provider (stripe) issues its
  // own secret — the user already has it — and an off-contract echo of it must
  // never be printed, so suppress the reveal entirely here.
  if (isManual) {
    return;
  }

  printProviderSecret(providerSecret);
};

const rotateSecretCommand = async (uuid?: string): Promise<void> => {
  const target = uuid
    ? await findSourceByUuid(uuid)
    : await promptForSource(
        'rotate the secret for',
        (source) => isRotatableProvider(source.provider),
        `None of your sources have a rotatable secret — only ${ROTATABLE_PROVIDERS.join(', ')} sources do.`,
      );

  if (!target) {
    return;
  }

  await rotateSecretForSource(target);
};

// A `Map`, not an object literal keyed by server-derived text — same reason
// `SOURCES_HANDLERS` above uses one: a `"__proto__"`/`"toString"` status would
// otherwise resolve a real prototype member instead of `undefined`. A pass is
// green, a rejection red, the two inconclusive states yellow, and an
// unrecognized status also falls back to yellow (see colorizeSignatureStatus).
const SIGNATURE_STATUS_COLORS = new Map<
  SourceTestSignatureStatus,
  (text: string) => string
>([
  ['verified', chalk.greenBright],
  ['failed', chalk.redBright],
  ['not_required', chalk.yellowBright],
  ['not_verifiable', chalk.yellowBright],
]);

const colorizeSignatureStatus = (
  status: SourceTestSignatureStatus | undefined,
  displayText: string,
): string => {
  const colorize = status ? SIGNATURE_STATUS_COLORS.get(status) : undefined;

  return (colorize ?? chalk.yellowBright)(displayText);
};

// Every field here is untrusted API output, so each is stripped of control/ANSI
// escapes before printing (see terminal.ts), exactly as `printSource` does.
// `content` is coerced to a single line by the single-line sanitizer, which is
// fine for a preview. `frontmatter` is `unknown`, so it's JSON-stringified
// first, then sanitized (an object value could itself carry an escape).
// `signatureCheck`/`fieldMapping` are guaranteed present by the caller's drift
// guard (see `testSourceCommand`); `tags` is still checked here since a
// reshaped-but-present field is a smaller, more plausible drift than the
// whole object vanishing.
//
// This always exits 0 regardless of `signatureCheck.status` — `test` is a
// diagnostic preview (like `list`/`get`), not a pass/fail gate. A `failed` or
// `not_verifiable` result is a legitimate, successfully-reported outcome; the
// caller distinguishes them by reading the colored/JSON status, not the exit
// code.
const printTestResult = (result: SourceTestResult): void => {
  const { signatureCheck, fieldMapping } = result;
  const tags = Array.isArray(fieldMapping.tags) ? fieldMapping.tags : [];

  console.log(
    `Provider:       ${sanitizeForTerminal(result.provider ?? 'none')}`,
  );
  console.log(
    `Sample payload: ${sanitizeForTerminal(JSON.stringify(result.payload))}`,
  );
  console.log(
    chalk.bold(
      `Signature check: ${colorizeSignatureStatus(
        signatureCheck.status,
        sanitizeForTerminal(signatureCheck.status),
      )}`,
    ),
  );
  console.log(`  ${sanitizeForTerminal(signatureCheck.message)}`);
  console.log('');
  console.log(chalk.bold('Field mapping preview:'));
  console.log(`  title:       ${sanitizeForTerminal(fieldMapping.title)}`);
  console.log(`  content:     ${sanitizeForTerminal(fieldMapping.content)}`);
  console.log(`  tags:        ${sanitizeForTerminal(tags.join(', '))}`);
  console.log(`  file path:   ${sanitizeForTerminal(fieldMapping.filePath)}`);
  console.log(
    `  frontmatter: ${sanitizeForTerminal(JSON.stringify(fieldMapping.frontmatter))}`,
  );
};

const testSourceCommand = async (
  uuid: string | undefined,
  json: boolean,
  payload: Record<string, unknown> | undefined,
): Promise<void> => {
  // usageErrorFor already rejects a missing uuid before any handler runs; this
  // guard keeps the type honest and fails loud rather than silently if that
  // ordering ever regresses.
  if (!uuid) {
    failWithMessage(`\`sources ${TEST_SUBCOMMAND}\` requires a uuid.`, json);
    return;
  }

  // Omit the second argument entirely when --payload wasn't given (rather
  // than passing `{}`), matching `SourceTestInput`'s contract: the server
  // falls back to its own default sample only when `payload` is absent, not
  // merely falsy.
  const result =
    payload !== undefined
      ? await testSource(uuid, { payload })
      : await testSource(uuid);

  if (!result) {
    failWithMessage('Failed to test source.', json);
    return;
  }

  // Declared required, but that's only a compile-time claim over parsed
  // JSON — a drifted/malformed 200 response omitting either would otherwise
  // render as a clean, exit-0 preview of blank fields. Distinct message from
  // the `!result` case above: the request succeeded, the response shape
  // didn't — pointing a script at the server instead of its own network/token.
  if (!result.signatureCheck || !result.fieldMapping) {
    failWithMessage(
      'The test ran, but the server returned an unexpected result (missing signatureCheck or fieldMapping).',
      json,
    );
    return;
  }

  // The test result carries no one-time secret (unlike create/rotate-secret),
  // so it is surfaced in full — a faithful passthrough keeps any new server
  // field visible, matching the `get`/`records list` JSON paths rather than
  // list's secret-guarding field whitelist.
  if (json) {
    printJson(result);
    return;
  }

  printTestResult(result);
};
