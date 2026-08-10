import { describe, expect, it } from 'vitest';

import { sanitizeForTerminal } from '@/libs/terminal.js';

// Control characters are built via fromCharCode so no raw control byte lives in
// the source file (mirrors the convention in index.test.ts).
const ESC = String.fromCharCode(0x1b);
const BELL = String.fromCharCode(0x07);
const NULL = String.fromCharCode(0x00);
const DELETE = String.fromCharCode(0x7f);
const C1_CSI = String.fromCharCode(0x9b);

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

  it('returns an empty string for an empty input', () => {
    expect(sanitizeForTerminal('')).toBe('');
  });
});
