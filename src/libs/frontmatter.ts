import { Frontmatter, Record } from '@/types/records.types.js';

// Faithful mirror of markpost's server/utils/markdown.ts frontmatter assembly
// (`quoteYamlScalar`, `serializeTagsLine`, `serializeFrontmatter`,
// `assembleMarkdownDocument`). markpost is the source of truth: synced files
// must be byte-identical to what markpost would write, so the serialization
// here is kept deliberately in lockstep with that file. Update both together.

const FRONTMATTER_DELIMITER = '---';
const HEADING_PREFIX = '# ';
const BLOCK_SEPARATOR = '\n\n';
const EMPTY_TAGS_LINE = 'tags: []';
// A synced document opens with the delimiter on its own line.
const FRONTMATTER_OPENING = `${FRONTMATTER_DELIMITER}\n`;
// The closing delimiter as it appears in an assembled document: the newline
// ending the last frontmatter line, `---` on its own line, then the block
// separator before the heading. Matching the full sequence (not a bare `---`)
// means a frontmatter value that happens to be `---` can't end the block early.
const FRONTMATTER_CLOSING = `\n${FRONTMATTER_DELIMITER}${BLOCK_SEPARATOR}`;
const BYTE_ORDER_MARK = '\uFEFF';
const CARRIAGE_RETURN = '\r';
// serializeFrontmatter emits exactly these four keys, in this order. Matching
// the full signature (not just "looks like YAML") means only a block markpost
// itself wrote is reversed — a hand-authored note's own frontmatter, or prose
// that merely opens with a `---` thematic break, is never stripped on push.
const FRONTMATTER_KEY_PREFIXES = [
  'title: ',
  'source: ',
  'created: ',
  'tags: ',
] as const;
const TITLE_LINE_INDEX = 0;
const CREATED_LINE_INDEX = 2;
// markpost's `created` is always an ISO-8601 string (resolveCreatedDate →
// toISOString). Used both to reject a malformed `created` when building a
// document (asTimestamp) and to confirm a block's `created` line is markpost's
// on read-back (isFrontmatterBlock) rather than a hand-typed value.
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}(?:[T ][0-9:.+Z-]*)?$/;
// Any of these characters give a bare YAML scalar a second meaning (map key,
// flow collection, anchor, comment, quote, ...), so a value containing one
// must be quoted to survive a round-trip through a real YAML parser.
const YAML_SPECIAL_CHARACTERS = /[:#[\]{}&!|>'"%@`,]/;

const quoteYamlScalar = (value: string): string => {
  const needsQuoting =
    YAML_SPECIAL_CHARACTERS.test(value) ||
    value.includes('\n') ||
    value.trim() !== value;

  if (!needsQuoting) {
    return value;
  }

  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');

  return `"${escaped}"`;
};

// Reverses quoteYamlScalar: a quoted scalar is unwrapped and its `\\`, `\"`,
// and `\n` escapes decoded; an unquoted scalar is returned verbatim. Needed to
// rebuild the raw title for heading comparison, since markpost writes the title
// quoted in the frontmatter but raw in the `# ` heading.
const unquoteYamlScalar = (value: string): string => {
  const isQuoted =
    value.length >= 2 && value.startsWith('"') && value.endsWith('"');

  if (!isQuoted) {
    return value;
  }

  return value.slice(1, -1).replace(/\\(.)/g, (_match, escaped) => {
    return escaped === 'n' ? '\n' : escaped;
  });
};

const serializeTagsLine = (tags: string[]): string => {
  if (tags.length === 0) {
    return EMPTY_TAGS_LINE;
  }

  const quotedTags = tags.map((tag) => quoteYamlScalar(tag)).join(', ');

  return `tags: [${quotedTags}]`;
};

export const serializeFrontmatter = (frontmatter: Frontmatter): string => {
  return [
    FRONTMATTER_DELIMITER,
    `title: ${quoteYamlScalar(frontmatter.title)}`,
    `source: ${quoteYamlScalar(frontmatter.source)}`,
    `created: ${frontmatter.created}`,
    serializeTagsLine(frontmatter.tags),
    FRONTMATTER_DELIMITER,
  ].join('\n');
};

type MarkdownDocument = {
  title: string;
  body: string;
  frontmatter: Frontmatter;
};

export const assembleMarkdownDocument = (
  document: MarkdownDocument,
): string => {
  const frontmatterBlock = serializeFrontmatter(document.frontmatter);

  return `${frontmatterBlock}${BLOCK_SEPARATOR}${HEADING_PREFIX}${document.title}${BLOCK_SEPARATOR}${document.body}`;
};

// writeMarkdown emits LF-only with no BOM, but an editor may re-save a pulled
// file with a UTF-8 BOM or CRLF line endings. Normalize both before matching
// so the strip still fires; otherwise it would silently no-op on those files
// and markpost would double-wrap the frontmatter this is meant to remove.
const normalizeForStrip = (content: string): string => {
  const withoutBom = content.startsWith(BYTE_ORDER_MARK)
    ? content.slice(BYTE_ORDER_MARK.length)
    : content;

  return withoutBom.split(`${CARRIAGE_RETURN}\n`).join('\n');
};

const lineValue = (blockLines: string[], index: number): string => {
  return blockLines[index].slice(FRONTMATTER_KEY_PREFIXES[index].length);
};

// True only for markpost's exact four-line, fixed-order block whose `created`
// value is an ISO-8601 timestamp. Prose whose opening `---` is a thematic
// break, a note with different keys, or a hand-authored block with the same
// keys but a typed date (`created: yesterday`) all have a different shape and
// are left alone — pushing such a file never eats its lines or the user's
// metadata.
const isFrontmatterBlock = (blockLines: string[]): boolean => {
  if (blockLines.length !== FRONTMATTER_KEY_PREFIXES.length) {
    return false;
  }

  const everyKeyMatches = FRONTMATTER_KEY_PREFIXES.every((keyPrefix, index) =>
    blockLines[index].startsWith(keyPrefix),
  );

  if (!everyKeyMatches) {
    return false;
  }

  return TIMESTAMP_PATTERN.test(lineValue(blockLines, CREATED_LINE_INDEX));
};

// The serialized value of the block's `title:` line, used to confirm the
// following heading is the one markpost mirrors from the title rather than a
// heading the user wrote themselves.
const serializedTitleOf = (blockLines: string[]): string => {
  return lineValue(blockLines, TITLE_LINE_INDEX);
};

// The body after the `# <title>` heading assembleMarkdownDocument writes, or
// null when `content` does not begin with exactly that heading — signalling the
// caller not to strip the frontmatter either, since only the complete
// block+heading+body shape is markpost's. The expected heading is rebuilt from
// the block's title (unquoted, since the heading uses the raw title while the
// block stores it quoted), which also covers a title carrying a newline — its
// heading spans two lines. It must be followed by a line boundary so `# Deploy`
// doesn't match `# Deployment`. The separator after the heading is normally
// `\n\n`, but an editor that trims a trailing blank line off an empty-body
// record can leave a single `\n` or none, so tolerate up to two newlines.
const bodyAfterMirroredHeading = (
  content: string,
  serializedTitle: string,
): string | null => {
  // `content` is already normalized (LF, no BOM), so normalize the rebuilt
  // heading too — a title carrying a raw CR would otherwise never match.
  const expectedHeading = normalizeForStrip(
    `${HEADING_PREFIX}${unquoteYamlScalar(serializedTitle)}`,
  );

  if (!content.startsWith(expectedHeading)) {
    return null;
  }

  const afterHeading = content.slice(expectedHeading.length);

  if (afterHeading !== '' && !afterHeading.startsWith('\n')) {
    return null;
  }

  return afterHeading.replace(/^\n{0,2}/, '');
};

// Inverse of assembleMarkdownDocument. A record pulled to disk is stored as
// `<frontmatter>\n\n# <title>\n\n<body>`; pushing that file back unchanged
// would send the whole thing as the body and markpost would wrap it in a
// second frontmatter block. Strip the frontmatter block and the mirrored
// heading so only the body is pushed. Only the complete structure markpost
// emits is reversed — block, `# <title>` heading, and body must all line up;
// anything else (no leading block, a `---` thematic break in prose, a block not
// closed the way markpost closes it, a block whose following heading is not the
// title) is returned untouched, original bytes and BOM/CRLF included. When it
// IS stripped the returned body is LF-normalized — the document was a
// markpost-composed LF file, so this only affects a copy an editor re-encoded.
export const stripFrontmatterDocument = (content: string): string => {
  const normalized = normalizeForStrip(content);

  if (!normalized.startsWith(FRONTMATTER_OPENING)) {
    return content;
  }

  const closingIndex = normalized.indexOf(
    FRONTMATTER_CLOSING,
    FRONTMATTER_OPENING.length,
  );

  if (closingIndex === -1) {
    return content;
  }

  const blockLines = normalized
    .slice(FRONTMATTER_OPENING.length, closingIndex)
    .split('\n');

  if (!isFrontmatterBlock(blockLines)) {
    return content;
  }

  const afterFrontmatter = normalized.slice(
    closingIndex + FRONTMATTER_CLOSING.length,
  );
  const body = bodyAfterMirroredHeading(
    afterFrontmatter,
    serializedTitleOf(blockLines),
  );

  // No mirrored heading means this isn't a markpost-composed document; leave it
  // whole rather than stripping a block that may be a note's own frontmatter.
  if (body === null) {
    return content;
  }

  return body;
};

const isPlainObject = (value: unknown): value is { [key: string]: unknown } => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const asString = (value: unknown, fallback: string): string => {
  return typeof value === 'string' ? value : fallback;
};

const asStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string');
};

