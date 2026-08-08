import {
  authedRequest,
  unwrapResourceAttributes,
  unwrapResourceCollection,
} from '@/libs/api.js';
import { logErrorMessage } from '@/libs/errors.js';
import { ApiDeleteMeta, ApiDeleteResponse } from '@/types/api.types.js';
import {
  CreateSourceInput,
  Source,
  SourceApiResponse,
  SourceListApiResponse,
  UpdateSourceInput,
} from '@/types/sources.types.js';

export const fetchSources = async (): Promise<Source[]> => {
  try {
    const body = (await authedRequest('/api/sources')) as SourceListApiResponse;

    return unwrapResourceCollection('fetchSources', body, 'source');
  } catch (error) {
    logErrorMessage(
      'fetchSources',
      error instanceof Error ? error.message : String(error),
    );

    return [];
  }
};

export const createSource = async (
  input: CreateSourceInput,
): Promise<Source | null> => {
  try {
    const body = (await authedRequest('/api/sources', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/vnd.api+json',
      },
      body: JSON.stringify({
        data: {
          type: 'sources',
          attributes: input,
        },
      }),
    })) as SourceApiResponse;

    return unwrapResourceAttributes(body);
  } catch (error) {
    logErrorMessage(
      `createSource["${input.name}"]`,
      error instanceof Error ? error.message : String(error),
    );

    return null;
  }
};

export const updateSource = async (
  uuid: string,
  input: UpdateSourceInput,
): Promise<Source | null> => {
  try {
    const body = (await authedRequest(
      `/api/sources/${encodeURIComponent(uuid)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/vnd.api+json',
        },
        body: JSON.stringify({
          data: {
            type: 'sources',
            attributes: input,
          },
        }),
      },
    )) as SourceApiResponse;

    return unwrapResourceAttributes(body);
  } catch (error) {
    logErrorMessage(
      `updateSource["${uuid}"]`,
      error instanceof Error ? error.message : String(error),
    );

    return null;
  }
};

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
    logErrorMessage(
      `deleteSource["${uuid}"]`,
      error instanceof Error ? error.message : String(error),
    );

    return null;
  }
};
