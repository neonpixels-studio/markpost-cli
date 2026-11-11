import {
  extractFrontmatterTagsWithDiagnostics,
  stripFrontmatterDocument,
} from '#src/libs/frontmatter.js';

// The `markpost push` argument that means "read the note from stdin", the
// standard CLI convention (`pbpaste | markpost push -`).
export const STDIN_ARGUMENT = '-';

// Label used in place of a file path in push output, since piped input has no
// filename.
export const STDIN_LABEL = '<stdin>';

const TITLE_HEADING_PATTERN = /^ {0,3}#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const BYTE_ORDER_MARK_PATTERN = /^\uFEFF/;
const FRONTMATTER_FENCE = '---';
const CODE_FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

export type ReadInput = () => Promise<string>;

export interface ParsedNote {
  title: string;
  content: string;
  tags: string[];
  tagsLineUnparseable?: boolean;
}

export class StdinInputError extends Error {}

export const TTY_ERROR =
  'Nothing piped to stdin. Pipe a note in (e.g. `pbpaste | markpost push -`) or pass a file path.';
export const EMPTY_ERROR = 'Stdin was empty; there is no note to push.';

export interface ReadableInput {
  isTTY?: boolean;
  setEncoding(encoding: BufferEncoding): unknown;
  [Symbol.asyncIterator](): AsyncIterator<string | Buffer>;
}

// Reads the whole of stdin as UTF-8. Errors immediately on a terminal rather
// than blocking forever waiting for an EOF the user never sends.
export const readStdinText = async (
  input: ReadableInput = process.stdin,
): Promise<string> => {
  if (input.isTTY) {
    throw new StdinInputError(TTY_ERROR);
  }

  input.setEncoding('utf-8');
  let text = '';

  for await (const chunk of input) {
    text += chunk;
  }

  return text;
};

// Lines after any leading markpost frontmatter block, so a `title:` line or
// `---` rule is never mistaken for a heading.
const bodyLines = (rawContent: string): string[] => {
  const lines = rawContent.split(/\r?\n/);

  if (lines[0] !== FRONTMATTER_FENCE) {
    return lines;
  }

  const closingIndex = lines.indexOf(FRONTMATTER_FENCE, 1);

  return closingIndex === -1 ? lines : lines.slice(closingIndex + 1);
};

const headingTitle = (line: string): string | null => {
  const title = TITLE_HEADING_PATTERN.exec(line)?.[1].trim();

  return title || null;
};

// CommonMark: a fence closes on the same character, at least as long as the
// opener, with nothing after it but whitespace.
const closesFence = (
  openFence: string,
  fence: string,
  info: string,
): boolean => {
  return (
    fence[0] === openFence[0] &&
    fence.length >= openFence.length &&
    info.trim() === ''
  );
};

// The first level-1 heading outside a fenced code block, or null.
const firstHeading = (rawContent: string): string | null => {
  let openFence: string | null = null;

  for (const line of bodyLines(rawContent)) {
    const match = CODE_FENCE_PATTERN.exec(line);

    if (match && openFence === null) {
      openFence = match[1];
      continue;
    }

    if (match && openFence !== null) {
      openFence = closesFence(openFence, match[1], match[2]) ? null : openFence;
      continue;
    }

    const title = openFence === null ? headingTitle(line) : null;

    if (title) {
      return title;
    }
  }

  return null;
};

// Piped input has no filename, so the title is the first `# ` heading (which
// also covers markpost's own `# <title>` document layout), falling back to a
// timestamp so a headingless capture still pushes.
export const deriveStdinTitle = (
  rawContent: string,
  now: Date = new Date(),
): string => {
  return firstHeading(rawContent) ?? `Note ${now.toISOString()}`;
};

// Parses piped text exactly like a file's contents (same frontmatter and tag
// handling as readMarkdown), differing only in how the title is derived.
export const parseStdinNote = (
  input: string,
  now: Date = new Date(),
): ParsedNote => {
  const rawContent = input.replace(BYTE_ORDER_MARK_PATTERN, '');

  if (rawContent.trim().length === 0) {
    throw new StdinInputError(EMPTY_ERROR);
  }

  const { tags, tagsLineUnparseable } =
    extractFrontmatterTagsWithDiagnostics(rawContent);

  return {
    title: deriveStdinTitle(rawContent, now),
    content: stripFrontmatterDocument(rawContent),
    tags,
    tagsLineUnparseable,
  };
};
