import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('conf', () => ({
  default: vi.fn().mockImplementation(function () {
    return { get: vi.fn(), set: vi.fn(), path: '' };
  }),
}));

import { ApiRequestError } from '#src/libs/api.js';
import * as apiModule from '#src/libs/api.js';
import {
  CHECK_REACHABLE,
  CHECK_TOKEN,
  runDoctorChecks,
  checkApiReachable,
  checkBaseUrl,
  checkConfigPresent,
  checkOutputDirectory,
  checkTokenAccepted,
} from '#src/libs/doctor.js';

const SECRET_TOKEN = 'sk_supersecret1234567890';

describe('checkConfigPresent', () => {
  it('passes when both values are set and never echoes them', () => {
    const result = checkConfigPresent(SECRET_TOKEN, '/notes');

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET_TOKEN);
  });

  it('fails naming each missing key', () => {
    const result = checkConfigPresent(undefined, '');

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('apiToken');
    expect(result.detail).toContain('outputDirectory');
  });
});

describe('checkBaseUrl', () => {
  it('passes for an https URL', () => {
    expect(checkBaseUrl('https://markpost.io').ok).toBe(true);
  });

  it('fails for an unparseable URL', () => {
    expect(checkBaseUrl('not a url').ok).toBe(false);
  });

  it('fails for a non-http protocol', () => {
    expect(checkBaseUrl('ftp://markpost.io').ok).toBe(false);
  });
});

describe('checkApiReachable', () => {
  it('does not print credentials embedded in the URL', async () => {
    const result = await checkApiReachable(
      'https://user:hunter2@markpost.io',
      vi.fn().mockResolvedValue(200),
    );

    expect(result.detail).not.toContain('hunter2');
  });

  it('passes on any HTTP status, including errors', async () => {
    const result = await checkApiReachable(
      'https://markpost.io',
      vi.fn().mockResolvedValue(503),
    );

    expect(result.ok).toBe(true);
    expect(result.detail).toContain('503');
  });

  it('fails when the probe throws', async () => {
    const result = await checkApiReachable(
      'https://markpost.io',
      vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND')),
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('ENOTFOUND');
  });
});

describe('checkTokenAccepted', () => {
  it('fails without calling the API when there is no token', async () => {
    const probe = vi.fn();
    const result = await checkTokenAccepted(undefined, probe);

    expect(result.ok).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it('passes when the probe succeeds', async () => {
    const result = await checkTokenAccepted(
      SECRET_TOKEN,
      vi.fn().mockResolvedValue({}),
    );

    expect(result.ok).toBe(true);
  });

  it('reports a rejected token on 401', async () => {
    const result = await checkTokenAccepted(
      SECRET_TOKEN,
      vi.fn().mockRejectedValue(new ApiRequestError('Unauthorized', 401)),
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('rejected');
  });

  it('reports a missing scope on 403', async () => {
    const result = await checkTokenAccepted(
      SECRET_TOKEN,
      vi.fn().mockRejectedValue(new ApiRequestError('missing scope', 403)),
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('records:read');
  });

  it('reports other failures by message', async () => {
    const result = await checkTokenAccepted(
      SECRET_TOKEN,
      vi.fn().mockRejectedValue(new Error('timed out')),
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('timed out');
  });
});

describe('checkOutputDirectory', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'markpost-doctor-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('passes for an existing writable directory', async () => {
    expect((await checkOutputDirectory(directory)).ok).toBe(true);
  });

  it('fails when not configured', async () => {
    expect((await checkOutputDirectory(undefined)).ok).toBe(false);
  });

  it('fails when the directory does not exist', async () => {
    const result = await checkOutputDirectory(path.join(directory, 'missing'));

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('ENOENT');
  });

  it.skipIf(process.getuid?.() === 0)(
    'fails when the directory is not writable',
    async () => {
      await chmod(directory, 0o500);

      const result = await checkOutputDirectory(directory);

      await chmod(directory, 0o700);
      expect(result.ok).toBe(false);
      expect(result.detail).toContain('EACCES');
    },
  );

  it('strips terminal escapes from a passing path', async () => {
    const escapedDirectory = path.join(directory, 'evil\u001b[31m');
    await mkdir(escapedDirectory);

    const result = await checkOutputDirectory(escapedDirectory);

    expect(result.ok).toBe(true);
    expect(result.detail).not.toContain('\u001b');
  });

  it('fails when the path is a file', async () => {
    const filePath = path.join(directory, 'file.txt');
    await writeFile(filePath, 'x');

    const result = await checkOutputDirectory(filePath);

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('not a directory');
  });
});

describe('runDoctorChecks', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('skips the network checks when BASE_URL is invalid', async () => {
    vi.stubEnv('BASE_URL', 'not a url');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const results = await runDoctorChecks();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(results.find((r) => r.name === CHECK_REACHABLE)?.ok).toBe(false);
    expect(results.find((r) => r.name === CHECK_TOKEN)?.detail).toContain(
      'skipped',
    );
  });

  it('skips the token check when the API is unreachable', async () => {
    vi.stubEnv('BASE_URL', 'https://markpost.test');
    vi.stubEnv('API_TOKEN', SECRET_TOKEN);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ENOTFOUND')));
    const authedSpy = vi.spyOn(apiModule, 'authedRequest');

    const results = await runDoctorChecks();

    expect(authedSpy).not.toHaveBeenCalled();
    expect(results.find((r) => r.name === CHECK_TOKEN)?.detail).toContain(
      'unreachable',
    );
  });
});
