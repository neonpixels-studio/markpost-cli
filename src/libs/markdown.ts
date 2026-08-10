import {
  writeFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import {
  basename,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';
import slugify from '@sindresorhus/slugify';
import { config } from '@/libs/config.js';
import {
  buildRecordDocument,
  stripFrontmatterDocument,
} from '@/libs/frontmatter.js';
import { Record } from '@/types/records.types.js';
import {
  ConflictStrategy,
  DEFAULT_CONFLICT_STRATEGY,
} from '@/types/settings.types.js';

const MARKDOWN_EXTENSION = '.md';
const FIRST_COLLISION_SUFFIX = 2;
// Give up rather than loop forever if a directory somehow has this many
// same-slug files already; something else is wrong at that point. Exported
// so tests can assert against it instead of duplicating the literal.
export const MAX_COLLISION_SUFFIX = 1000;
// Last-resort filename stem when both the title and its fallback (the
// record's uuid) slugify to nothing at all.
const UNTITLED_SLUG = 'untitled';
// node:fs exclusive-write flag: fail instead of silently overwriting when
// the target path already exists.
const EXCLUSIVE_WRITE_FLAG = 'wx';
const FILE_ALREADY_EXISTS_ERROR_CODE = 'EEXIST';

const getOutputDirectory = () => {
  return (
    process.env.OUTPUT_DIRECTORY ?? (config.get('outputDirectory') as string)
  );
};

// Slugify the title so it is always a single, safe path segment. Falls back
// to the record's uuid when the title has no sluggable characters at all
// (e.g. symbols-only, or non-Latin text the slugifier can't transliterate),
// so distinct empty-slug records stay traceable to their source record
// instead of all collapsing into the same bucket. The fallback is slugified
// too: it is API-controlled data, not a value we can trust to already be a
// safe path segment.
const slugifyTitle = (title: string, fallbackSlug: string): string => {
  return slugify(title) || slugify(fallbackSlug) || UNTITLED_SLUG;
};

// Resolve `fileName` against `outputDirectory` and verify the result is
// still inside it. Slugifying the title already strips path separators and
// `..` segments, but this is a second, independent guard against writing
// outside outputDirectory rather than trusting slugification alone.
const resolveWithinOutputDirectory = (
  outputDirectory: string,
  fileName: string,
): string => {
  const resolvedDirectory = resolve(outputDirectory);
  const resolvedPath = resolve(resolvedDirectory, fileName);
  const relativePath = relative(resolvedDirectory, resolvedPath);
  const escapesDirectory =
    relativePath === '..' || relativePath.startsWith(`..${sep}`);
  const isWithinDirectory =
    relativePath !== '' && !escapesDirectory && !isAbsolute(relativePath);

  if (!isWithinDirectory) {
    throw Error(`Refusing to write outside output directory: ${fileName}`);
  }

  return resolvedPath;
};

const isFileAlreadyExistsError = (error: unknown): boolean => {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === FILE_ALREADY_EXISTS_ERROR_CODE
  );
};

// Two records can slugify to the same title. Rather than silently
// overwriting one, try `<slug>`, `<slug>-2`, `<slug>-3`, ... until a write
// actually succeeds, so every record keeps its own file. The write uses the
// exclusive-create flag so the "is this path free?" check and the write
// itself are one atomic filesystem operation instead of two separate steps
// with a race between them.
const writeToFirstAvailablePath = (
  outputDirectory: string,
  slug: string,
  content: string,
): string => {
  let candidateFileName = `${slug}${MARKDOWN_EXTENSION}`;
  let suffix = FIRST_COLLISION_SUFFIX;

  while (suffix <= MAX_COLLISION_SUFFIX) {
    const candidatePath = resolveWithinOutputDirectory(
      outputDirectory,
      candidateFileName,
    );

    try {
      writeFileSync(candidatePath, content, { flag: EXCLUSIVE_WRITE_FLAG });
      return candidatePath;
    } catch (error) {
      if (!isFileAlreadyExistsError(error)) {
        throw error;
      }
    }

    candidateFileName = `${slug}-${suffix}${MARKDOWN_EXTENSION}`;
    suffix += 1;
  }

  throw Error(
    `Too many filename collisions for "${slug}" in ${outputDirectory}`,
  );
};

// `overwrite` strategy: replace whatever is at `<slug>.md` with this record.
// Remove any existing entry first, then exclusively create a fresh regular
// file. `rmSync` acts on the link itself, so a symlink is unlinked (its
// target outside the vault is left untouched) and a hardlink loses only this
// name (the shared inode is never truncated) — that's what stops an
// `overwrite` write from following a planted link out of the vault, since
// `resolveWithinOutputDirectory` only guards the string path. Recreating with
// the exclusive flag means that if something races a new entry into the gap,
// the write fails (EEXIST) rather than following it. No collision loop — the
// user has opted into the newest record winning a slug clash.
const writeOverwriting = (
  outputDirectory: string,
  slug: string,
  content: string,
): string => {
  const candidatePath = resolveWithinOutputDirectory(
    outputDirectory,
    `${slug}${MARKDOWN_EXTENSION}`,
  );

  rmSync(candidatePath, { force: true });
  writeFileSync(candidatePath, content, { flag: EXCLUSIVE_WRITE_FLAG });

  return candidatePath;
};

// `skip` strategy: write `<slug>.md` only if nothing is there yet. Uses the
// exclusive-create flag so the existence check and the write are one atomic
// operation, then returns `null` on an EEXIST collision to signal the record
// was intentionally left unwritten (the caller must not delete a record it
// never persisted). Any other error still propagates.
const writeIfAbsent = (
  outputDirectory: string,
  slug: string,
  content: string,
): string | null => {
  const candidatePath = resolveWithinOutputDirectory(
    outputDirectory,
    `${slug}${MARKDOWN_EXTENSION}`,
  );

  try {
    writeFileSync(candidatePath, content, { flag: EXCLUSIVE_WRITE_FLAG });
    return candidatePath;
  } catch (error) {
    if (isFileAlreadyExistsError(error)) {
      return null;
    }

    throw error;
  }
};

// One writer per conflict strategy, dispatched by the user's markpost
// preference. A Map keeps dispatch in one place (mirroring the command
// dispatch in index.ts) instead of a switch that has to be kept exhaustive
// by hand. `null` in the return union is the `skip`-collision signal.
const STRATEGY_WRITERS = new Map<
  ConflictStrategy,
  (outputDirectory: string, slug: string, content: string) => string | null
>([
  ['suffix', writeToFirstAvailablePath],
  ['overwrite', writeOverwriting],
  ['skip', writeIfAbsent],
]);

// `overwrite` truncates whatever is at `<slug>.md`. That's the intended
// behavior against a file left by a *previous* run, and against the *same*
// record re-written in a later autoSync pass (a record whose server delete or
// mark-synced failed is left pending and re-fetched, so it must overwrite its
// own file, not spawn a duplicate). But two *different* records that slugify
// identically must not clobber each other — the caller deletes every written
// record from the server, so the clobbered one would be lost everywhere. So the
// downgrade to `suffix` keys on ownership: `seenSlugs` maps each written slug to
// the uuid that first claimed it, and only a *different* uuid landing on an
// already-claimed slug falls back to suffix. Only `overwrite` needs this:
// `suffix` and `skip` both use the exclusive flag, so a real on-disk collision
// already routes them safely.
const resolveStrategyForSlug = (
  conflictStrategy: ConflictStrategy,
  slug: string,
  recordUuid: string,
  seenSlugs: Map<string, string>,
): ConflictStrategy => {
  const claimedByOtherRecord =
    seenSlugs.has(slug) && seenSlugs.get(slug) !== recordUuid;

  if (conflictStrategy === 'overwrite' && claimedByOtherRecord) {
    return 'suffix';
  }

  return conflictStrategy;
};

// Batch-wide precondition for writing: the output directory must be configured
// and must exist. Both failures (unset config, an un-creatable/read-only path)
// doom every record in a sync, not just one file. A caller looping over records
// calls this once up front and lets it throw, so a systemic failure that's
// already present at the start of a sync surfaces once — not miscounted as N
// identical per-record failures. writeMarkdown still calls it per record so it
// stays self-contained and correct when used on its own; after the up-front
// call created the directory, the per-record existsSync is true and mkdirSync
// does not run again. Returns the resolved directory.
export const ensureOutputDirectory = (): string => {
  const outputDirectory = getOutputDirectory();

  if (!outputDirectory) {
    throw Error('Output directory is not set!');
  }

  if (!existsSync(outputDirectory)) {
    mkdirSync(outputDirectory, { recursive: true });
  }

  return outputDirectory;
};

// Returns the resolved path written to, or `null` when the `skip` strategy
// left an existing file untouched. Defaults to `suffix` (markpost's own
// default) when no strategy is supplied. `seenSlugs` maps each written slug to
// the uuid that first claimed it; the caller threads it across a batch AND
// across autoSync passes so `overwrite` can't lose two different same-slug
// records while still letting a record re-overwrite its own file (see
// resolveStrategyForSlug). `includeFrontmatter` is the user's `frontmatter`
// setting; when off the file is written without a frontmatter block (see
// buildRecordDocument).
export const writeMarkdown = (
  record: Record,
  conflictStrategy: ConflictStrategy = DEFAULT_CONFLICT_STRATEGY,
  seenSlugs: Map<string, string> = new Map(),
  includeFrontmatter = true,
): string | null => {
  const outputDirectory = ensureOutputDirectory();

  const slug = slugifyTitle(record.title, record.uuid);
  const content = buildRecordDocument(record, includeFrontmatter);
  const effectiveStrategy = resolveStrategyForSlug(
    conflictStrategy,
    slug,
    record.uuid,
    seenSlugs,
  );
  const writer =
    STRATEGY_WRITERS.get(effectiveStrategy) ?? writeToFirstAvailablePath;

  const writtenPath = writer(outputDirectory, slug, content);
  // First claimant of a slug owns it: never reassign, or a suffixed second
  // record would steal ownership and force the original to suffix on its retry.
  // Only an actual write claims ownership — a `skip` collision returns null
  // (nothing written), so it must not claim a slug it doesn't own on disk, which
  // would wrongly downgrade a genuinely different record if the user later
  // switches the strategy to `overwrite`.
  if (writtenPath !== null && !seenSlugs.has(slug)) {
    seenSlugs.set(slug, record.uuid);
  }

  return writtenPath;
};

// Used by the push command to create a new record from a local file: the
// title comes from the filename (no extension). Note this is the filename
// as written on disk, which may be a slug rather than the original title
// if the file was previously pulled down by writeMarkdown.
//
// A file previously pulled by writeMarkdown carries the frontmatter block and
// `# ` heading writeMarkdown added. Strip them here so pushing the file back
// sends only the body — otherwise markpost would treat the frontmatter+heading
// as content and wrap it in a second frontmatter block on ingestion.
export const readMarkdown = (
  filePath: string,
): Pick<Record, 'title' | 'content'> => {
  if (!existsSync(filePath)) {
    throw Error(`File not found: ${filePath}`);
  }

  return {
    title: basename(filePath, extname(filePath)),
    content: stripFrontmatterDocument(readFileSync(filePath, 'utf-8')),
  };
};
