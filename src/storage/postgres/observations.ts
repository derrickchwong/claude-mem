// SPDX-License-Identifier: Apache-2.0

import type { JsonObject, JsonValue, PostgresQueryable } from './utils.js';
import {
  assertProjectOwnership,
  assertSessionOwnership,
  canonicalJson,
  deterministicKey,
  newId,
  queryOne,
  toEpoch,
  toJsonObject
} from './utils.js';
import { normalizePlatformSourceOrNull } from '../../shared/platform-source.js';

export type ObservationSourceType = 'agent_event' | 'session_summary' | 'observation_reindex' | 'manual';

export interface PostgresObservation {
  id: string;
  projectId: string;
  teamId: string;
  serverSessionId: string | null;
  kind: string;
  content: string;
  generationKey: string | null;
  metadata: JsonObject;
  embedding: JsonValue | null;
  createdByJobId: string | null;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface PostgresObservationSource {
  id: string;
  observationId: string;
  agentEventId: string | null;
  generationJobId: string | null;
  sourceType: ObservationSourceType;
  sourceId: string;
  metadata: JsonObject;
  createdAtEpoch: number;
}

interface ObservationRow {
  id: string;
  project_id: string;
  team_id: string;
  server_session_id: string | null;
  kind: string;
  content: string;
  generation_key: string | null;
  metadata: unknown;
  embedding: unknown | null;
  created_by_job_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface ObservationSourceRow {
  id: string;
  observation_id: string;
  agent_event_id: string | null;
  generation_job_id: string | null;
  source_type: ObservationSourceType;
  source_id: string;
  metadata: unknown;
  created_at: Date;
}

export class PostgresObservationRepository {
  constructor(private client: PostgresQueryable) {}

  async create(input: {
    id?: string;
    projectId: string;
    teamId: string;
    serverSessionId?: string | null;
    kind?: string;
    content: string;
    generationKey?: string | null;
    metadata?: JsonObject;
    embedding?: JsonValue | null;
    createdByJobId?: string | null;
  }): Promise<PostgresObservation> {
    await assertProjectOwnership(this.client, input.projectId, input.teamId);
    if (input.serverSessionId) {
      await assertSessionOwnership(this.client, input.serverSessionId, input.projectId, input.teamId);
    }
    if (input.createdByJobId) {
      await assertJobOwnership(this.client, input.createdByJobId, input.projectId, input.teamId);
    }

    const row = await queryOne<ObservationRow>(
      this.client,
      `
        INSERT INTO observations (
          id, project_id, team_id, server_session_id, kind, content,
          generation_key, metadata, embedding, created_by_job_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)
        ON CONFLICT (team_id, project_id, generation_key) WHERE generation_key IS NOT NULL DO UPDATE SET
          updated_at = observations.updated_at
        RETURNING *
      `,
      [
        input.id ?? newId(),
        input.projectId,
        input.teamId,
        input.serverSessionId ?? null,
        input.kind ?? 'observation',
        input.content,
        input.generationKey ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.embedding == null ? null : JSON.stringify(input.embedding),
        input.createdByJobId ?? null
      ]
    );
    return mapObservationRow(row!);
  }

  async getByIdForScope(input: {
    id: string;
    projectId: string;
    teamId: string;
  }): Promise<PostgresObservation | null> {
    const row = await queryOne<ObservationRow>(
      this.client,
      'SELECT * FROM observations WHERE id = $1 AND project_id = $2 AND team_id = $3',
      [input.id, input.projectId, input.teamId]
    );
    return row ? mapObservationRow(row) : null;
  }

  // MCP `get_observations` (Step 3 of the search/timeline/get_observations
  // workflow) needs a scoped batch fetch by id — the single-row
  // `getByIdForScope` above would mean one round trip per id. Missing ids
  // are silently omitted from the result (matching `getByIdForScope`'s
  // null-on-miss semantics) rather than causing the whole call to fail.
  //
  // Results are returned in the SAME ORDER as `input.ids`, not database
  // order: `WHERE id = ANY(...)` makes no ordering guarantee, but the
  // caller's id list usually reflects a prior `search`/`timeline` ranking
  // (Step 1/2 of the same workflow) that callers reasonably expect Step 3
  // to preserve.
  async getByIdsForScope(input: {
    ids: string[];
    projectId: string;
    teamId: string;
  }): Promise<PostgresObservation[]> {
    if (input.ids.length === 0) return [];
    const result = await this.client.query<ObservationRow>(
      'SELECT * FROM observations WHERE id = ANY($1::text[]) AND project_id = $2 AND team_id = $3',
      [input.ids, input.projectId, input.teamId]
    );
    const byId = new Map(result.rows.map(row => [row.id, row]));
    return input.ids
      .map(id => byId.get(id))
      .filter((row): row is ObservationRow => row !== undefined)
      .map(mapObservationRow);
  }

