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
      error: 'fetch_failed',
      message: expect.stringContaining('this list may be incomplete'),
    });
    expect(process.exitCode).toBe(1);
  });
});
