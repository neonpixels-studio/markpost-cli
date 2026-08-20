# @markpost/cli

CLI tool for sync.danholloran.me

## Installation

```bash
npm install -g @markpost/cli
```

Once installed, run the CLI with the `markpost` command.

## Usage

Run `markpost help` (or `markpost --help` / `-h`) to see aggregated usage for
every command. A bare `markpost` with no arguments prints that help and exits
non-zero — it does **not** sync, so an accidental invocation can't delete
server-side records.

| Command | Description |
|---|---|
| `markpost sync` | Fetch all pending records, write each to a markdown file, and (when `autoDelete` is enabled) delete the written records from the server |
| `markpost push <path...>` | Create records from one or more markdown files, directories, or glob patterns |
| `markpost get <uuid> [--json]` | Fetch and display a single record; pass `--json` for machine-readable output |
| `markpost sources <list\|create\|update\|delete> [uuid]` | Manage sources; `sources list --json` prints machine-readable output |
| `markpost records list [--source <type>] [--status <status>] [--search <text>] [--json]` | List records without deleting them, optionally filtered by source, status, or search text; pass `--json` for machine-readable output |
| `markpost config <get\|set\|path> [key] [value]` | View or change the stored API token and output directory |
| `markpost settings <get\|set> [key=value ...]` | View or change server-side sync settings (`autoSync`, `autoDelete`, `frontmatter`, `conflictStrategy`) |
| `markpost help` | Show aggregated usage |

The destructive fetch/write/delete sync runs only under the explicit
`markpost sync` command.

## Sync behavior

`markpost sync` writes your records to `OUTPUT_DIRECTORY`, honoring your
markpost account settings:

