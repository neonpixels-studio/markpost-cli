// Control-character code points to strip before printing untrusted text: the
// C0 range (0x00–0x1f), DEL (0x7f), and the C1 range (0x80–0x9f, which carries
// 8-bit CSI/OSC that some terminals still act on).
const LAST_C0_CONTROL_CODE = 0x1f;
const DELETE_CONTROL_CODE = 0x7f;
const FIRST_C1_CONTROL_CODE = 0x80;
const LAST_C1_CONTROL_CODE = 0x9f;

function isControlCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  const isC1Control =
    codePoint >= FIRST_C1_CONTROL_CODE && codePoint <= LAST_C1_CONTROL_CODE;
  return (
    codePoint <= LAST_C0_CONTROL_CODE ||
    codePoint === DELETE_CONTROL_CODE ||
    isC1Control
  );
}

// Replace control characters (C0 range + DEL + C1 range) in any API-controlled
// string before it reaches the terminal. A record title, record content, or
// source name is untrusted (see markdown.ts slugifyTitle), so text carrying
// ANSI escapes could otherwise clear the screen or overwrite earlier output,
// including a failure warning, with fabricated text. Done by code point rather
// than a regex to avoid embedding control characters in source (eslint
// no-control-regex). Any uuid printed alongside keeps the item identifiable
// even if the title is emptied.
export function sanitizeForTerminal(value: string): string {
  return Array.from(value, (character) =>
    isControlCharacter(character) ? ' ' : character,
  ).join('');
}
