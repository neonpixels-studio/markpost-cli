# @markpost/cli

> **Invite-only alpha.** Markpost isn't open for signups yet, so this CLI won't work without an invited account. [Join the waitlist](https://markpost.io/sign-up) to get access. Expect breaking changes between alpha releases.

CLI tool for markpost.io

## Installation

```bash
npm install -g @markpost/cli@alpha
```

Once installed, run the CLI with the `markpost` command.

## Usage

Run `markpost help` (or `markpost --help` / `-h`) to see aggregated usage for
every command. A bare `markpost` with no arguments prints that help and exits
non-zero — it does **not** sync, so an accidental invocation can't delete
server-side records.

| Command                                                                                                                                    | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `markpost sync [--dry-run]`                                                                                                                | Fetch all pending records, write each to a markdown file, and (when `autoDelete` is enabled) delete the written records from the server. `--dry-run` reports the exact write/delete plan without writing or mutating anything                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `markpost push [--dry-run] <path...>`                                                                                                      | Create records from one or more markdown files, directories, or glob patterns. `--dry-run` reports which files would be pushed, plus any missing or unreadable inputs, without creating any records. `markpost push -` reads a single note from stdin instead (`pbpaste \| markpost push -`), parsed exactly like a file (markpost frontmatter and tags included). With no filename, the title is the note's first `# ` heading, else `Note <ISO timestamp>`. `-` may be given once and not alongside other paths (use `push -- -` for a file literally named `-`); a terminal stdin or empty input is an error, and `--dry-run` previews without creating a record                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `markpost get <uuid...> [--json]`                                                                                                          | Fetch and display one or more records (every uuid given is fetched, none are dropped); pass `--json` for machine-readable output — a single uuid prints a single object, two or more print a JSON array of the ones found                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `markpost tokens <list\|create\|update\|revoke> [id] [--yes]`                                                                              | Manage API tokens; `tokens list --json` prints machine-readable output (the masked `prefix`, never a raw secret). `tokens create --name <name> [--expires-in-days <days>]` mints a token and prints its raw secret exactly once — it cannot be retrieved again, so copy it from the output immediately; omit `--expires-in-days` for a token that never expires. Add `--scopes records:read,sources:read` to limit what the token can do (handy for cron or CI); omit it for a full-access token. Scopes are validated locally against markpost's scope list, and an unknown one fails with the valid list before any request is sent. `tokens update <id> --scopes <a,b>` replaces an existing token's scopes without rotating its secret and prints the updated token (`--json` supported). `tokens update <id> --full-access` restores full access (sends `scopes: null`); it cannot be combined with `--scopes`, and you must pass one of the two. When the id being updated is the token this CLI is currently configured with and the new scopes drop scopes the CLI's commands need (for example `records:write` for `push`), it prints a warning naming the affected commands and asks to confirm first; pass `--yes` to skip the prompt in scripts (a non-interactive run without `--yes` exits with an error), while `--json` never prompts and adds a `warning` field to the printed token. `tokens revoke <id>` revokes a token by id; a revoked token stops authenticating immediately and cannot be un-revoked. It asks to confirm first (revoking is irreversible) and needs an interactive terminal — in scripts pass `--yes` (`tokens revoke <id> --yes`) to skip the prompt, or it exits with an error rather than hang under a pipe or cron job. When the id being revoked is the token this CLI is currently configured with, the confirmation prompt shows a stronger warning, since revoking it locks the CLI out until you set a new one with `config set apiToken <token>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `markpost sources <list\|create\|update\|delete\|rotate-secret\|test> [uuid] [--yes] [--payload <json>] [--clear-field-mapping]`           | Manage sources; `sources list --json` prints machine-readable output. `sources delete` asks to confirm first (deleting a source is irreversible — it drops the ingest config and one-time signing secret) and needs an interactive terminal; in scripts pass a uuid with `--yes` (`sources delete <uuid> --yes`) to skip the prompt. `sources create` and `sources update` also need an interactive terminal — they always prompt (for source details, or the route folder) and have no `--yes` equivalent, so they exit with an error rather than hang under a pipe or cron job. Each also offers an optional field-mapping step (maps ingest payload fields to title/content/etc; declined by default) — for `update` this replaces the entire stored mapping rather than merging into it, since the current mapping isn't shown, so accept the default (or leave every field blank) to leave it untouched. Stored mapping keys this CLI version has no prompt for (for example one added upstream later) are sent back unchanged and listed in a "Preserved fields not editable in this CLI version" notice, so an update never drops them. To remove a source's whole stored field mapping non-interactively, run `sources update <uuid> --clear-field-mapping` (needs an explicit uuid, opens no prompt, works in scripts, and is rejected on every other subcommand); it sends `fieldMapping: null`, markpost's explicit clear value (no request is made when the source is already known to have no mapping), whereas leaving the interactive field-mapping step blank keeps the mapping untouched (interactively, enter `-` for every key to clear it). `rotate-secret [uuid]` mints/replaces the signing secret of a provider source (github/zapier/shortcuts reveal a fresh secret once; stripe prompts for the new value). It needs an interactive terminal when it has to prompt: with no uuid it exits with an error instead of opening the picker, and a stripe source exits with an error instead of waiting on the secret prompt. A uuid'd rotation of a github/zapier/shortcuts source needs no prompt and works under a pipe or cron job. `test <uuid>` runs markpost's diagnostic for the source against a sample payload — previewing signature verification and the field-mapping result (title/content/tags/frontmatter/file path) without triggering a real provider delivery, so you can confirm a secret or field mapping before deliveries arrive. It takes a required uuid (never a picker), needs no interactive terminal, and accepts `--json` for machine-readable output. Pass `--payload '<json object>'` (e.g. `--payload '{"title":"Test"}'`) to preview against a custom sample instead of the server's default; the value must parse as a JSON object, and `--payload` is rejected on every other subcommand. It exits 0 whether or not the signature check passes — `test` reports a diagnostic, it doesn't gate on the result — so a script must inspect the returned `signatureCheck.status` (`verified`/`failed`/`not_required`/`not_verifiable`) rather than the exit code |
| `markpost records list [--source <type>] [--status <status>] [--tag <tag>]... [--search <text>] [--sort=<createdAt\|-createdAt>] [--json]` | List records without deleting them, optionally filtered by source, status, tag, or search text; `--tag` is repeatable and ANDed (a record must carry every tag; a tag containing a comma is rejected because markpost splits `filter[tag]` on commas); `--sort=createdAt` lists oldest first, `--sort=-createdAt` newest first (the default; use the `=` form since a bare `-createdAt` looks like a flag); pass `--json` for machine-readable output                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `markpost records update <uuid> [--title <text>] [--content <text>] [--json]`                                                              | Edit an existing record's title and/or content in place (at least one of `--title`/`--content` is required; neither may be blank) — the CLI's only write path for a record that already exists; the prior workaround (delete-and-recreate) loses the uuid and any source linkage. If the record was already `synced`, markpost requeues it to `pending` so the next `sync` run rewrites its on-disk file with the new title/content; the command prints a note whenever the updated record comes back `pending` (whether freshly requeued or already pending beforehand). Pass `--json` to print the updated record instead of a formatted summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `markpost records delete <uuid...> [--yes] [--json]`                                                                                       | Delete one or more records from the server by uuid (the explicit counterpart to `sync`'s auto-delete, for removing a stray record without the web UI). Every uuid is validated before any request is sent, and duplicates are collapsed. Asks to confirm with the record count (`--yes` skips the prompt); without `--yes` outside a terminal it refuses rather than hang. Uuids are sent in chunks of 100; if a chunk fails the command names it, reports how many records were deleted before that, and exits non-zero. Pass `--json` to print `{ "deleted", "requested" }`; a partial failure emits the standard failure object with `deleted`, `requested`, and `failedChunks` added                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `markpost events list [--kind <ok\|dim\|warn\|err>] [--source <uuid>] [--json]`                                                            | List the ingestion activity log (ok/dim/warn/err entries), newest first — the diagnostic counterpart to `records list`: a source that silently stops ingesting shows up here even when it produced no record. `--kind` narrows to one event kind and `--source` to one source by its uuid (see `sources list`); each may be given once and they combine. Both are sent to markpost as `filter[kind]` / `filter[sourceId]`. Pass `--json` for machine-readable output                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `markpost events export [--kind <ok\|dim\|warn\|err>] [--source <uuid>] [--out <path> [--force]\|--json]`                                  | Export the whole activity log (inside markpost's retention window), newest first, via markpost's dedicated export endpoint. Needs a token with the `events:read` scope. Same flags and behavior as `export`: `--out <path>` writes JSON to a file (`0o600`, refusing to overwrite without `--force`), `--json` prints a single JSON array, and `--out`/`--force` and `--json` cannot be combined. `--kind` / `--source` work as in `events list`, but markpost's export endpoint takes no filters, so they are applied to the downloaded rows (the server-side row cap still applies before filtering, so a truncated export is still flagged). A capped export, or one with malformed rows, still writes/prints the rows it did get, but warns and exits non-zero                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `markpost export [--out <path> [--force]\|--json]`                                                                                         | Export every record in the account (all statuses) via markpost's dedicated backup endpoint — a full-account dump, distinct from `records list` (paginated/filtered) and `sync`/`push` (pending records only). `--out <path>` writes the export as JSON to a file (owner-readable only, `0o600`, since it holds every record's private content), refusing to overwrite an existing file unless `--force` is also given; `--json` prints it as a single JSON array to stdout instead of a per-record summary; `--out`/`--force` and `--json` cannot be combined. A capped export, or one where the server returned a malformed row, still writes/prints the rows it did get, but warns and exits non-zero so a script can detect an incomplete backup via its exit code                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `markpost config <get\|set\|path> [key] [value] [--json]`                                                                                  | View or change the stored API token and output directory; `config get --json` prints machine-readable output (unset values are `null`, and the API token is always masked, never printed in full)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `markpost settings <get\|set> [key=value ...] [--json]`                                                                                    | View or change server-side sync settings (`autoSync`, `autoDelete`, `frontmatter`, `conflictStrategy`); `settings get --json` prints those four fields under markpost's contract attribute names                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `markpost doctor`                                                                                                                          | Check your setup without changing anything: config present, `BASE_URL` valid, API reachable, token accepted (needs `records:read`) and the output directory exists and is writable. Prints a PASS/FAIL line per check and exits non-zero if any fail. The token is never printed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `markpost help`                                                                                                                            | Show aggregated usage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `markpost --version` (or `-v` / `version`)                                                                                                 | Print the installed CLI version                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

The destructive fetch/write/delete sync runs only under the explicit
`markpost sync` command.

### JSON failure contract

Commands that accept `--json` (`get`, `config get`, `settings get`, `sources list`, `sources test`, `tokens list`, `records list`, `records update`, `records delete`, `events list`, `events export`, `export`) emit a
single, uniform failure shape so a script can parse **any** failure the same
way. On failure the CLI sets a non-zero exit code and prints one JSON object
to **stderr**:

```json
{ "error": "<code>", "message": "<human-readable explanation>" }
```

`error` is one of a small, stable set of machine-readable codes:

| `error` code      | When it happens                                                                                                                                                                                                                                                       | stdout                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `config_required` | A required value (API token or output directory) is not configured and `--json` mode will not prompt. Also includes a `missing` field naming the config key.                                                                                                          | nothing                                     |
| `usage`           | A bad or missing argument/subcommand, or `--json` passed where it is not supported.                                                                                                                                                                                   | nothing                                     |
| `fetch_failed`    | The requested operation could not be completed (a failed or empty fetch, or an error thrown while carrying it out — e.g. an auth/5xx failure). After an auth failure (HTTP 401/403), `message` ends with a pointer to the invite-only alpha waitlist.                 | nothing                                     |
| `partial_read`    | `records list`/`events list` paginated past the first page and a later page failed non-systemically, truncating the result; or `export`/`events export`'s result was capped at the server-side row limit and/or the server returned malformed rows that were skipped. | the JSON array of pages/rows fetched so far |

`partial_read` is the one exception to "stdout stays the clean `--json | jq`
data channel on failure": the pages already fetched are still valid data, so
they're printed as usual and the truncation is reported only via this object
on stderr and the non-zero exit — a script should check for `partial_read`
specifically (not just any non-zero exit) to know whether it's safe to still
consume stdout.

Any string in `message` that is server-derived is sanitized so it cannot inject
a live terminal escape sequence. During the invite-only alpha, a missing API
token's `config_required` message also ends with the waitlist link; the codes
and the `missing` field are unchanged. Additional fields (such as `missing`) may
appear alongside `error` and `message` depending on the code; consumers should
key off `error` and ignore unknown fields.

`markpost get` with more than one uuid applies this contract per uuid: each
uuid that is fetched and found missing prints its own `fetch_failed` object to
stderr and the exit code is non-zero, while stdout still carries the JSON
array of whichever records were found — a script should check the exit code
rather than assume a valid JSON array on stdout means every requested uuid was
returned. A systemic failure (auth, 5xx) aborts the rest of the batch
entirely, so any uuid after the one that triggered it produces **no**
per-uuid object at all — don't reconcile requested uuids against the count of
stderr objects; reconcile against the exit code and the records actually
returned.

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

Run `markpost sync --dry-run` to preview a sync before committing to it: it
fetches your pending records and reports the exact plan — which files would be
written (and whether each is a fresh write, an overwrite, or a skip under your
`conflictStrategy`) and which records would be deleted or marked synced on the
server — without writing any file, creating the output directory, deleting, or
marking anything. A dry run previews once and never self-schedules, even with
`autoSync` on.

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
markpost config set outputDirectory '~/notes'  # quote it: a leading ~, $HOME, or ${HOME} is expanded when writing
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

Create a `.envrc` in the repo root (it's gitignored) that exports the variables below. If you use [direnv](https://direnv.net/), run `direnv allow` to load them automatically.

| Variable           | Description                                                                                                                                                                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_TOKEN`        | API token for markpost.io                                                                                                                                                                                                                                       |
| `BASE_URL`         | Base URL of the sync API. Must be `https://`; plain `http://` is accepted only for `localhost`, `127.0.0.1`, or `[::1]` (e.g. `http://localhost:8888` for local dev). Anything else, or an unparseable value, is refused before the token is sent               |
| `OUTPUT_DIRECTORY` | Path to the directory where synced files are written; a leading `~`, `$HOME`, or `${HOME}` is expanded to your home directory. A relative path is resolved against the current working directory, so prefer an absolute path or a `~` prefix for scheduled runs |

### Scripts

| Command                               | Description                                                                   |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| `npm run build`                       | Compile TypeScript to `dist/`                                                 |
| `npm run watch`                       | Watch and recompile on changes                                                |
| `npm test`                            | Run tests with Vitest                                                         |
| `npm run test:ci`                     | Run tests once (CI mode)                                                      |
| `npm run test:ui`                     | Run tests with Vitest UI                                                      |
| `npm run lint`                        | Check formatting and linting                                                  |
| `npm run lint:fix`                    | Auto-fix formatting and linting issues                                        |
| `npm run sync:contract`               | Refresh the vendored markpost API contract (see below)                        |
| `npm run sync:markdown-serialization` | Refresh the vendored markpost serialization slice (see below)                 |
| `npm run sync:source-endpoints`       | Refresh the vendored markpost ingest-endpoint constants (see below)           |
| `npm run sync:source-contract`        | Refresh the vendored markpost source-type/webhook-secret contract (see below) |
| `npm run sync:settings-contract`      | Refresh the vendored markpost settings contract (see below)                   |
| `npm run sync:scopes-contract`        | Refresh the vendored markpost token scope allowlist (see below)               |

### Contract sync

The CLI talks to the markpost server's API, so its
request/response types need to match markpost's real contract exactly — a
structural mismatch here previously caused real pagination and
error-swallowing bugs. Instead of hand-mirroring markpost's types (which drift
silently), `src/types/vendor/markpost-api.types.ts` is a vendored, verbatim
copy of markpost's `server/types/api.types.ts`, and `src/types/api.types.ts`
re-exports the generic envelope types (`ApiError`, `ApiRequest`,
`ApiResourceObject`, `ApiResponse`) from it. The markpost server repo is
private, so every `sync:*` script requires access to it.

