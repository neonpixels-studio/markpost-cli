import { join } from 'node:path';

// The home references a user can put at the start of a configured path. A shell
// won't expand these inside a quoted value (`config set outputDirectory
// '~/notes'`), so the CLI expands them itself at read time. `${HOME}` is listed
// before `$HOME` only for readability — the leading-prefix check below is exact,
// so the two never overlap.
const HOME_PREFIXES = ['~', '${HOME}', '$HOME'] as const;

// The separator that must follow a prefix for it to count as a home reference.
// Deliberately POSIX `/` only: the config values and prompts this CLI reads use
// forward slashes, so a Windows-style `~\notes` is intentionally left literal
// rather than half-supported. (A directory named `~` is legal on POSIX, which is
// why a bare mid-path `~` must never expand — see isLeadingHomePrefix.)
const PATH_SEPARATOR = '/';

// True when `prefix` is a leading path token in `inputPath`: either the whole
// string is the prefix, or the prefix is immediately followed by a separator.
// This is what keeps a bare `~` or `$HOME` in the *middle* of a path literal —
// a directory can legitimately be named `~`, and `notes/~drafts` must stay as
// typed — while still leaving `~foo`/`$HOMEfoo` unexpanded: those are different
// tokens, not a home reference plus a path tail.
const isLeadingHomePrefix = (inputPath: string, prefix: string): boolean => {
  if (inputPath === prefix) {
    return true;
  }

  return inputPath.startsWith(`${prefix}${PATH_SEPARATOR}`);
};

// Expand a leading home reference (`~`, `~/…`, `$HOME`, `${HOME}`) to an
// absolute path under the home directory. `resolveHomeDirectory` is injected
// (the caller passes `os.homedir`) and called *only* when a prefix actually
// matched, so a path with no home reference never depends on the environment at
// all — a fully absolute, plainly relative, or mid-string-tilde value is
// returned untouched. os.homedir() falls back to the passwd entry when `$HOME`
// is unset, so the empty-string guard below is defensive rather than routine.
export const expandHomeDirectory = (
  inputPath: string,
  resolveHomeDirectory: () => string,
): string => {
  const prefix = HOME_PREFIXES.find((candidate) =>
    isLeadingHomePrefix(inputPath, candidate),
  );

  if (!prefix) {
    return inputPath;
  }

  const homeDirectory = resolveHomeDirectory();

  // Fail loud rather than let `join('', 'notes')` silently degrade `~/notes`
  // into the relative `notes`, which would scatter files under the cwd — the
  // exact footgun this expansion exists to close.
  if (!homeDirectory) {
    throw Error(
      `Cannot expand "${prefix}" in "${inputPath}": no home directory is available.`,
    );
  }

  const remainder = inputPath.slice(prefix.length);

  if (remainder === '') {
    return homeDirectory;
  }

  // `remainder` always begins with the separator that followed the prefix (the
  // only way isLeadingHomePrefix matched a non-empty tail); join collapses it
  // into a single path segment boundary under the home directory.
  return join(homeDirectory, remainder);
};
