import {
  writeFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import {
  basename,
  dirname,
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

// The `<slug>.md` path a record lands on when no collision pushes it to a
// suffix — the target `overwrite`/`skip` always aim at, and the identity used
// for slug ownership (see writeMarkdown).
const resolveBasePath = (outputDirectory: string, slug: string): string => {
  return resolveWithinOutputDirectory(
    outputDirectory,
    `${slug}${MARKDOWN_EXTENSION}`,
  );
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

// Replace whatever is at `targetPath` with a fresh regular file.
// Remove any existing entry first, then exclusively create the file. `rmSync`
// acts on the link itself, so a symlink is unlinked (its target outside the
// vault is left untouched) and a hardlink loses only this name (the shared
// inode is never truncated) — that's what stops the write from following a
// planted link out of the vault, since `resolveWithinOutputDirectory` only
// guards the string path. Recreating with the exclusive flag means that if
// something races a new entry into the gap, the write fails (EEXIST) rather
// than following it.
const writeReplacingExisting = (targetPath: string, content: string): void => {
  rmSync(targetPath, { force: true });
  writeFileSync(targetPath, content, { flag: EXCLUSIVE_WRITE_FLAG });
};

// `overwrite` strategy: replace whatever is at `<slug>.md` with this record. No
// collision loop — the user has opted into the newest record winning a slug
// clash. See writeReplacingExisting for the unlink-then-exclusive-create
// rationale that keeps the write from following a planted symlink.
const writeOverwriting = (
  outputDirectory: string,
  slug: string,
  content: string,
): string => {
  const candidatePath = resolveBasePath(outputDirectory, slug);

  writeReplacingExisting(candidatePath, content);

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
  const candidatePath = resolveBasePath(outputDirectory, slug);

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

// `overwrite` truncates `<slug>.md`, which is intended against a file from a
// *previous* run and against the *same* record re-fetched in a later autoSync
// pass (it must overwrite its own file, not spawn a duplicate). But two
// *different* records with the same slug must not clobber each other — the
// caller deletes every written record server-side, so the clobbered one is lost
// everywhere. `seenSlugs` maps each written base path to the uuid that wrote it
// (keyed by resolved path, not the bare slug, so a mid-run outputDirectory
// change can't misattribute ownership across directories); the downgrade to
// `suffix` fires only when a *different* uuid owns that base path. An
// empty/missing uuid is treated as "different" so it can never match and
// clobber. `suffix`/`skip` already route on-disk collisions safely via the
// exclusive flag, so only `overwrite` consults ownership.
const resolveStrategyForSlug = (
  conflictStrategy: ConflictStrategy,
  basePath: string,
  recordUuid: string,
  seenSlugs: Map<string, string>,
): ConflictStrategy => {
  const claimedByOtherRecord =
    seenSlugs.has(basePath) &&
    (!recordUuid || seenSlugs.get(basePath) !== recordUuid);

  if (conflictStrategy === 'overwrite' && claimedByOtherRecord) {
    return 'suffix';
  }

  return conflictStrategy;
};

// Keep writtenPaths to one uuid per path: when a record lands on a path a
// different record previously tracked (that record's file was moved out of the
// vault and this record recreated the path), drop the stale entry. Without this,
// a settled-but-not-forgotten stale entry could shadow the live owner and either
// block its reuse (dropping a duplicate) or route a reuse onto another record's
// file. Deleting the current key during Map.forEach is safe.
const evictStalePathOwners = (
  writtenPaths: Map<string, string>,
  writtenPath: string,
  recordUuid: string,
): void => {
  writtenPaths.forEach((entryPath, entryUuid) => {
    if (entryPath === writtenPath && entryUuid !== recordUuid) {
      writtenPaths.delete(entryUuid);
    }
  });
};

// A record whose server-side settle (mark-synced or delete) failed on a prior
// pass is re-fetched as still-pending next pass. `writtenPaths` maps each such
// uuid to the file already written for it this process, so the record reuses its
// own file instead of the suffix strategy dropping a fresh `<slug>-2.md`,
// `<slug>-3.md` duplicate every pass — the written-vs-settled split: the local
// file is already written, only the server-side step still needs retrying.
// Returns the reusable path, or null (the caller then falls through to a fresh
// write) when any guard fails: the uuid is untrackable (empty) or was never
// written; the tracked path is no longer a regular file (moved/deleted, or
// replaced by a directory or symlink — reuse writes nothing for suffix/skip, so
// settling the record against a non-file would strand it with no local content,
// and lstat rejects a symlink rather than following it out of the vault); or the
// file no longer lives in the current output directory (a mid-run
// outputDirectory change must not send the record back to the old vault — same
// reason seenSlugs is keyed by resolved path). evictStalePathOwners keeps
// writtenPaths to one uuid per path, so a surviving entry is unambiguously this
// record's file. Keyed by uuid, so a record whose title changed server-side
// between passes keeps its original filename (its existing file is reused rather
// than orphaned under a new slug). The check is existence + type, not identity:
// if an external process deletes this record's file and drops a *different*
// regular file at the same path between passes, it is reused as-is — an accepted
// edge, since the fix (tracking inode/mtime per path) is disproportionate to a
// rare same-path race. A stat error other than "missing" (EACCES, ENOTDIR) is
// treated as "not reusable" rather than thrown, so a best-effort lookup can
// never fail an otherwise-writable record.
const resolveReusableWrittenPath = (
  outputDirectory: string,
  recordUuid: string,
  writtenPaths: Map<string, string>,
): string | null => {
  if (!recordUuid) {
    return null;
  }

  const existingPath = writtenPaths.get(recordUuid);

  if (!existingPath) {
    return null;
  }

  if (!isExistingRegularFile(existingPath)) {
    return null;
  }

  if (resolve(dirname(existingPath)) !== resolve(outputDirectory)) {
    return null;
  }

  return existingPath;
};

// True only when `filePath` is an existing regular file. lstat (not stat) so a
// symlink reports false rather than resolving to its target. `throwIfNoEntry`
// covers a missing entry; any other stat error (EACCES, ENOTDIR) is caught and
// treated as "not reusable" so the best-effort reuse lookup can't fail a record.
const isExistingRegularFile = (filePath: string): boolean => {
  try {
    return lstatSync(filePath, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
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
// default) when no strategy is supplied. `seenSlugs` maps each written base
// path to the uuid that owns it; the caller threads it across a batch AND
// across autoSync passes so `overwrite` can't lose two different same-slug
// records while still letting a record re-overwrite its own file (see
// resolveStrategyForSlug). `writtenPaths` maps each uuid to the file written
// for it this process; the caller threads it across passes so a record whose
// server settle failed reuses its file instead of accumulating suffixed
// duplicates (see resolveReusableWrittenPath). `includeFrontmatter` is the
// user's `frontmatter` setting; when off the file is written without a
// frontmatter block (see buildRecordDocument).
export const writeMarkdown = (
  record: Record,
  conflictStrategy: ConflictStrategy = DEFAULT_CONFLICT_STRATEGY,
  seenSlugs: Map<string, string> = new Map(),
  includeFrontmatter = true,
  writtenPaths: Map<string, string> = new Map(),
): string | null => {
  const outputDirectory = ensureOutputDirectory();

  const slug = slugifyTitle(record.title, record.uuid);
  const basePath = resolveBasePath(outputDirectory, slug);
  const content = buildRecordDocument(record, includeFrontmatter);

  // A re-fetched, still-unsettled record reuses its own file rather than letting
  // any strategy drop a suffixed duplicate (see resolveReusableWrittenPath).
  // Runs before strategy resolution so it applies to suffix, overwrite, and skip
  // alike.
  const reusablePath = resolveReusableWrittenPath(
    outputDirectory,
    record.uuid,
    writtenPaths,
  );

  // `suffix` and `skip` both preserve existing files (suffix by writing a new
  // suffixed file, skip by not writing at all), so on reuse they keep the file
  // as-is: reusing the path lets the record settle server-side without dropping
  // a duplicate and without clobbering a note edited in the vault between
  // passes. The tradeoff is deliberate — a record whose content changed
  // server-side between passes keeps its pass-one file under suffix/skip
  // (preserving a local edit is preferred over re-fetching server content, in
  // keeping with these strategies' "don't clobber" intent). Only `overwrite`
  // (the user opted into the newest record replacing the file) refreshes the
  // reused file with the record's latest content.
  if (reusablePath && conflictStrategy !== 'overwrite') {
    return reusablePath;
  }

  if (reusablePath) {
    writeReplacingExisting(reusablePath, content);

    return reusablePath;
  }

  const effectiveStrategy = resolveStrategyForSlug(
    conflictStrategy,
    basePath,
    record.uuid,
    seenSlugs,
  );
  const writer =
    STRATEGY_WRITERS.get(effectiveStrategy) ?? writeToFirstAvailablePath;

  const writtenPath = writer(outputDirectory, slug, content);
  // Ownership means "this uuid wrote `<slug>.md`", so record it only when the
  // write actually landed on the base path — never for a `skip` no-op (null) or
  // a `suffix` write that spilled to `<slug>-2.md`. Ownership transfers to
  // whoever last wrote the base path: a suffix-downgraded record starts at the
  // base path too and claims it when that path is free (e.g. the prior owner's
  // file was moved out of the vault), which is correct — the record on disk owns
  // the slug.
  if (writtenPath === basePath) {
    seenSlugs.set(basePath, record.uuid);
  }

  // Remember the file this uuid landed on so a later pass that re-fetches it
  // (its server settle failed) reuses it. Skip a `skip` no-op (null) and an
  // empty uuid, which can't be tracked; the orchestrator drops the entry once
  // the record settles server-side.
  if (writtenPath !== null && record.uuid) {
    evictStalePathOwners(writtenPaths, writtenPath, record.uuid);
    writtenPaths.set(record.uuid, writtenPath);
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
