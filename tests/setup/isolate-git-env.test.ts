import { describe, expect, it } from 'vitest';
import {
  readRepoLocalGitEnvNames,
  stripRepoLocalGitEnv,
} from './isolate-git-env.js';

describe('isolate-git-env setup', () => {
  it('reads the repo-locating variables git exports to hooks', () => {
    const names = readRepoLocalGitEnvNames();

    expect(names).toEqual(
      expect.arrayContaining(['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE']),
    );
  });

  it('strips repo-local variables but keeps unrelated ones', () => {
    const env: NodeJS.ProcessEnv = {
      GIT_DIR: '/real/repo/.git',
      GIT_INDEX_FILE: '/real/repo/.git/index',
      GIT_CONFIG_GLOBAL: '/dev/null',
      PATH: '/usr/bin',
    };

    stripRepoLocalGitEnv(env, readRepoLocalGitEnvNames());

    expect(env).toEqual({ GIT_CONFIG_GLOBAL: '/dev/null', PATH: '/usr/bin' });
  });

  it('has already stripped them from this test process', () => {
    for (const name of readRepoLocalGitEnvNames()) {
      expect(process.env[name]).toBeUndefined();
    }
  });
});
