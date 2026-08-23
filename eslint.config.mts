import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierPlugin from 'eslint-plugin-prettier/recommended';

export default tseslint.config(
  // Vendored verbatim from markpost by scripts/sync-contract.mjs; not
  // hand-edited, so it shouldn't be linted to this repo's rules.
  { ignores: ['src/types/vendor/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettierPlugin,
  // Every API request must go through `apiFetch` (src/libs/api.ts) so it
  // carries the shared request timeout; a bare `fetch` would reintroduce the
  // hang this guards against. `api.ts` itself is the one allowed caller.
  {
    files: ['src/**/*.ts'],
    ignores: ['src/libs/api.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message:
            'Use apiFetch from @/libs/api.js so the request carries a timeout.',
        },
      ],
      // `no-restricted-globals` only catches the bare identifier; also block
      // the `globalThis.fetch(...)` / `global.fetch(...)` member forms so
      // they can't slip the guard.
      'no-restricted-properties': [
        'error',
        {
          object: 'globalThis',
          property: 'fetch',
          message:
            'Use apiFetch from @/libs/api.js so the request carries a timeout.',
        },
        {
          object: 'global',
          property: 'fetch',
          message:
            'Use apiFetch from @/libs/api.js so the request carries a timeout.',
        },
      ],
    },
  },
  // `checkConfig` resolves false (having emitted its own diagnostic and set a
  // non-zero exit code) when config is missing, instead of terminating the
  // process. A bare `await checkConfig()` discards that signal and runs
  // unauthenticated — in `--json` mode it emits `config_required` and then
  // still hits the API, breaking the one-diagnostic contract. Force every call
  // site to guard on the result.
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "ExpressionStatement > AwaitExpression > CallExpression[callee.name='checkConfig']",
          message:
            'checkConfig resolves false when config is missing — guard on it (`if (!(await checkConfig())) { return; }`) instead of discarding the result.',
        },
      ],
    },
  },
);
