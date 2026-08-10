import { describe, expect, it } from 'vitest';

import {
  sanitizeBlockForTerminal,
  sanitizeForTerminal,
} from '@/libs/terminal.js';

// Control characters are built via fromCharCode so no raw control byte lives in
// the source file (mirrors the convention in index.test.ts).
const ESC = String.fromCharCode(0x1b);
const BELL = String.fromCharCode(0x07);
const NULL = String.fromCharCode(0x00);
const DELETE = String.fromCharCode(0x7f);
const C1_CSI = String.fromCharCode(0x9b);
const TAB = String.fromCharCode(0x09);
const LINE_FEED = String.fromCharCode(0x0a);
const CARRIAGE_RETURN = String.fromCharCode(0x0d);

describe('sanitizeForTerminal', () => {
  it('leaves ordinary printable text untouched', () => {
    expect(sanitizeForTerminal('Meeting notes 2024')).toBe('Meeting notes 2024');
  });

  it('replaces an ANSI escape (ESC) with a space', () => {
    const clearScreen = `${ESC}[2J`;
    expect(sanitizeForTerminal(`A${clearScreen}B`)).toBe('A [2JB');
  });

  it.each([
    ['NULL (0x00)', NULL],
    ['BELL (0x07)', BELL],
    ['ESC (0x1b)', ESC],
    ['DEL (0x7f)', DELETE],
    ['C1 CSI (0x9b)', C1_CSI],
  ])('strips the %s control character', (_label, control) => {
    const result = sanitizeForTerminal(`X${control}Y`);
    expect(result).toBe('X Y');
    expect(result.includes(control)).toBe(false);
  });

  it('preserves multi-byte characters above the C1 range', () => {
    expect(sanitizeForTerminal('café — 日本語')).toBe('café — 日本語');
  });

  it('strips newlines and tabs too (single-line fields stay single-line)', () => {
    expect(sanitizeForTerminal(`a${LINE_FEED}b${TAB}c`)).toBe('a b c');
  });

  it('returns an empty string for an empty input', () => {
    expect(sanitizeForTerminal('')).toBe('');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('coerces %s to an empty string instead of throwing', (_label, value) => {
    expect(sanitizeForTerminal(value)).toBe('');
  });

  it('coerces a non-string (e.g. a number) before sanitizing', () => {
    expect(sanitizeForTerminal(42)).toBe('42');
  });
});

describe('sanitizeBlockForTerminal', () => {
  it('preserves newlines and tabs so multi-line content keeps its structure', () => {
    expect(sanitizeBlockForTerminal(`line one${LINE_FEED}${TAB}line two`)).toBe(
      `line one${LINE_FEED}${TAB}line two`,
    );
  });

  it('still strips a carriage return (line-overwrite spoofing vector)', () => {
    const result = sanitizeBlockForTerminal(`real${CARRIAGE_RETURN}fake`);
    expect(result).toBe('realfake');
    expect(result.includes(CARRIAGE_RETURN)).toBe(false);
  });

  it('drops CR from a CRLF body without leaving a trailing space', () => {
    const crlfBody = `line one${CARRIAGE_RETURN}${LINE_FEED}line two`;
    expect(sanitizeBlockForTerminal(crlfBody)).toBe(
      `line one${LINE_FEED}line two`,
    );
  });

  it.each([
    ['NULL (0x00)', NULL],
    ['BELL (0x07)', BELL],
    ['ESC (0x1b)', ESC],
    ['DEL (0x7f)', DELETE],
    ['C1 CSI (0x9b)', C1_CSI],
  ])('still strips the %s control character', (_label, control) => {
    const result = sanitizeBlockForTerminal(`X${control}Y`);
    expect(result).toBe('X Y');
    expect(result.includes(control)).toBe(false);
  });
});