- **Refreshing it:** run `npm run sync:contract` (optionally
  `-- --from <path-to-a-local-markpost-checkout>`; without `--from` it
  clones markpost fresh, full history and blobless). This is a **human-run** step, not part of
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
- **What this does _not_ do:** it does not detect when markpost's _real_
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
  clones markpost fresh, full history and blobless). Like the contract sync this is a
  **human-run** step, not part of CI — it needs network access (or a local
  checkout). It extracts just the serialization slice of `markdown.ts` (the
  four functions above plus the two types they use, leaving the
  turndown-dependent server code behind) and writes it verbatim to
  `tests/libs/vendor/markpost-markdown-serialization.generated.ts`, alongside a
  manifest recording the exact source commit. The file lives under `tests/` so
  it never ships in the published `dist/`. Review the diff, run `npm test`,
  then commit.
- **Catching drift:** `tests/libs/frontmatter-drift.test.ts` runs on every
  `npm test` / `npm run test:ci`. It executes markpost's _real_ (vendored)
  serialization functions and the CLI's mirrored ones over a shared battery of
  inputs — plain values, empty and multi-tag lists, every YAML metacharacter,
  whitespace, and escape sequences — and fails if any input serializes
  differently. No network access needed. When markpost's serialization
  changes, re-run the sync: the vendored slice updates, and if the CLI mirror
  has not been updated to match, this test goes red.
