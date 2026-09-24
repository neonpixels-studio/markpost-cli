import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('chalk', () => ({
  default: {
    redBright: vi.fn((value: unknown) => value),
    yellow: vi.fn((value: unknown) => value),
  },
}));

import {
  logErrorMessage,
  messageFromError,
  warnPartialRead,
} from '@/libs/errors.js';

describe('logErrorMessage', () => {
  it('calls console.log', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logErrorMessage('title', 'message');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('messageFromError', () => {
  it('returns the message of an Error instance', () => {
    expect(messageFromError(new Error('boom'))).toBe('boom');
  });

  it('stringifies a non-Error thrown value', () => {
    expect(messageFromError('boom')).toBe('boom');
    expect(messageFromError(undefined)).toBe('undefined');
    expect(messageFromError(42)).toBe('42');
  });
});

// warnPartialRead is the single reporter records.ts and events.ts both call
// on a partial (truncated) read — see issue #194: a plain-text warning under
// --json broke a script parsing stderr for the unified failure contract.
describe('warnPartialRead', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = undefined;
    // clearAllMocks (beforeEach) drops call history but keeps the mocked
    // implementation in place, unlike the manual spy.mockRestore() the
    // logErrorMessage suite above uses — restore it here so a mocked, silent
    // console.error can't leak into a test added later in this file.
    vi.restoreAllMocks();
  });

  it('writes plain-text chalk prose and sets a non-zero exit when json is false', () => {
    warnPartialRead(false);

    expect(console.error).toHaveBeenCalledTimes(1);
    const output = vi.mocked(console.error).mock.calls[0][0] as string;
    expect(output).toContain('Warning:');
    expect(output).toContain('this list may be incomplete');
    expect(process.exitCode).toBe(1);
  });

  it('writes a single valid JSON error object and sets a non-zero exit when json is true', () => {
    warnPartialRead(true);

    expect(console.error).toHaveBeenCalledTimes(1);
    const output = vi.mocked(console.error).mock.calls[0][0] as string;
    expect(JSON.parse(output)).toEqual({
      error: 'partial_read',
      message: expect.stringContaining('this list may be incomplete'),
    });
    expect(process.exitCode).toBe(1);
  });

  // export.ts (issue #205) overrides both the message and the details to
  // describe its own reason(s) for an incomplete result (a server-side row
  // cap and/or skipped malformed rows) instead of the default paginated-read
  // wording, while still going through this one shared reporter.
  it('uses the given message and details instead of the default when both are provided', () => {
    warnPartialRead(true, 'The export was truncated.', {
      truncated: true,
      skippedCount: 0,
    });

    const output = vi.mocked(console.error).mock.calls[0][0] as string;
    expect(JSON.parse(output)).toEqual({
      error: 'partial_read',
      message: 'The export was truncated.',
      truncated: true,
      skippedCount: 0,
    });
    expect(process.exitCode).toBe(1);
  });

  it('uses the given message in plain-text mode too', () => {
    warnPartialRead(false, 'The export was truncated.');

    const output = vi.mocked(console.error).mock.calls[0][0] as string;
    expect(output).toBe('Warning: The export was truncated.');
    expect(process.exitCode).toBe(1);
  });
});
