import { describe, expect, it, vi } from 'vitest';

import { logErrorMessage, messageFromError } from '@/libs/errors.js';

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
