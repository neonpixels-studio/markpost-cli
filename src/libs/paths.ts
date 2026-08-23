import { join } from 'node:path';

// The home references a user can put at the start of a configured path. A shell
// won't expand these inside a quoted value (`config set outputDirectory
// '~/notes'`), so the CLI expands them itself at read time. `${HOME}` is listed
// before `$HOME` only for readability — the leading-prefix check below is exact,
// so the two never overlap.
const HOME_PREFIXES = ['~', '${HOME}', '$HOME'] as const;

// True when `prefix` is a leading path token in `inputPath`: either the whole
// string is the prefix, or the prefix is immediately followed by a separator.
// This is what keeps a bare `~` or `$HOME` in the *middle* of a path literal —
// a directory can legitimately be named `~`, and `notes/~drafts` must stay as
// typed — while still catching `~foo`/`$HOMEfoo`, which are different tokens.
const isLeadingHomePrefix = (inputPath: string, prefix: string): boolean => {
  if (inputPath === prefix) {
    return true;
  }

  return inputPath.startsWith(`${prefix}/`);
};

// Expand a leading home reference (`~`, `~/…`, `$HOME`, `${HOME}`) to an
// absolute path under `homeDirectory`. `homeDirectory` is injected (the caller
// passes `os.homedir()`) so this stays a pure string transform testable without
// touching the environment. A path with no leading home reference — already
// absolute, plainly relative, or carrying only a mid-string tilde — is returned
// unchanged.
export const expandHomeDirectory = (
  inputPath: string,
  homeDirectory: string,
): string => {
  const prefix = HOME_PREFIXES.find((candidate) =>
    isLeadingHomePrefix(inputPath, candidate),
  );

  if (!prefix) {
    return inputPath;
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