- **What this does _not_ do:** it does not detect when markpost's upstream
  serialization has changed and the vendored slice has fallen behind — that
  would require network access at test time. Re-run
  `npm run sync:markdown-serialization` whenever a markpost markdown change is
  suspected.

### Scopes contract sync

`tokens create|update --scopes` validates against markpost's token scope
allowlist (`SCOPES` in `shared/utils/scopes.ts`). `npm run sync:scopes-contract`
(optionally `-- --from <path-to-a-local-markpost-checkout>`) extracts the scope
names into `src/types/vendor/markpost-scopes.generated.ts` (plus a manifest
with the source commit). Unlike the other vendored contracts it lives under
`src/`, because the CLI needs it at runtime. Human-run, not part of CI; re-run
it when markpost adds or renames a scope, review the diff, run `npm test`,
then commit.

### Source endpoint sync

`src/commands/sources.ts` hand-copies two constants from markpost's
`app/composables/useSources.ts` — `WEBHOOK_INGEST_BASE` (the webhook ingest
base URL) and `EMAIL_DOMAIN` (the email-forwarding domain). These are the
exact endpoint URLs a user configures their provider or email forwarder
against, so a silent drift here means the CLI prints a dead URL with nothing
failing to catch it. This closes that gap the same way the contract and
markdown serialization syncs do.

