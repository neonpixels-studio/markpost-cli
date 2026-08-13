// Shared `--json` output for the read commands (`get`, `records list`,
// `sources list`): emit a value as clean, indented JSON on stdout and nothing
// else — no chalk, no field labels, no sanitizing. JSON.stringify already escapes every control
// byte to its printable \u form, so an untrusted API string can't inject a live
// terminal escape through this path. That is why, unlike the pretty printers,
// the JSON path deliberately keeps the data faithful instead of routing it
// through the terminal sanitizer.
export const printJson = (value: unknown): void => {
  console.log(JSON.stringify(value, null, 2));
};