  async listByProject(input: {
    projectId: string;
    teamId: string;
    serverSessionId?: string | null;
    limit?: number;
  }): Promise<PostgresObservation[]> {
    const result = await this.client.query<ObservationRow>(
      `
        SELECT * FROM observations
        WHERE project_id = $1
          AND team_id = $2
          AND ($3::text IS NULL OR server_session_id = $3)
        ORDER BY created_at DESC
        LIMIT $4
      `,
      [input.projectId, input.teamId, input.serverSessionId ?? null, input.limit ?? 100]
    );
    return result.rows.map(mapObservationRow);
  }

  // `query` is optional: when omitted (or empty), the FTS filter/ranking is
  // skipped entirely and results fall back to recency order. This backs both
  // `/v1/search` (query always required by that route's own validation) and
  // `/v1/context` (query optional — SessionStart injection has no search
  // term, just "what's recent"). See plans/2026-07-13-session-start-context-
  // injection-server-mode.md.
  async search(input: {
    projectId: string;
    teamId: string;
    query?: string | null;
    limit?: number;
    platformSource?: string | null;
  }): Promise<PostgresObservation[]> {
    const platformSource = normalizePlatformSourceOrNull(input.platformSource);
    const query = input.query && input.query.trim().length > 0 ? input.query : null;
    const result = await this.client.query<ObservationRow>(
      `
        SELECT observations.* FROM observations
        LEFT JOIN server_sessions
          ON server_sessions.id = observations.server_session_id
          AND server_sessions.project_id = observations.project_id
          AND server_sessions.team_id = observations.team_id
        WHERE observations.project_id = $1
          AND observations.team_id = $2
          AND ($3::text IS NULL OR observations.content_search @@ websearch_to_tsquery('english', $3))
          AND (
            $5::text IS NULL
            OR server_sessions.platform_source = $5
            OR (
              observations.server_session_id IS NULL
              AND EXISTS (
                SELECT 1
                FROM observation_sources
                INNER JOIN agent_events
                  ON agent_events.id = observation_sources.agent_event_id
                  AND agent_events.project_id = observations.project_id
                  AND agent_events.team_id = observations.team_id
                WHERE observation_sources.observation_id = observations.id
                  AND observation_sources.source_type = 'agent_event'
                  AND agent_events.platform_source = $5
              )
            )
          )
        ORDER BY
          CASE WHEN $3::text IS NOT NULL THEN ts_rank(observations.content_search, websearch_to_tsquery('english', $3)) END DESC NULLS LAST,
          observations.created_at DESC
        LIMIT $4
      `,
      [input.projectId, input.teamId, query, input.limit ?? 20, platformSource]
    );
    return result.rows.map(mapObservationRow);
  }

