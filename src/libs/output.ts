// DEL (0x7f) and the C1 control range (0x80–0x9f). JSON.stringify escapes the
// C0 range (0x00–0x1f) but leaves these untouched, and some terminals decode
// UTF-8 C1 bytes as 8-bit CSI/OSC and act on them — the same threat terminal.ts
// guards the pretty path against. They're matched by code point rather than a
// regex to keep control characters out of the source (eslint no-control-regex),
// mirroring terminal.ts.
const DELETE_CONTROL_CODE = 0x7f;
const FIRST_C1_CONTROL_CODE = 0x80;
const LAST_C1_CONTROL_CODE = 0x9f;

const isResidualControlCode = (codePoint: number): boolean => {
  if (codePoint === DELETE_CONTROL_CODE) {
    return true;
  }

  return (
    codePoint >= FIRST_C1_CONTROL_CODE && codePoint <= LAST_C1_CONTROL_CODE
  );
};

// Re-escape the control characters JSON.stringify passes through raw (DEL and
// the C1 range) to their printable \uXXXX form. The result is still valid,
// lossless JSON — an escaped code point round-trips through JSON.parse — so no
// data is dropped, unlike the pretty path's sanitizer which blanks the byte.
const escapeResidualControls = (json: string): string =>
  Array.from(json, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;

    if (!isResidualControlCode(codePoint)) {
      return character;
    }

    return `\\u${codePoint.toString(16).padStart(4, '0')}`;
  }).join('');

// Shared `--json` output for the read commands (`get`, `records list`,
// `sources list`): emit a value as clean, indented JSON on stdout and nothing
// else — no chalk, no field labels. JSON.stringify escapes the C0 range and
// escapeResidualControls covers DEL + C1, so an untrusted API string can't
// inject a live terminal escape through this path. That is why, unlike the
// pretty printers, the JSON path keeps the data faithful (a control byte
// survives as its \u escape) instead of blanking it via the terminal sanitizer.
export const printJson = (value: unknown): void => {
  const json = JSON.stringify(value, null, 2);

  // JSON.stringify returns undefined for a non-serializable top-level value
  // (undefined, a function, a symbol). Today's callers guard against that, but
  // the `unknown` signature invites it, so fail with a clear message rather
  // than letting `escapeResidualControls(undefined)` throw an opaque TypeError.
  if (json === undefined) {
    throw new Error('Cannot print a non-serializable value as JSON.');
  }

  console.log(escapeResidualControls(json));
};

// Machine-readable `error` codes for the unified `--json` failure contract. A
// `--json` consumer switches on these, so they are part of the CLI's public
// contract and must stay stable — see README "JSON failure contract". Every
// failure classifies into exactly one: a missing/unconfigured value, a bad
// argument or usage, or a failed request/result.
export const JSON_ERROR_CONFIG_REQUIRED = 'config_required';
export const JSON_ERROR_USAGE = 'usage';
export const JSON_ERROR_FETCH_FAILED = 'fetch_failed';

const JSON_FLAG = '--json';

// Detect `--json` straight from argv, independent of a command's `parseArgs`
// (which throws on an unrelated bad flag before it can report whether `--json`
// was set). The failure path needs this so a malformed invocation that also
// passed `--json` still fails in the JSON contract rather than chalk prose.
export const hasJsonFlag = (args: string[]): boolean =>
  args.includes(JSON_FLAG);

// The single serializer for every `--json` failure. Config, argument/usage,
// and fetch/result errors all route through here so a script parsing stderr
// sees one documented shape: `{ "error": <code>, "message": <string>, ... }`.
// Written to stderr, never stdout — stdout is the `--json | jq` data channel
// and a valid-JSON error there would be silently parsed as data. Reuses
// escapeResidualControls because `message` can be server-derived, so an
// untrusted API string must not smuggle a live terminal escape onto stderr.
export const printJsonError = (
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): void => {
  const json = JSON.stringify({ error: code, message, ...details });

  console.error(escapeResidualControls(json));
};
