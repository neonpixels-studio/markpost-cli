import {
  existsSync,
  globSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, resolve } from 'node:path';

const MARKDOWN_EXTENSIONS = ['.md', '.markdown'];
// Leading dot marks entries the directory walk skips (`.git`, `.obsidian`,
// dotfiles), matching globSync's default of not matching dot entries.
const HIDDEN_ENTRY_PREFIX = '.';
// Leading references to the home directory the shell would normally expand.
// A user quotes a glob (`markpost push '~/vault/**'`) precisely to stop the
// shell touching it, which also stops the shell expanding the `~`/`$HOME`, so
// the literal reference reaches us and must be expanded here instead.
const HOME_REFERENCE_PREFIXES = ['~', '$HOME', '${HOME}'];

// The outcome of expanding the raw push arguments:
// - `files`: every markdown file resolved (deduplicated, order preserved)
// - `missing`: inputs that matched nothing, so a typo'd path or empty glob
//   is surfaced instead of silently dropped
// - `skipped`: paths that exist but could not be used (broken symlink,
//   permission denied, deleted mid-walk, or a non-regular file such as a
//   device/FIFO), surfaced rather than aborting the whole batch
export interface ResolvedMarkdownInputs {
  files: string[];
  missing: string[];
  skipped: string[];
}

// Files gathered so far, paths that could not be read, and the set of
// directories already walked (keyed by canonical path) so a symlink cycle
// can't recurse forever. Threaded through the recursive walk so one bad
// entry is recorded and surfaced instead of unwinding the whole traversal.
interface WalkAccumulator {
  files: string[];
  skipped: string[];
  visitedDirectories: Set<string>;
}

const isMarkdownFile = (filePath: string): boolean => {
  return MARKDOWN_EXTENSIONS.includes(extname(filePath).toLowerCase());
};

// Expand one leading home reference against the current home directory. The
// reference on its own becomes the home directory; a `~/…` / `$HOME/…` prefix
// has the reference swapped for the home path by string splice (not `join`, so
// glob metacharacters and separators in the remainder survive untouched).
// Returns null when the prefix doesn't apply so the caller can try the next.
const expandHomeReference = (input: string, prefix: string): string | null => {
  if (input === prefix) {
    return homedir();
  }

  if (input.startsWith(`${prefix}/`)) {
    return `${homedir()}${input.slice(prefix.length)}`;
  }

  return null;
};

// Swap a leading `~`/`$HOME` for the home directory so a quoted input resolves
// to the same target the shell would have produced unquoted. Anything without
// a home reference is returned untouched.
const expandHomeDirectory = (input: string): string => {
  for (const prefix of HOME_REFERENCE_PREFIXES) {
    const expanded = expandHomeReference(input, prefix);

    if (expanded !== null) {
      return expanded;
    }
  }

  return input;
};

// Resolve symlinks and normalize casing so a symlink and its target, or the
// same path in different casing on a case-insensitive filesystem, share one
// key. Falls back to a lexical resolve when the path can't be realpath'd.
const canonicalize = (path: string): string => {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
};

// statSync follows symlinks, so directory walks and globs classify a
// symlinked note identically. A failing stat (broken link, EACCES, or a
// file removed mid-walk) is recorded as skipped and returns null so the
// caller moves on instead of unwinding the whole traversal.
const statOrSkip = (
  path: string,
  accumulator: WalkAccumulator,
): Stats | null => {
  try {
    return statSync(path);
  } catch {
    accumulator.skipped.push(path);
    return null;
  }
};

// Recurse a directory, collecting every markdown file beneath it so a whole
// vault can be pushed by naming its folder. An unreadable directory is
// recorded and skipped rather than aborting the traversal, and an
// already-visited directory (symlink cycle) is not re-entered.
function collectFromDirectory(
  directoryPath: string,
  accumulator: WalkAccumulator,
): void {
  const canonicalDirectory = canonicalize(directoryPath);

  if (accumulator.visitedDirectories.has(canonicalDirectory)) {
    return;
  }

  accumulator.visitedDirectories.add(canonicalDirectory);

  let entryNames: string[];

  try {
    entryNames = readdirSync(directoryPath);
  } catch {
    accumulator.skipped.push(directoryPath);
    return;
  }

  for (const entryName of entryNames) {
    if (entryName.startsWith(HIDDEN_ENTRY_PREFIX)) {
      continue;
    }

    collectFromPath(join(directoryPath, entryName), accumulator);
  }
}

// Classify one path found during traversal (a directory entry or a glob
// match), recursing directories and taking only markdown files. A glob is a
// bulk selector, not an explicit name, so a `*` never sweeps in unrelated
// non-markdown files.
function collectFromPath(path: string, accumulator: WalkAccumulator): void {
  const stats = statOrSkip(path, accumulator);

  if (!stats) {
    return;
  }

  if (stats.isDirectory()) {
    collectFromDirectory(path, accumulator);
    return;
  }

  if (stats.isFile() && isMarkdownFile(path)) {
    accumulator.files.push(path);
  }
}

const collectFromGlob = (
  pattern: string,
  accumulator: WalkAccumulator,
): void => {
  for (const match of globSync(pattern)) {
    collectFromPath(match, accumulator);
  }
};

// Resolve one argument into the accumulator. An existing regular file named
// directly is taken as-is (the user was explicit, so its extension is not
// second-guessed); an existing directory is recursed; a non-regular file
// (device, FIFO) is skipped rather than handed to a reader that would block
// or read garbage; anything that does not exist is treated as a glob.
const resolveInput = (input: string, accumulator: WalkAccumulator): void => {
  if (!existsSync(input)) {
    collectFromGlob(input, accumulator);
    return;
  }

  const stats = statOrSkip(input, accumulator);

  if (!stats) {
    return;
  }

  if (stats.isDirectory()) {
    collectFromDirectory(input, accumulator);
    return;
  }

  if (!stats.isFile()) {
    accumulator.skipped.push(input);
    return;
  }

  accumulator.files.push(input);
};

// Deduplicate on the canonical key while keeping the first original spelling,
// so success and error messages read the way the user typed them.
const dedupeByCanonicalPath = (paths: string[]): string[] => {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const path of paths) {
    const key = canonicalize(path);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(path);
  }

  return unique;
};

export const resolveMarkdownInputs = (
  inputs: string[],
): ResolvedMarkdownInputs => {
  const files: string[] = [];
  const missing: string[] = [];
  const skipped: string[] = [];

  for (const input of inputs) {
    const accumulator: WalkAccumulator = {
      files: [],
      skipped: [],
      visitedDirectories: new Set(),
    };
    resolveInput(expandHomeDirectory(input), accumulator);

    skipped.push(...accumulator.skipped);

    if (accumulator.files.length === 0 && accumulator.skipped.length === 0) {
      missing.push(input);
      continue;
    }

    files.push(...accumulator.files);
  }

  return {
    files: dedupeByCanonicalPath(files),
    missing,
    skipped: dedupeByCanonicalPath(skipped),
  };
};
