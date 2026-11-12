// Git exports repo-locating variables (GIT_DIR, GIT_INDEX_FILE, ...) to hooks
// and to `git rebase -x` commands. Tests that build throwaway repos spawn git
// with `...process.env`, so when the suite runs from the husky pre-commit hook
// in a worktree, their `git init`/`config`/`commit` hit the REAL repo instead:
// junk commits and `user.email = test@example.com` written to .git/config.
// Stripping them once here, before any test runs, isolates every spawned git
// (test helpers and the scripts under test alike).
import { execFileSync } from 'node:child_process';

// Git's own list of repo-local variables, so this stays correct if git adds one.
export const readRepoLocalGitEnvNames = (): string[] =>
  execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf-8' })
    .split('\n')
    .filter(Boolean);

export const stripRepoLocalGitEnv = (
  env: NodeJS.ProcessEnv,
  names: string[],
): void => {
  for (const name of names) {
    delete env[name];
  }
};

stripRepoLocalGitEnv(process.env, readRepoLocalGitEnvNames());
