import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRunDoctorChecks } = vi.hoisted(() => ({
  mockRunDoctorChecks: vi.fn(),
}));

vi.mock('#src/libs/doctor.js', () => ({
  runDoctorChecks: mockRunDoctorChecks,
}));
vi.mock('chalk', () => ({
  default: {
    redBright: vi.fn((value: unknown) => value),
    greenBright: vi.fn((value: unknown) => value),
  },
}));

import { runDoctorCommand } from '#src/commands/doctor.js';

describe('runDoctorCommand', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.exitCode = undefined;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    mockRunDoctorChecks.mockReset();
  });

  it('prints a line per check and exits zero when all pass', async () => {
    mockRunDoctorChecks.mockResolvedValue([
      { name: 'config', ok: true, detail: 'fine' },
      { name: 'token', ok: true, detail: 'fine' },
    ]);

    await runDoctorCommand([]);

    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy).toHaveBeenCalledWith('PASS config: fine');
    expect(process.exitCode).toBeUndefined();
  });

  it('exits non-zero when any check fails', async () => {
    mockRunDoctorChecks.mockResolvedValue([
      { name: 'config', ok: true, detail: 'fine' },
      { name: 'token', ok: false, detail: 'rejected' },
    ]);

    await runDoctorCommand([]);

    expect(logSpy).toHaveBeenCalledWith('FAIL token: rejected');
    expect(process.exitCode).toBe(1);
  });

  it('rejects stray arguments without running checks', async () => {
    await runDoctorCommand(['extra']);

    expect(mockRunDoctorChecks).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
