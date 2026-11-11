import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import {
  deriveStdinTitle,
  parseStdinNote,
  readStdinText,
} from '#src/libs/stdin.js';
import type { ReadableInput } from '#src/libs/stdin.js';

const FIXED_NOW = new Date('2024-05-06T07:08:09.000Z');

describe('readStdinText', () => {
  it('reads a stream to the end', async () => {
    const input = Readable.from(['ab', 'cd']) as unknown as ReadableInput;

    expect(await readStdinText(input)).toBe('abcd');
  });
});

describe('deriveStdinTitle', () => {
  it('uses the first level-1 heading', () => {
    expect(deriveStdinTitle('intro\n# First\n# Second')).toBe('First');
  });

  it('keeps a trailing # that belongs to the title', () => {
    expect(deriveStdinTitle('# Learning F#')).toBe('Learning F#');
  });

  it('drops a closing ATX sequence', () => {
    expect(deriveStdinTitle('# Title ##')).toBe('Title');
  });

  it('skips headings inside code fences, including nested other-kind fences', () => {
    const text = '~~~\n```\n```\n# not me\n~~~\n# Real';

    expect(deriveStdinTitle(text)).toBe('Real');
  });

  it('does not close a fence on a shorter fence or one with an info string', () => {
    expect(deriveStdinTitle('````\n```js\n# no\n```\n````\n# Real')).toBe(
      'Real',
    );
  });

  it('falls back to a timestamp when there is no heading at all', () => {
    expect(deriveStdinTitle('just text', FIXED_NOW)).toBe(
      'Note 2024-05-06T07:08:09.000Z',
    );
  });

  it('falls back to a timestamp for a blank heading or none', () => {
    expect(deriveStdinTitle('#   \ntext', FIXED_NOW)).toBe(
      'Note 2024-05-06T07:08:09.000Z',
    );
  });

  it('skips a frontmatter block, including unclosed ones', () => {
    expect(deriveStdinTitle('---\n# yaml comment\ntitle: X\n---\n# Real')).toBe(
      'Real',
    );
    expect(deriveStdinTitle('---\n# Heading\nno close')).toBe('Heading');
  });

  it('handles CRLF', () => {
    expect(deriveStdinTitle('a\r\n# Title\r\nb')).toBe('Title');
  });
});

describe('parseStdinNote', () => {
  const block =
    '---\ntitle: T\nsource: web\ncreated: 2024-01-01T00:00:00Z\ntags: [a]\n---\n\n# T\n\nbody\n';

  it('parses markpost frontmatter after a BOM', () => {
    const note = parseStdinNote(`\uFEFF${block}`);

    expect(note).toMatchObject({ title: 'T', content: 'body\n', tags: ['a'] });
  });

  it('keeps a headed note without frontmatter as-is, like a file', () => {
    expect(parseStdinNote('# Title\n\nbody')).toMatchObject({
      title: 'Title',
      content: '# Title\n\nbody',
      tags: [],
    });
  });

  it('rejects empty input', () => {
    expect(() => parseStdinNote(' \n')).toThrow('Stdin was empty');
  });
});
