// GENERATED FILE — do not hand-edit.
//
// This is a verbatim copy of the frontmatter-serialization slice of markpost's
// `server/utils/markdown.ts` (the pure `quoteYamlScalar`, `serializeTagsLine`,
// `serializeFrontmatter`, and `assembleMarkdownDocument` functions plus the
// two types they use). markpost is the source of truth; the CLI's
// `src/libs/frontmatter.ts` hand-mirrors it, so the drift test at
// `tests/libs/frontmatter-drift.test.ts` runs this copy against the mirror and
// fails if they stop producing byte-identical output.
//
// It lives under `tests/` so it never ships in the published `dist/`.
//
// Regenerate with `npm run sync:markdown-serialization`
// (see README.md#markdown-serialization-sync). Review the diff, then commit.
//
// Source: neonpixels-studio/markpost @ server/utils/markdown.ts
// See markpost-markdown-serialization.manifest.json for the exact commit.

/* eslint-disable */

export type FrontmatterObject = {
  title: string;
  source: string;
  created: string;
  tags: string[];
};

export type ParsedPayload = {
  title: string;
  body: string;
  frontmatter: FrontmatterObject;
  tags: string[];
  filePath: string;
};

function quoteYamlScalar(value: string): string {
  const needsQuoting =
    /[:#\[\]{}&!|>'"%@`,]/.test(value) ||
    /\n/.test(value) ||
    value.trim() !== value;
  if (!needsQuoting) {
    return value;
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function serializeTagsLine(tags: string[]): string {
  if (tags.length === 0) {
    return "tags: []";
  }
  const quotedTags = tags.map((tag) => quoteYamlScalar(tag)).join(", ");
  return `tags: [${quotedTags}]`;
}

export function serializeFrontmatter(frontmatter: FrontmatterObject): string {
  return [
    "---",
    `title: ${quoteYamlScalar(frontmatter.title)}`,
    `source: ${quoteYamlScalar(frontmatter.source)}`,
    `created: ${frontmatter.created}`,
    serializeTagsLine(frontmatter.tags),
    "---",
  ].join("\n");
}

export function assembleMarkdownDocument(parsedPayload: ParsedPayload): string {
  const frontmatterBlock = serializeFrontmatter(parsedPayload.frontmatter);
  return `${frontmatterBlock}\n\n# ${parsedPayload.title}\n\n${parsedPayload.body}`;
}
