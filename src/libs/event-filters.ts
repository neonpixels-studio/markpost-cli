import {
  EVENT_KINDS,
  EventFilters,
  EventKind,
} from '#src/types/events.types.js';

// The `events list` / `events export` filter flags. Both are declared
// `multiple: true` so a repeat (`--kind err --kind warn`) can be rejected
// rather than silently last-winning: markpost's GET /api/events reads only
// the first `filter[kind]` / `filter[sourceId]` value, so repeats are not a
// supported feature.
export const EVENT_FILTER_PARSE_OPTIONS = {
  kind: { type: 'string', multiple: true },
  source: { type: 'string', multiple: true },
} as const;

// Same shape markpost validates `filter[sourceId]` against
// (server/utils/uuid.ts). The CLI refers to sources by uuid everywhere
// (`sources update <uuid>`), so `--source` takes that uuid, not a name.
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isEventKind = (value: string): value is EventKind =>
  (EVENT_KINDS as readonly string[]).includes(value);

const singleValue = (
  flag: string,
  occurrences: string[] | undefined,
): string | undefined => {
  if (occurrences === undefined) {
    return undefined;
  }

  if (occurrences.length > 1) {
    throw new Error(`--${flag} was given more than once. Pass it only once.`);
  }

  const trimmed = occurrences[0].trim();

  if (trimmed.length === 0) {
    throw new Error(`--${flag} needs a non-empty value.`);
  }

  return trimmed;
};

const parseKind = (
  occurrences: string[] | undefined,
): EventKind | undefined => {
  const kind = singleValue('kind', occurrences);

  if (kind === undefined) {
    return undefined;
  }

  if (!isEventKind(kind)) {
    throw new Error(
      `--kind must be one of: ${EVENT_KINDS.join(', ')} (got "${kind}").`,
    );
  }

  return kind;
};

const parseSourceId = (
  occurrences: string[] | undefined,
): string | undefined => {
  const sourceId = singleValue('source', occurrences);

  if (sourceId !== undefined && !UUID_PATTERN.test(sourceId)) {
    throw new Error(
      `--source must be a source uuid (see \`markpost sources list\`), got "${sourceId}".`,
    );
  }

  return sourceId;
};

// Turns parseArgs' raw `kind`/`source` values into validated filters. Throws
// on a bad value so the caller's usage handler reports it before any request.
export const resolveEventFilters = (values: {
  kind?: string[];
  source?: string[];
}): EventFilters => ({
  kind: parseKind(values.kind),
  sourceId: parseSourceId(values.source),
});

// Query params markpost's GET /api/events accepts for these filters
// (server/api/events/index.get.ts).
export const buildEventFilterParams = (filters: EventFilters): string[] => {
  const params: string[] = [];

  if (filters.kind) {
    params.push(`filter[kind]=${encodeURIComponent(filters.kind)}`);
  }

  if (filters.sourceId) {
    params.push(`filter[sourceId]=${encodeURIComponent(filters.sourceId)}`);
  }

  return params;
};

// GET /api/events/export takes no filters (server/api/events/export.get.ts
// never reads the query), so `events export` applies them to the returned
// rows instead. The export is still capped at the server's row limit before
// this runs, so a truncated export stays flagged as incomplete.
export const filterEventRows = <
  Row extends { kind: string; sourceId: string | null },
>(
  rows: Row[],
  filters: EventFilters,
): Row[] =>
  rows.filter(
    (row) =>
      (filters.kind === undefined || row.kind === filters.kind) &&
      (filters.sourceId === undefined ||
        row.sourceId?.toLowerCase() === filters.sourceId.toLowerCase()),
  );