- **Refreshing it:** run `npm run sync:source-endpoints` (optionally
  `-- --from <path-to-a-local-markpost-checkout>`; without `--from` it
  clones markpost fresh, full history and blobless). Like the other syncs this is a **human-run**
  step, not part of CI — it needs network access (or a local checkout). It
  extracts the two constants' string values from `useSources.ts` and writes them to
  `tests/libs/vendor/markpost-source-endpoints.generated.ts`, alongside a
  manifest recording the exact source commit. The file lives under `tests/` so
  it never ships in the published `dist/`. Review the diff, run `npm test`,
  then commit.
- **Catching drift:** `tests/libs/source-endpoints-drift.test.ts` runs on
  every `npm test` / `npm run test:ci` and fails if the CLI's
  `WEBHOOK_INGEST_BASE` or `EMAIL_DOMAIN` stop matching the vendored copy
  byte-for-byte. No network access needed. When markpost's endpoints change,
  re-run the sync: the vendored constants update, and if the CLI mirror has
  not been updated to match, this test goes red.
- **What this does _not_ do:** it does not detect when markpost's upstream
  endpoints have changed and the vendored copy has fallen behind — that would
  require network access at test time. Re-run `npm run sync:source-endpoints`
  periodically or whenever a markpost ingest-endpoint change is suspected. It
  also only guards the two constants themselves, not how the CLI assembles a
  URL from them (`buildEndpointUrl` in `src/commands/sources.ts`) — if
  markpost changes the shape it builds around `WEBHOOK_INGEST_BASE` /
  `EMAIL_DOMAIN` (e.g. an added path segment) without changing the constants,
  this guard won't catch it.