- **`autoSync`** — when on (markpost's default), the sync does not exit after
  one pass: it self-schedules and re-runs every 5 minutes, staying in the
  foreground until you stop it with `Ctrl-C`. A one-line banner announces this
  at startup. When off, `markpost sync` syncs once and exits. Records already
  written during a session are not re-written on later iterations; a record
  edited on the server after it was synced is not re-fetched until you restart
  the process (the record contract carries no mutation timestamp to detect the
  edit). Each iteration fetches only records still `pending` on the server (with
  `autoDelete` off, written records are marked `synced` so later passes skip
  them), so the per-interval fetch cost tracks your outstanding backlog rather
  than growing with your full history.
- **`autoDelete`** — when on (markpost's default), records written locally are
  deleted from the server after a successful write; when off, they stay on the
  server. If a delete fails, the record is retried on the next `autoSync`
  iteration rather than abandoned.
- **`frontmatter`** — when on (markpost's default), synced files include a YAML
  frontmatter block. When off, records that carry markpost metadata are written
  with just their `# Title` heading and body; records with no metadata (e.g.
  `markpost push` created) are written as bare content either way.
- **`conflictStrategy`** — how same-name files are handled (`suffix`,
  `overwrite`, or `skip`).

These settings live on your markpost account. View or change them from the CLI
with the `settings` command (each `set` field is a `key=value` pair; pass more
than one to change several at once):

```bash
markpost settings get                                        # print current settings
markpost settings set autoDelete=false                       # change one field
markpost settings set autoSync=false conflictStrategy=overwrite  # change several
```

`set` validates every field name and value against markpost's contract before
sending, so a typo'd key or off-contract value fails locally rather than
silently doing nothing.

## Configuration

The CLI stores your API token and output directory in a `conf` file on disk.
On first run it prompts for anything missing. Use the `config` command to
inspect or change those values afterwards without hand-editing the file:

```bash
markpost config get                      # show all stored config
markpost config get apiToken             # show one value
markpost config set apiToken <token>     # change the stored API token
markpost config set outputDirectory <path>
markpost config path                     # print the config file location
```

The stored API token is a secret, so `config get` never prints it in full: it
shows only the first and last four characters (e.g. `sk_a****wxyz`), and fully
masks tokens too short to redact safely. The output directory is a plain path
and shown in full.

Note that `config set apiToken <token>` puts the token in your shell history.
Prefer a leading space (with `HISTCONTROL=ignorespace`, or `setopt
HIST_IGNORE_SPACE` in zsh) to keep it out, or set `API_TOKEN` in the
environment instead.

## Development

### Prerequisites

- Node.js
- npm

### Setup

```bash
git clone https://github.com/neonpixels-studio/markpost-cli.git
cd markpost-cli
npm install
```

### Environment Variables

Copy [`.envrc`](.envrc) and populate your values. If you use [direnv](https://direnv.net/), run `direnv allow` to load them automatically.

| Variable | Description |
|---|---|
| `API_TOKEN` | API token for sync.danholloran.me |
| `BASE_URL` | Base URL of the sync API (e.g. `http://localhost:8888` for local dev) |
| `OUTPUT_DIRECTORY` | Absolute path to the directory where synced files are written |

### Scripts

| Command            | Description                            |
| ------------------ | -------------------------------------- |
| `npm run build`    | Compile TypeScript to `dist/`          |
| `npm run watch`    | Watch and recompile on changes         |
| `npm test`         | Run tests with Vitest                  |
| `npm run test:ci`  | Run tests once (CI mode)               |
| `npm run test:ui`  | Run tests with Vitest UI               |
| `npm run lint`     | Check formatting and linting           |
| `npm run lint:fix` | Auto-fix formatting and linting issues |
| `npm run sync:contract` | Refresh the vendored markpost API contract (see below) |
| `npm run sync:markdown-serialization` | Refresh the vendored markpost serialization slice (see below) |

### Contract sync

The CLI talks to [markpost](https://github.com/neonpixels-studio/markpost)'s API, so its
request/response types need to match markpost's real contract exactly — a
structural mismatch here previously caused real pagination and
error-swallowing bugs. Instead of hand-mirroring markpost's types (which drift
silently), `src/types/vendor/markpost-api.types.ts` is a vendored, verbatim
copy of markpost's `server/types/api.types.ts`, and `src/types/api.types.ts`
re-exports the generic envelope types (`ApiError`, `ApiRequest`,
`ApiResourceObject`, `ApiResponse`) from it.

- **Refreshing it:** run `npm run sync:contract` (optionally
  `-- --from <path-to-a-local-markpost-checkout>`; without `--from` it
  shallow-clones markpost fresh). This is a **human-run** step, not part of
  CI — it needs network access (or a local checkout) to fetch the current
  contract, and a test that depends on network access would be flaky and fail
  offline. Review the resulting diff, run `npm run build` and `npm test`, then
  commit it like any other change.
- **Catching drift:** `tests/types/contract-drift.test.ts` runs on every
  `npm test` / `npm run test:ci` and fails if either (a) the committed vendored
  file stops exporting the type names the CLI depends on, or (b) the CLI's own
  `src/` no longer compiles against it (it recompiles the real project with
  the TypeScript compiler API, using `tsconfig.json` directly — not a
  hand-written stand-in). No network access, no CI workflow changes needed.
- **Wiring into CI:** this is already covered by the existing `npm test` /
  `npm run test:ci` invocation in your CI workflow — no new step is required.
  If you want an explicit, separate CI signal for contract drift specifically
  (e.g. to label it distinctly in the checks UI), add:
  ```yaml
  - name: Check markpost contract drift
    run: npx vitest run tests/types/contract-drift.test.ts
  ```
  after your existing install step.
- **What this does *not* do:** it does not detect when markpost's *real*
  upstream contract has changed and the vendored copy has fallen behind — that
  would require network access at test time (flaky, and fails offline CI).
  Re-run `npm run sync:contract` periodically or whenever a markpost API
  change is suspected.

### Markdown serialization sync

The CLI writes synced records to disk as markdown, and those files must be
**byte-identical** to what markpost itself would write — otherwise a `markpost
push` re-wraps or corrupts them. markpost's `server/utils/markdown.ts` is the
source of truth for that format (`quoteYamlScalar`, `serializeTagsLine`,
`serializeFrontmatter`, `assembleMarkdownDocument`); `src/libs/frontmatter.ts`
hand-mirrors it. That mirror used to have zero automated guard — a change to
markpost's quoting or block layout would silently corrupt synced files with no
test failing. This closes that gap the same way the contract sync does.

- **Refreshing it:** run `npm run sync:markdown-serialization` (optionally
  `-- --from <path-to-a-local-markpost-checkout>`; without `--from` it
  shallow-clones markpost fresh). Like the contract sync this is a
  **human-run** step, not part of CI — it needs network access (or a local
  checkout). It extracts just the serialization slice of `markdown.ts` (the
  four functions above plus the two types they use, leaving the
  turndown-dependent server code behind) and writes it verbatim to
  `tests/libs/vendor/markpost-markdown-serialization.generated.ts`, alongside a
  manifest recording the exact source commit. The file lives under `tests/` so
  it never ships in the published `dist/`. Review the diff, run `npm test`,
  then commit.
- **Catching drift:** `tests/libs/frontmatter-drift.test.ts` runs on every
  `npm test` / `npm run test:ci`. It executes markpost's *real* (vendored)
  serialization functions and the CLI's mirrored ones over a shared battery of
  inputs — plain values, empty and multi-tag lists, every YAML metacharacter,
  whitespace, and escape sequences — and fails if any input serializes
  differently. No network access needed. When markpost's serialization
  changes, re-run the sync: the vendored slice updates, and if the CLI mirror
  has not been updated to match, this test goes red.
- **What this does *not* do:** it does not detect when markpost's upstream
  serialization has changed and the vendored slice has fallen behind — that
  would require network access at test time. Re-run
  `npm run sync:markdown-serialization` whenever a markpost markdown change is
  suspected.

## Security scanning

This repo runs a deterministic security-scanner layer in two places: a local
pre-commit hook and GitHub Actions CI.

### Secret detection (gitleaks)

[gitleaks](https://github.com/gitleaks/gitleaks) scans for committed secrets.
The ruleset lives in [`.gitleaks.toml`](.gitleaks.toml): it extends the gitleaks
default rules and adds custom rules for Clerk secret keys (`sk_live_` /
`sk_test_`) and Postgres/Neon connection strings that embed credentials. Example
and test-fixture files are allowlisted.

- **Locally**, the [`.husky/pre-commit`](.husky/pre-commit) hook runs
  `gitleaks git --staged` and blocks the commit on any finding. Install
  gitleaks to enable it (`brew install gitleaks`, or see the
  [install docs](https://github.com/gitleaks/gitleaks#installing)). If gitleaks
  is not installed the hook prints a notice and continues — CI still enforces the
  scan, so nothing slips through.
- **In CI**, the `gitleaks` job in
  [`.github/workflows/security.yml`](.github/workflows/security.yml) downloads
  the pinned gitleaks release and scans the pull-request commit range on PRs and
  the full history on push to `main`. Any finding fails the build.

### Dependency scanning

The `dependency-audit` job in the same workflow runs `npm audit`. Moderate and
low advisories are printed as a summary; the build fails only on **high** or
**critical** severity. [`.github/dependabot.yml`](.github/dependabot.yml) opens
weekly dependency-update PRs, grouping minor and patch bumps into a single PR.