  // MCP `timeline` (Step 2): chronological context around an anchor
  // observation. The anchor is resolved by id only — callers that only have
  // a search query resolve an anchor id via `search()` first (see
  // mcp-server.ts) so this repository stays free of FTS-vs-anchor-resolution
  // policy. Depth defaults to 10, matching worker-mode's actual
  // `SearchManager.timeline()` default (src/services/worker/SearchManager.ts)
  // — NOT the "default 3" the classic `timeline` tool's own schema
  // description advertises, which is stale relative to that real behavior.
  async timelineForScope(input: {
    anchorId: string;
    projectId: string;
    teamId: string;
    depthBefore?: number;
    depthAfter?: number;
    platformSource?: string | null;
    // Callers that already fetched the anchor row (e.g. the `/v1/timeline`
    // route resolving it from a `query` via `search()`) can pass it through
    // here to skip a second, otherwise-identical by-id lookup. Callers that
    // only have the id (the common case) omit this and it's fetched below.
    anchor?: PostgresObservation;
  }): Promise<{ anchor: PostgresObservation; before: PostgresObservation[]; after: PostgresObservation[] } | null> {
    const anchor = input.anchor ?? await this.getByIdForScope({
      id: input.anchorId,
      projectId: input.projectId,
      teamId: input.teamId
    });
    if (!anchor) return null;

    const platformSource = normalizePlatformSourceOrNull(input.platformSource);
    // Same platformSource semantics as `search()` above: match the
    // observation's own session, or (when it has no session) an agent_event
    // source linked to that platform.
    const platformSourceFilter = `
          AND (
            $4::text IS NULL
            OR server_sessions.platform_source = $4
            OR (
              observations.server_session_id IS NULL
              AND EXISTS (
                SELECT 1
                FROM observation_sources
                INNER JOIN agent_events
                  ON agent_events.id = observation_sources.agent_event_id
                  AND agent_events.project_id = observations.project_id
                  AND agent_events.team_id = observations.team_id
                WHERE observation_sources.observation_id = observations.id
                  AND observation_sources.source_type = 'agent_event'
                  AND agent_events.platform_source = $4
              )
            )
          )
    `;
    // `(created_at, id) < / > (anchor's created_at, anchor's id)` is a
    // strict total order (ids are unique), unlike a bare `created_at`
    // comparison: observations sharing the anchor's exact timestamp — a real
    // occurrence, since `processGeneratedResponse` persists every
    // observation from one generation job inside a single transaction, and
    // Postgres freezes `now()` for the whole transaction — are still
    // deterministically placed on one side instead of silently excluded
    // from both. The anchor's own `created_at` is looked up inline (scoped
    // by project/team, unlike the equivalent lookup this replaced) rather
    // than reconstructed from the already-fetched `anchor.createdAtEpoch`:
    // that field is millisecond-truncated (`Date.getTime()`), and Postgres
    // `timestamptz` has microsecond precision — round-tripping through the
    // truncated epoch could make the anchor's own row compare as later than
    // its real stored value and spuriously satisfy `created_at > anchor`,
    // pulling the anchor itself into the "after" set.
    const beforeResult = await this.client.query<ObservationRow>(
      `
        SELECT observations.* FROM observations
        LEFT JOIN server_sessions
          ON server_sessions.id = observations.server_session_id
          AND server_sessions.project_id = observations.project_id
          AND server_sessions.team_id = observations.team_id
        WHERE observations.project_id = $1 AND observations.team_id = $2
          AND (observations.created_at, observations.id) < (
            (SELECT created_at FROM observations WHERE id = $3 AND project_id = $1 AND team_id = $2),
            $3::text
          )
${platformSourceFilter}
        ORDER BY observations.created_at DESC, observations.id DESC
        LIMIT $5
      `,
      [input.projectId, input.teamId, input.anchorId, platformSource, input.depthBefore ?? 10]
    );
    const afterResult = await this.client.query<ObservationRow>(
      `
        SELECT observations.* FROM observations
        LEFT JOIN server_sessions
          ON server_sessions.id = observations.server_session_id
          AND server_sessions.project_id = observations.project_id
          AND server_sessions.team_id = observations.team_id
        WHERE observations.project_id = $1 AND observations.team_id = $2
          AND (observations.created_at, observations.id) > (
            (SELECT created_at FROM observations WHERE id = $3 AND project_id = $1 AND team_id = $2),
            $3::text
          )
${platformSourceFilter}
        ORDER BY observations.created_at ASC, observations.id ASC
        LIMIT $5
      `,
      [input.projectId, input.teamId, input.anchorId, platformSource, input.depthAfter ?? 10]
    );

    return {
      anchor,
      // Chronological order (oldest first), matching worker-mode's timeline shape.
      before: beforeResult.rows.map(mapObservationRow).reverse(),
      after: afterResult.rows.map(mapObservationRow)
    };
  }
}

export class PostgresObservationSourcesRepository {
  constructor(private client: PostgresQueryable) {}

  async addSource(input: {
    id?: string;
    observationId: string;
    projectId: string;
    teamId: string;
    sourceType: ObservationSourceType;
    sourceId: string;
    agentEventId?: string | null;
    generationJobId?: string | null;
    metadata?: JsonObject;
  }): Promise<PostgresObservationSource> {
    const observation = await queryOne<{ id: string }>(
      this.client,
      'SELECT id FROM observations WHERE id = $1 AND project_id = $2 AND team_id = $3',
      [input.observationId, input.projectId, input.teamId]
    );
    if (!observation) {
      throw new Error('observation_id does not exist');
    }

    const agentEventId = input.sourceType === 'agent_event'
      ? input.agentEventId ?? input.sourceId
      : null;

    if (input.sourceType === 'agent_event') {
      if (agentEventId !== input.sourceId) {
        throw new Error('agent_event source_id must equal agent_event_id');
      }
      await assertAgentEventOwnership(this.client, input.sourceId, input.projectId, input.teamId);
    } else if (input.sourceType === 'session_summary' && !input.generationJobId) {
      await assertSessionOwnership(this.client, input.sourceId, input.projectId, input.teamId);
    } else if (input.sourceType === 'observation_reindex' && !input.generationJobId) {
      await assertObservationOwnership(this.client, input.sourceId, input.projectId, input.teamId);
    }
    if (input.generationJobId) {
      await assertGenerationJobMatchesSource(this.client, {
        generationJobId: input.generationJobId,
        projectId: input.projectId,
        teamId: input.teamId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        agentEventId
      });
    }

    const row = await queryOne<ObservationSourceRow>(
      this.client,
      `
        INSERT INTO observation_sources (
          id, observation_id, agent_event_id, generation_job_id,
          source_type, source_id, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        ON CONFLICT (observation_id, source_type, source_id) DO UPDATE SET
          metadata = observation_sources.metadata || excluded.metadata
        RETURNING *
      `,
      [
        input.id ?? newId(),
        input.observationId,
        agentEventId,
        input.generationJobId ?? null,
        input.sourceType,
        input.sourceId,
        JSON.stringify(input.metadata ?? {})
      ]
    );
    return mapObservationSourceRow(row!);
  }

