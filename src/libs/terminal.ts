// Control-character code points to strip before printing untrusted text: the
// C0 range (0x00–0x1f), DEL (0x7f), and the C1 range (0x80–0x9f, which carries
// 8-bit CSI/OSC that some terminals still act on).
const LAST_C0_CONTROL_CODE = 0x1f;
const DELETE_CONTROL_CODE = 0x7f;
const FIRST_C1_CONTROL_CODE = 0x80;
const LAST_C1_CONTROL_CODE = 0x9f;

// TAB and LF are the two C0 characters that legitimately structure multi-line
// text (record content), so the block variant keeps them. CR is deliberately
// NOT here: a carriage return moves the cursor to the column start and is the
// exact character that enables line-overwrite spoofing, so it stays stripped.
const TAB_CODE = 0x09;
const LINE_FEED_CODE = 0x0a;

function isDangerousControlCode(codePoint: number): boolean {
  const isC1Control =
    codePoint >= FIRST_C1_CONTROL_CODE && codePoint <= LAST_C1_CONTROL_CODE;
  return (
    codePoint <= LAST_C0_CONTROL_CODE ||
    codePoint === DELETE_CONTROL_CODE ||
    isC1Control
  );
}

// Replace control characters in any API-controlled string before it reaches the
// terminal. A record title, record content, or source name is untrusted (see
// markdown.ts slugifyTitle), so text carrying ANSI escapes could otherwise
// clear the screen or overwrite earlier output, including a failure warning,
// with fabricated text. Done by code point rather than a regex to avoid
// embedding control characters in source (eslint no-control-regex).
// `allowLineBreaks` keeps TAB/LF so multi-line markdown survives; leave it off
// for single-line fields (titles, uuids, composed status lines) where a stray
// newline could itself inject a fake line.
function sanitize(value: string, allowLineBreaks: boolean): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;

    if (
      allowLineBreaks &&
      (codePoint === LINE_FEED_CODE || codePoint === TAB_CODE)
    ) {
      return character;
    }

    return isDangerousControlCode(codePoint) ? ' ' : character;
  }).join('');
}

// Single-line fields: strips every control character, including LF/TAB. Any
// uuid printed alongside keeps the item identifiable even if the title is
// emptied.
export function sanitizeForTerminal(value: string): string {
  return sanitize(value, false);
}

// Multi-line content (e.g. a record's markdown body): preserves LF and TAB so
// the document keeps its structure, while still stripping CR and every other
// control/ANSI escape.
export function sanitizeBlockForTerminal(value: string): string {
  return sanitize(value, true);
}
