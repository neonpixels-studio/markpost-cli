import {
  authedRequest,
  logApiFailure,
  unwrapResourceAttributes,
  unwrapResourceCollection,
} from '@/libs/api.js';
import {
  ApiDeleteMeta,
  ApiDeleteResponse,
  ApiResponse,
} from '@/types/api.types.js';
import {
  CreatedSource,
  CreatedSourceResource,
  CreateSourceInput,
  RotateSourceSecretInput,
  Source,
  SourceListApiResponse,
  SourceResource,
  UpdateSourceInput,
} from '@/types/sources.types.js';

const JSON_API_CONTENT_TYPE = 'application/vnd.api+json';

// The shared write seam for source POST/PATCH endpoints: they all send the same
// JSON:API `{ data: { type: 'sources', attributes } }` envelope and unwrap the
// resource attributes off the response, falling back to null (and logging) on
// failure. `context` labels the caller in the log line; `TResource` is the
// JSON:API resource the endpoint returns (`SourceResource`, or
// `CreatedSourceResource` for the two endpoints that reveal a one-time secret) —
// keeping those envelope types live so they still guard against markpost's
// `sourceSerializer` drifting (see src/types/sources.types.ts).
const writeSourceRequest = async <
  TInput extends object,
  TResource extends { attributes: unknown },
>(
  context: string,
  path: string,
  method: 'POST' | 'PATCH',
  attributes: TInput,
): Promise<TResource['attributes'] | null> => {
  try {
    const body = (await authedRequest(path, {
      method,
      headers: {
        'Content-Type': JSON_API_CONTENT_TYPE,
      },
      body: JSON.stringify({
        data: {
          type: 'sources',
          attributes,
        },
      }),
    })) as ApiResponse<TResource | null>;

    return unwrapResourceAttributes(body);
  } catch (error) {
    logApiFailure(context, error);

    return null;
  }
};

export const fetchSources = async (): Promise<Source[]> => {
  try {
    const body = (await authedRequest('/api/sources')) as SourceListApiResponse;

    return unwrapResourceCollection('fetchSources', body, 'source');
  } catch (error) {
    logApiFailure('fetchSources', error);

    return [];
  }
};

export const createSource = async (
  input: CreateSourceInput,
): Promise<CreatedSource | null> =>
  writeSourceRequest<CreateSourceInput, CreatedSourceResource>(
    `createSource["${input.name}"]`,
    '/api/sources',
    'POST',
    input,
  );

export const updateSource = async (
  uuid: string,
  input: UpdateSourceInput,
): Promise<Source | null> =>
  writeSourceRequest<UpdateSourceInput, SourceResource>(
    `updateSource["${uuid}"]`,
    `/api/sources/${encodeURIComponent(uuid)}`,
    'PATCH',
    input,
  );

// Rotation reveals the freshly-generated signing secret exactly once, so its
// response carries `providerSecret` like `createSource` does — hence the
// `CreatedSource` shape rather than the base `Source`. `input` is empty for a
// generated provider and carries the pasted value for a manual-secret provider
// (stripe).
export const rotateSourceSecret = async (
  uuid: string,
  input: RotateSourceSecretInput = {},
): Promise<CreatedSource | null> =>
  writeSourceRequest<RotateSourceSecretInput, CreatedSourceResource>(
    `rotateSourceSecret["${uuid}"]`,
    `/api/sources/${encodeURIComponent(uuid)}/rotate-secret`,
    'POST',
    input,
  );

export const deleteSource = async (
  uuid: string,
): Promise<ApiDeleteMeta | null> => {
  try {
    const body = (await authedRequest(
      `/api/sources/${encodeURIComponent(uuid)}`,
      {
        method: 'DELETE',
      },
    )) as ApiDeleteResponse;

    return body.meta ?? null;
  } catch (error) {
    logApiFailure(`deleteSource["${uuid}"]`, error);

    return null;
  }
};
