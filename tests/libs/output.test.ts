import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  hasJsonFlag,
  JSON_ERROR_CONFIG_REQUIRED,
  JSON_ERROR_FETCH_FAILED,
  JSON_ERROR_USAGE,
  printJsonError,
} from '@/libs/output.js';

describe('printJsonError', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('emits a single parseable { error, message } object on stderr', () => {
    printJsonError(JSON_ERROR_FETCH_FAILED, 'Something went wrong.');

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(parsed).toEqual({
      error: 'fetch_failed',
      message: 'Something went wrong.',
    });
  });

  it('merges extra details fields into the payload', () => {
    printJsonError(JSON_ERROR_CONFIG_REQUIRED, 'Missing token.', {
      missing: 'apiToken',
    });

    const parsed = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(parsed).toMatchObject({
      error: 'config_required',
      message: 'Missing token.',
      missing: 'apiToken',
    });
  });

  it('re-escapes residual control characters in a server-derived message', () => {
    // CSI (0x9b) is a C1 control JSON.stringify leaves raw; it must survive as
    // its printable \u escape so a hostile API message can't inject a live
    // terminal sequence onto stderr.
    const csi = String.fromCharCode(0x9b);

    printJsonError(JSON_ERROR_FETCH_FAILED, `A${csi}B`);

    const raw = errorSpy.mock.calls[0][0] as string;
    // The emitted bytes carry no live control char (only its printable \u form)
    // yet the escape is lossless, so parsing restores the original message.
    expect(raw).not.toContain(csi);
    expect(raw).toContain('\\u009b');
    expect(JSON.parse(raw).message).toBe(`A${csi}B`);
  });

  it('keeps the three contract codes stable', () => {
    expect(JSON_ERROR_CONFIG_REQUIRED).toBe('config_required');
    expect(JSON_ERROR_USAGE).toBe('usage');
    expect(JSON_ERROR_FETCH_FAILED).toBe('fetch_failed');
  });
});

describe('hasJsonFlag', () => {
  it('detects --json anywhere in argv', () => {
    expect(hasJsonFlag(['list', '--json'])).toBe(true);
    expect(hasJsonFlag(['--json', 'abc-123'])).toBe(true);
  });

  it('is false when --json is absent or only a near-miss is present', () => {
    expect(hasJsonFlag(['list'])).toBe(false);
    expect(hasJsonFlag(['list', '--jsonn'])).toBe(false);
    expect(hasJsonFlag([])).toBe(false);
  });
});
