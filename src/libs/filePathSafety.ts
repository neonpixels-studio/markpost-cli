import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

// Mirrors markpost's shared/utils/filePath.ts (`filePathViolation`) and the
// primitives it imports from shared/utils/pathSafety.ts (`hasTraversalSegment`,
// `hasControlCharacters`). Copied by hand, like the other markpost contract
// mirrors: markpost-cli has no shared package. Keep the rules in step with
// markpost; the CLI applies them as defense in depth, so a compromised or buggy
// server can't steer a write outside the vault with a hostile `record.filePath`.

const FILE_PATH_MAX_LENGTH = 512;
// Mirrors FILENAME_TEMPLATE_EXTENSION in markpost's shared/utils/filenameTemplate.ts.
const FILE_PATH_EXTENSION = '.md';
// Most filesystems cap a single path component at 255 bytes (not characters).
const FILE_PATH_SEGMENT_MAX_BYTES = 255;
const PATH_SEPARATOR = '/';
const BACKSLASH = '\\';

const textEncoder = new TextEncoder();

// Windows device names (CON, NUL, COM1, ...) target a device rather than a
// file, with or without an extension.
const RESERVED_SEGMENT = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i;

// Backslash is a Windows separator; the rest are reserved on Windows (and ":"
// also introduces drive letters such as "C:").
const FORBIDDEN_CHARACTERS = /[\\<>:"|?*]/;

// Windows strips trailing dots and spaces from each component, so a padded
// segment collides with or escapes the one it appears to name.
const PADDED_SEGMENT = /^\s|[\s.]$/;

// Split on both separators here (pathSafety.ts does), since a value may be a
// Windows path.
const ANY_PATH_SEPARATOR = /[/\\]/;
// A component of two-or-more dots is parent-directory traversal; compared
// against the trimmed segment because Windows strips trailing spaces.
const TRAVERSAL_SEGMENT = /^\.{2,}$/;
// NUL, the C0 range and DEL cannot appear in a usable path.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

export type FilePathViolation =
  | 'empty'
  | 'too-long'
  | 'segment-too-long'
  | 'absolute'
  | 'traversal'
  | 'invalid-characters'
  | 'unsafe-segment'
  | 'missing-extension';

export class FilePathViolationError extends Error {
  readonly violation: FilePathViolation | 'escapes-vault';

  constructor(message: string, violation: FilePathViolation | 'escapes-vault') {
    super(message);
    this.name = 'FilePathViolationError';
    this.violation = violation;
  }
}

const segmentsOf = (value: string): string[] => value.split(PATH_SEPARATOR);

const hasTraversalSegment = (value: string): boolean =>
  value
    .split(ANY_PATH_SEPARATOR)
    .some((segment) => TRAVERSAL_SEGMENT.test(segment.trim()));

const hasUnsafeSegment = (value: string): boolean =>
  segmentsOf(value).some(
    (segment) =>
      segment === '' ||
      PADDED_SEGMENT.test(segment) ||
      RESERVED_SEGMENT.test(segment),
  );

const hasOversizedSegment = (value: string): boolean =>
  segmentsOf(value).some(
    (segment) =>
      textEncoder.encode(segment).length > FILE_PATH_SEGMENT_MAX_BYTES,
  );

const hasMarkdownExtension = (value: string): boolean => {
  const leaf = (segmentsOf(value).at(-1) ?? '').toLowerCase();

  return (
    leaf.endsWith(FILE_PATH_EXTENSION) &&
    leaf.length > FILE_PATH_EXTENSION.length
  );
};

// Returns the first violation found, or null when the value is a safe relative
// markdown path.
export const filePathViolation = (value: string): FilePathViolation | null => {
  if (value.trim() === '') {
    return 'empty';
  }

  if (value.length > FILE_PATH_MAX_LENGTH) {
    return 'too-long';
  }

  if (hasOversizedSegment(value)) {
    return 'segment-too-long';
  }

  if (CONTROL_CHARACTERS.test(value)) {
    return 'invalid-characters';
  }

  if (value.startsWith(PATH_SEPARATOR) || value.startsWith(BACKSLASH)) {
    return 'absolute';
  }

  if (FORBIDDEN_CHARACTERS.test(value)) {
    return 'invalid-characters';
  }

  if (hasTraversalSegment(value)) {
    return 'traversal';
  }

  if (hasUnsafeSegment(value)) {
    return 'unsafe-segment';
  }

  if (!hasMarkdownExtension(value)) {
    return 'missing-extension';
  }

  return null;
};

// Throws when the server-provided `record.filePath` is not a safe relative
// markdown path. The message embeds the untrusted value; callers sanitize it
// before printing.
export const assertSafeServerFilePath = (filePath: string): void => {
  const violation = filePathViolation(filePath);

  if (violation === null) {
    return;
  }

  throw new FilePathViolationError(
    `Refusing to write: server file path ${JSON.stringify(filePath)} is invalid (${violation}).`,
    violation,
  );
};

const isOutside = (directory: string, target: string): boolean => {
  const relativePath = relative(directory, target);

  return (
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  );
};

const unresolvablePathError = (path: string): FilePathViolationError =>
  new FilePathViolationError(
    `Refusing to write: cannot resolve ${path} inside the output directory.`,
    'escapes-vault',
  );

// lstat itself throws (ELOOP, EACCES) when an intermediate component is
// unusable; that is also a refusal, not a crash.
const entryExists = (path: string): boolean => {
  try {
    return Boolean(lstatSync(path, { throwIfNoEntry: false }));
  } catch {
    throw unresolvablePathError(path);
  }
};

// Canonical path of the deepest ancestor that exists, so a not-yet-created
// subfolder (or vault) is judged by the real location it would be created in.
const realPathOfDeepestExistingAncestor = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    // An entry that exists but can't be resolved (dangling or looping symlink,
    // EACCES) must fail closed rather than be skipped over as "not created yet".
    if (entryExists(path)) {
      throw unresolvablePathError(path);
    }

    const parent = dirname(path);

    if (parent === path) {
      return path;
    }

    return realPathOfDeepestExistingAncestor(parent);
  }
};

// Resolve `relativePath` against `vault` and verify the result stays inside it,
// both lexically (`..`, absolute paths) and after following symlinks: a
// symlinked subfolder, or a symlinked vault root, must not let a write land
// outside the real vault. Only the parent directory is followed; a symlink at
// the leaf itself is unlinked, never followed, by the writers.
export const resolveWithinVault = (
  vault: string,
  relativePath: string,
): string => {
  const resolvedVault = resolve(vault);
  const resolvedPath = resolve(resolvedVault, relativePath);
  const escapeError = new FilePathViolationError(
    `Refusing to write outside output directory: ${relativePath}`,
    'escapes-vault',
  );

  if (
    resolvedPath === resolvedVault ||
    isOutside(resolvedVault, resolvedPath)
  ) {
    throw escapeError;
  }

  const realVault = realPathOfDeepestExistingAncestor(resolvedVault);
  const realParent = realPathOfDeepestExistingAncestor(dirname(resolvedPath));

  if (isOutside(realVault, realParent)) {
    throw escapeError;
  }

  return resolvedPath;
};