  async listByObservationForScope(input: {
    observationId: string;
    projectId: string;
    teamId: string;
  }): Promise<PostgresObservationSource[]> {
    const result = await this.client.query<ObservationSourceRow>(
      `
        SELECT observation_sources.*
        FROM observation_sources
        INNER JOIN observations
          ON observations.id = observation_sources.observation_id
        WHERE observation_sources.observation_id = $1
          AND observations.project_id = $2
          AND observations.team_id = $3
        ORDER BY observation_sources.created_at ASC
      `,
      [input.observationId, input.projectId, input.teamId]
    );
    return result.rows.map(mapObservationSourceRow);
  }
}

export function buildObservationGenerationKey(input: {
  generationJobId: string;
  parsedObservationIndex: number;
  content: string;
}): string {
  return `generation:v1:${input.generationJobId}:${input.parsedObservationIndex}:${deterministicKey([
    canonicalJson(input.content.trim())
  ])}`;
}

async function assertJobOwnership(
  client: PostgresQueryable,
  generationJobId: string,
  projectId: string,
  teamId: string
): Promise<void> {
  const row = await queryOne<{ id: string }>(
    client,
    'SELECT id FROM observation_generation_jobs WHERE id = $1 AND project_id = $2 AND team_id = $3',
    [generationJobId, projectId, teamId]
  );
  if (!row) {
    throw new Error('generation_job_id must belong to project_id and team_id');
  }
}

async function assertGenerationJobMatchesSource(
  client: PostgresQueryable,
  input: {
    generationJobId: string;
    projectId: string;
    teamId: string;
    sourceType: ObservationSourceType;
    sourceId: string;
    agentEventId: string | null;
  }
): Promise<void> {
  if (input.sourceType === 'manual') {
    throw new Error('manual observation sources cannot be linked to a generation_job_id');
  }

  const row = await queryOne<{
    id: string;
    source_type: string;
    source_id: string;
    agent_event_id: string | null;
  }>(
    client,
    `
      SELECT id, source_type, source_id, agent_event_id
      FROM observation_generation_jobs
      WHERE id = $1 AND project_id = $2 AND team_id = $3
    `,
    [input.generationJobId, input.projectId, input.teamId]
  );
  if (!row) {
    throw new Error('generation_job_id must belong to project_id and team_id');
  }
  if (row.source_type !== input.sourceType || row.source_id !== input.sourceId) {
    throw new Error('generation_job_id source model must match observation source');
  }
  if (input.sourceType === 'agent_event' && row.agent_event_id !== input.agentEventId) {
    throw new Error('generation_job_id agent_event_id must match observation source');
  }
}

async function assertAgentEventOwnership(
  client: PostgresQueryable,
  agentEventId: string,
  projectId: string,
  teamId: string
): Promise<void> {
  const row = await queryOne<{ id: string }>(
    client,
    'SELECT id FROM agent_events WHERE id = $1 AND project_id = $2 AND team_id = $3',
    [agentEventId, projectId, teamId]
  );
  if (!row) {
    throw new Error('agent_event_id must belong to project_id and team_id');
  }
}

async function assertObservationOwnership(
  client: PostgresQueryable,
  observationId: string,
  projectId: string,
  teamId: string
): Promise<void> {
  const row = await queryOne<{ id: string }>(
    client,
    'SELECT id FROM observations WHERE id = $1 AND project_id = $2 AND team_id = $3',
    [observationId, projectId, teamId]
  );
  if (!row) {
    throw new Error('observation_reindex source_id must belong to project_id and team_id');
  }
}

function mapObservationRow(row: ObservationRow): PostgresObservation {
  return {
    id: row.id,
    projectId: row.project_id,
    teamId: row.team_id,
    serverSessionId: row.server_session_id,
    kind: row.kind,
    content: row.content,
    generationKey: row.generation_key,
    metadata: toJsonObject(row.metadata),
    embedding: row.embedding,
    createdByJobId: row.created_by_job_id,
    createdAtEpoch: toEpoch(row.created_at),
    updatedAtEpoch: toEpoch(row.updated_at)
  };
}

function mapObservationSourceRow(row: ObservationSourceRow): PostgresObservationSource {
  return {
    id: row.id,
    observationId: row.observation_id,
    agentEventId: row.agent_event_id,
    generationJobId: row.generation_job_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    metadata: toJsonObject(row.metadata),
    createdAtEpoch: toEpoch(row.created_at)
  };
}