// markpost's `created` is serialized unquoted, so mirroring it verbatim would
// let malformed API JSON (a `created` carrying a newline or a YAML control
// character) inject frontmatter keys. Accept only a date-shaped string (see
// TIMESTAMP_PATTERN) and otherwise fall back to the record's `createdAt`, so
// valid timestamps stay byte-identical to markpost while junk can't break out.
const asTimestamp = (value: unknown, fallback: string): string => {
  if (typeof value === 'string' && TIMESTAMP_PATTERN.test(value)) {
    return value;
  }

  return fallback;
};

// The stored frontmatter object is markpost's single source of truth for a
// record's metadata, so key assembly off its presence: re-deriving `created`
// from the record's `createdAt` (the row's insert time) would diverge from the
// payload-resolved date markpost baked into the frontmatter. Its fields are
// typed but arrive as untrusted API JSON, so each is guarded with a fallback
// rather than assumed well-formed.
const normalizeFrontmatter = (record: Record): Frontmatter | null => {
  const raw = record.frontmatter;

  if (!isPlainObject(raw)) {
    return null;
  }

  return {
    title: asString(raw.title, record.title),
    source: asString(raw.source, record.source ?? ''),
    created: asTimestamp(raw.created, record.createdAt),
    tags: asStringArray(raw.tags),
  };
};

// Builds the full .md file contents for a record: a frontmatter block, title
// heading, and body when the record carries markpost-assembled metadata;
// otherwise the bare content (records with no frontmatter, e.g. `markpost
// push` created). `includeFrontmatter` is the user's `frontmatter` setting —
// when off, the record takes the same bare-content path as a record that has
// no frontmatter at all (the heading is only ever emitted alongside a
// frontmatter block), so "frontmatter disabled" writes just the body.
export const buildRecordDocument = (
  record: Record,
  includeFrontmatter = true,
): string => {
  const frontmatter = includeFrontmatter ? normalizeFrontmatter(record) : null;

  if (!frontmatter) {
    return record.content;
  }

  // Use the frontmatter's title for the heading too, so the block title and
  // the `# ` heading always agree (matching markpost, which writes one title
  // in both places from a single parsed payload).
  return assembleMarkdownDocument({
    title: frontmatter.title,
    body: record.content,
    frontmatter,
  });
};