### Source and settings contract sync

`src/types/sources.types.ts` (`SOURCE_TYPES`, `MANUAL_SECRET_PROVIDERS`,
`SECRET_BACKED_PROVIDERS`, `ROTATABLE_PROVIDERS`) and
`src/types/settings.types.ts` (`CONFLICT_STRATEGIES`,
`DEFAULT_CONFLICT_STRATEGY`, `DEFAULT_AUTO_DELETE`, `DEFAULT_AUTO_SYNC`,
`DEFAULT_FRONTMATTER_ENABLED`) hand-mirror markpost's real source-type,
webhook-secret, and settings contracts. Until now those two files had no
vendored copy and no drift test — just a test that hardcoded today's values,
which is exactly what let `sources.types.ts` list a source type (`rss`) that
markpost had already dropped (markpost#116, issue #78): the hardcoded
expectation drifted right alongside the mirror instead of catching it. This
closes that gap the same way `sync:contract` and
`sync:markdown-serialization` do.

- **Refreshing it:** run `npm run sync:source-contract` and
  `npm run sync:settings-contract` (each optionally takes
  `-- --from <path-to-a-local-markpost-checkout>`; without `--from` they
  clone markpost fresh — full history, blobless (`--filter=blob:none`), not
  a shallow `--depth 1` clone, since per-path commit history needs the real
  log). Like the other syncs these are **human-run** steps, not part of CI —
  they need network access (or a local checkout). A `--from` checkout that
  turns out to be shallow is rejected with a clear error rather than silently
  recording the wrong commit for every vendored file.
  - `sync:source-contract` vendors markpost's `shared/utils/sourceTypes.ts`
    and `shared/utils/webhookSecrets.ts` verbatim (both are self-contained,
    with no imports) into `tests/types/vendor/markpost-source-types.generated.ts`
    and `tests/types/vendor/markpost-webhook-secrets.generated.ts`.
  - `sync:settings-contract` extracts just `CONFLICT_STRATEGIES` from
    markpost's `server/utils/response.ts` and just the `autoSync` /
    `autoDelete` / `frontmatter` / `conflictStrategy` column defaults from the
    `userSettings` table in `server/db/schema.ts` (the rest of both files is
    irrelevant to the CLI) into
    `tests/types/vendor/markpost-settings-contract.generated.ts`.

  Both write a manifest recording the exact source commit(s) they synced
  from. Review the diff, run `npm test`, then commit.

- **Catching drift:** `tests/types/sources.types.test.ts` and
  `tests/types/settings.types.test.ts` run on every `npm test` /
  `npm run test:ci` and compare the CLI's mirrored constants against the
  vendored copies, failing the moment they diverge. No network access needed.
- **What this does _not_ do:** like the other syncs, it does not detect when
  markpost's upstream contract has changed and the vendored copy has fallen
  behind — that would require network access at test time. Re-run both sync
  scripts periodically or whenever a markpost source/webhook/settings change
  is suspected.

## Releasing

Releases are published by [`.github/workflows/release.yml`](.github/workflows/release.yml)
when a `vX.Y.Z` or `vX.Y.Z-<preid>.N` tag is pushed. The workflow fails unless
the tag matches the `version` in `package.json`, then runs lint, typecheck,
`test:ci` and the packed-artifact smoke test ([`scripts/smoke-test-pack.sh`](scripts/smoke-test-pack.sh))
before `npm stage publish --provenance`, which attaches a signed supply-chain
attestation to the package. The workflow only **stages** the release: nothing
reaches npm until a maintainer approves it with 2FA (step 3 below).

The npm dist-tag comes from the version, never from `publishConfig`:

| `package.json` version | npm dist-tag | Installed by                |
| ---------------------- | ------------ | --------------------------- |
| `1.2.3`                | `latest`     | `npm i @markpost/cli`       |
| `0.1.0-alpha.0`        | `alpha`      | `npm i @markpost/cli@alpha` |
| `2.0.0-rc.1`           | `rc`         | `npm i @markpost/cli@rc`    |

To cut a release:

1. On a branch, bump `version` in `package.json` (`npm run release:alpha` for
   the next alpha), then open a PR and merge it to `main`.
2. `git checkout main && git pull && npm run release:tag`. This creates and
   pushes `v<version>` from `package.json`, so the tag always matches.
   `node scripts/release-tag.mjs --dry-run` prints the commands without
   running them. A tag pushed from a commit that isn't on `main` is rejected
   by the workflow; delete it with `git push origin :v<version>`.
3. Once the workflow passes, approve the staged release:
   `npm stage list @markpost/cli` to find its stage id, then
   `npm stage approve <stage-id>` (prompts for 2FA). To discard it instead,
   run `npm stage reject <stage-id>`.

### One-time npm setup (trusted publishing, no token)

The publish job authenticates with GitHub OIDC (`id-token: write`), so no
`NPM_TOKEN` secret is stored. A maintainer must configure this once:

1. Make sure `@markpost/cli` exists on npm. npm only lets you attach a trusted
   publisher to an existing package, so if it has never been published, do the
   very first publish by hand from a clean checkout of `main`, passing the
   dist-tag explicitly (`npm publish --access public --tag alpha` for an alpha
   version). Don't push that version's tag afterwards: the workflow would try
   to republish it and fail.
2. On npmjs.com open the package, then **Settings > Trusted Publisher > GitHub
   Actions** and enter: organization `neonpixels-studio`, repository
   `markpost-cli`, workflow filename `release.yml`, environment blank. Under
   **Allowed actions** leave **Allow npm publish** and **Allow npm dist-tag**
   unchecked, so the workflow can only stage releases.
3. Optionally set **Publishing access** to "Require two-factor authentication
   and disallow tokens" so only the workflow can publish.

Trusted publishing and `npm stage` need a recent npm; the npm bundled with the
Node version pinned in `.nvmrc` (11.19.1) supports both.

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
