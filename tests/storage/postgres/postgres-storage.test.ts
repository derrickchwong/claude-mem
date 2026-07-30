import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pg from 'pg';
import {
  SERVER_POSTGRES_TABLES,
  bootstrapServerPostgresSchema,
  buildObservationGenerationKey,
  buildOrFallbackFtsQuery,
  createPostgresStorageRepositories,
  type PostgresPoolClient,
  type PostgresStorageRepositories
} from '../../../src/storage/postgres/index.js';
import { quoteIdentifier } from '../../sdk/pg-isolation.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

describe('server beta postgres schema bootstrap', () => {
  it('acquires and releases a client when bootstrapping from a pool', async () => {
    const queries: string[] = [];
    let released = false;
    const pool = {
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
      async connect() {
        return {
          release(): void {
            released = true;
          },
          async query(text: string) {
            queries.push(text);
            return { rows: [], rowCount: 0 };
          }
        };
      },
      async query(): Promise<never> {
        throw new Error('pool query should not be used for schema bootstrap');
      }
    };

    await bootstrapServerPostgresSchema(pool);

    expect(queries[0]).toBe('BEGIN');
    expect(queries.at(-1)).toBe('COMMIT');
    expect(released).toBe(true);
  });

  it('uses an already-connected pool client without reconnecting it', async () => {
    const queries: string[] = [];
    const client = {
      async connect(): Promise<never> {
        throw new Error('client should not reconnect');
      },
      release(): void {},
      async query(text: string) {
        queries.push(text);
        return { rows: [], rowCount: 0 };
      }
    } as unknown as PostgresPoolClient;

    await bootstrapServerPostgresSchema(client);

    expect(queries[0]).toBe('BEGIN');
    expect(queries.at(-1)).toBe('COMMIT');
  });

  it('bootstraps platform-scoped server session identity indexes', async () => {
    const queries: string[] = [];
    const client = {
      async query(text: string) {
        queries.push(text);
        return { rows: [], rowCount: 0 };
      }
    };

    await bootstrapServerPostgresSchema(client);

    const schemaSql = queries.find(query => query.includes('CREATE TABLE IF NOT EXISTS server_sessions'));
    expect(schemaSql).toBeDefined();
    expect(schemaSql).not.toContain('UNIQUE (project_id, external_session_id)');
    expect(schemaSql).toContain('DROP CONSTRAINT IF EXISTS server_sessions_project_id_external_session_id_key');
    expect(schemaSql).toContain('idx_server_sessions_external_session_legacy');
    expect(schemaSql).toContain('idx_server_sessions_external_session_platform');
    expect(schemaSql).toContain('DROP INDEX IF EXISTS idx_server_sessions_content_session');
    expect(schemaSql).toContain('idx_server_sessions_content_session_platform');
  });
});

describe('buildOrFallbackFtsQuery', () => {
  it('ORs the words of a bare multi-word query', () => {
    expect(buildOrFallbackFtsQuery('student application details')).toBe('student OR application OR details');
  });

  it('collapses arbitrary whitespace between words', () => {
    expect(buildOrFallbackFtsQuery('  alpha \t beta\n gamma ')).toBe('alpha OR beta OR gamma');
  });

  it('returns null for single-word queries (nothing to relax)', () => {
    expect(buildOrFallbackFtsQuery('deployment')).toBeNull();
    expect(buildOrFallbackFtsQuery('  deployment  ')).toBeNull();
  });

  it('never rewrites queries that use explicit websearch operators', () => {
    expect(buildOrFallbackFtsQuery('"student application" details')).toBeNull();
    expect(buildOrFallbackFtsQuery('student OR application')).toBeNull();
    expect(buildOrFallbackFtsQuery('student -application')).toBeNull();
    expect(buildOrFallbackFtsQuery("student's application")).toBeNull();
  });
});

describe('server beta postgres observation storage', () => {
  if (!testDatabaseUrl) {
    it.skip('requires explicit CLAUDE_MEM_TEST_POSTGRES_URL for Postgres integration tests', () => {});
    return;
  }

  const pool = new pg.Pool({ connectionString: testDatabaseUrl });
  let client: PostgresPoolClient;
  let schemaName: string;
  let storage: PostgresStorageRepositories;

  beforeEach(async () => {
    client = await pool.connect();
    schemaName = `cm_pg_test_${crypto.randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
    await bootstrapServerPostgresSchema(client);
    storage = createPostgresStorageRepositories(client);
  });

  afterEach(async () => {
    if (client) {
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
      client.release();
    }
  });

  it('creates the Phase 1 schema idempotently', async () => {
    await bootstrapServerPostgresSchema(client);

    const result = await client.query<{ table_name: string }>(
      `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = $1
      `,
      [schemaName]
    );
    const tables = new Set(result.rows.map(row => row.table_name));

    for (const table of SERVER_POSTGRES_TABLES) {
      expect(tables.has(table)).toBe(true);
    }
  });

  it('enforces project/team ownership for project-scoped writes', async () => {
    const teamA = await storage.teams.create({ name: 'Team A' });
    const teamB = await storage.teams.create({ name: 'Team B' });
    const projectA = await storage.projects.create({ teamId: teamA.id, name: 'Project A' });

    await expect(storage.projects.create({ teamId: 'missing-team', name: 'Invalid' })).rejects.toThrow();
    await expect(storage.sessions.create({
      projectId: projectA.id,
      teamId: teamB.id
    })).rejects.toThrow(/project_id must belong to team_id/);
  });

  it('deduplicates agent events with deterministic idempotency keys when source event IDs are omitted', async () => {
    const { project, session } = await createFixtureScope(storage);
    const occurredAt = new Date('2026-05-07T20:00:00.000Z');
    const payload = { message: 'same payload', nested: { b: 2, a: 1 } };

    const first = await storage.agentEvents.create({
      projectId: project.id,
      teamId: project.teamId,
      serverSessionId: session.id,
      sourceAdapter: 'claude-code',
      eventType: 'user_prompt',
      payload,
      occurredAt
    });
    const second = await storage.agentEvents.create({
      projectId: project.id,
      teamId: project.teamId,
      serverSessionId: session.id,
      sourceAdapter: 'claude-code',
      eventType: 'user_prompt',
      payload: { nested: { a: 1, b: 2 }, message: 'same payload' },
      occurredAt
    });
    const withNativeId = await storage.agentEvents.create({
      projectId: project.id,
      teamId: project.teamId,
      sourceAdapter: 'cursor',
      sourceEventId: 'event-1',
      eventType: 'tool_call',
      payload: { one: true },
      occurredAt
    });
    const duplicateNativeId = await storage.agentEvents.create({
      projectId: project.id,
      teamId: project.teamId,
      sourceAdapter: 'cursor',
      sourceEventId: 'event-1',
      eventType: 'tool_call',
      payload: { two: true },
      occurredAt
    });

    expect(second.id).toBe(first.id);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(duplicateNativeId.id).toBe(withNativeId.id);
  });

  it('creates observations, searches content, links sources, and preserves generation retry idempotency', async () => {
    const { project, session, event, eventJob } = await createFixtureScopeWithEventJob(storage);
    const generationKey = buildObservationGenerationKey({
      generationJobId: eventJob.id,
      parsedObservationIndex: 0,
      content: 'Postgres is the canonical observation store'
    });

    const observation = await storage.observations.create({
      projectId: project.id,
      teamId: project.teamId,
      serverSessionId: session.id,
      content: 'Postgres is the canonical observation store',
      generationKey,
      createdByJobId: eventJob.id,
      metadata: { generated: true }
    });
    const retry = await storage.observations.create({
      projectId: project.id,
      teamId: project.teamId,
      serverSessionId: session.id,
      content: 'Postgres is the canonical observation store',
      generationKey,
      createdByJobId: eventJob.id
    });
    const source = await storage.observationSources.addSource({
      observationId: observation.id,
      projectId: project.id,
      teamId: project.teamId,
      sourceType: 'agent_event',
      sourceId: event.id,
      generationJobId: eventJob.id
    });
    const duplicateSource = await storage.observationSources.addSource({
      observationId: observation.id,
      projectId: project.id,
      teamId: project.teamId,
      sourceType: 'agent_event',
      sourceId: event.id,
      generationJobId: eventJob.id
    });
    const search = await storage.observations.search({
      projectId: project.id,
      teamId: project.teamId,
      query: 'canonical observation'
    });

    expect(retry.id).toBe(observation.id);
    expect(source.id).toBe(duplicateSource.id);
    expect(search.map(item => item.id)).toContain(observation.id);
    await expect(storage.observationSources.listByObservationForScope({
      observationId: observation.id,
      projectId: project.id,
      teamId: project.teamId
    })).resolves.toHaveLength(1);
  });

  it('falls back to OR semantics when a strict multi-word websearch query matches nothing', async () => {
    const { project } = await createFixtureScope(storage);
    const createObservation = (content: string) => storage.observations.create({
      projectId: project.id,
      teamId: project.teamId,
      kind: 'manual',
      content
    });
    const partialMatch = await createObservation('Updated the prototype layout from the Figma design tokens');
    const unrelated = await createObservation('Batch conversion notes for the payroll pipeline');

    // No stored row contains every word, so the strict AND pass is empty;
    // the OR fallback surfaces the closest partial match instead.
    const results = await storage.observations.search({
      projectId: project.id,
      teamId: project.teamId,
      query: 'student application details prototype figma update'
    });

    expect(results.map(item => item.id)).toContain(partialMatch.id);
    expect(results.map(item => item.id)).not.toContain(unrelated.id);
    expect(results[0]?.id).toBe(partialMatch.id);
  });

  it('does not relax queries that use explicit websearch operators', async () => {
    const { project } = await createFixtureScope(storage);
    await storage.observations.create({
      projectId: project.id,
      teamId: project.teamId,
      kind: 'manual',
      content: 'Updated the prototype layout from the Figma design tokens'
    });

    // The quoted phrase matches nothing and expresses deliberate operator
    // intent — no OR fallback, the empty result stands.
    const results = await storage.observations.search({
      projectId: project.id,
      teamId: project.teamId,
      query: '"student application" prototype'
    });

    expect(results).toHaveLength(0);
  });

  it('fetches observations by id, scoped to project and team, silently omitting misses and cross-scope ids', async () => {
    const { project } = await createFixtureScope(storage);
    const other = await createFixtureScope(storage);

    const first = await storage.observations.create({
      projectId: project.id,
      teamId: project.teamId,
      content: 'First batch-fetch observation'
    });
    const second = await storage.observations.create({
      projectId: project.id,
      teamId: project.teamId,
      content: 'Second batch-fetch observation'
    });
    const otherProjectObservation = await storage.observations.create({
      projectId: other.project.id,
      teamId: other.project.teamId,
      content: 'Different project, must not leak into the batch result'
    });

    const results = await storage.observations.getByIdsForScope({
      ids: [first.id, second.id, otherProjectObservation.id, 'does-not-exist'],
      projectId: project.id,
      teamId: project.teamId
    });

    expect(results.map(o => o.id).sort()).toEqual([first.id, second.id].sort());
  });

  it('returns matches in the same order as the requested ids, not database order', async () => {
    const { project } = await createFixtureScope(storage);

    const first = await storage.observations.create({
      projectId: project.id, teamId: project.teamId, content: 'A'
    });
    const second = await storage.observations.create({
      projectId: project.id, teamId: project.teamId, content: 'B'
    });
    const third = await storage.observations.create({
      projectId: project.id, teamId: project.teamId, content: 'C'
    });

    // Request in reverse-of-creation order, with a miss interleaved — the
    // response must follow the REQUESTED order, not insertion/DB order.
    const results = await storage.observations.getByIdsForScope({
      ids: [third.id, 'does-not-exist', first.id, second.id],
      projectId: project.id,
      teamId: project.teamId
    });

    expect(results.map(o => o.id)).toEqual([third.id, first.id, second.id]);
  });

  it('returns an empty array from getByIdsForScope when given no ids, without querying', async () => {
    const { project } = await createFixtureScope(storage);
    const results = await storage.observations.getByIdsForScope({
      ids: [],
      projectId: project.id,
      teamId: project.teamId
    });
    expect(results).toEqual([]);
  });

  it('builds chronological before/after context around a timeline anchor, scoped to project and team', async () => {
    const { project } = await createFixtureScope(storage);
    const other = await createFixtureScope(storage);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const observation = await storage.observations.create({
        projectId: project.id,
        teamId: project.teamId,
        content: `Timeline observation ${i}`
      });
      ids.push(observation.id);
      // Postgres timestamp resolution + FK-free inserts can land in the same
      // millisecond; the timeline ordering this test asserts depends on
      // distinct created_at values, same as the app's own observation
      // stream (spaced out by real agent activity in production).
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const otherProjectAnchor = await storage.observations.create({
      projectId: other.project.id,
      teamId: other.project.teamId,
      content: 'Different project anchor'
    });

    const anchorId = ids[2];
    const timeline = await storage.observations.timelineForScope({
      anchorId,
      projectId: project.id,
      teamId: project.teamId,
      depthBefore: 2,
      depthAfter: 2
    });

    expect(timeline).not.toBeNull();
    expect(timeline?.anchor.id).toBe(anchorId);
    expect(timeline?.before.map(o => o.id)).toEqual([ids[0], ids[1]]);
    expect(timeline?.after.map(o => o.id)).toEqual([ids[3], ids[4]]);

    const crossScope = await storage.observations.timelineForScope({
      anchorId: otherProjectAnchor.id,
      projectId: project.id,
      teamId: project.teamId
    });
    expect(crossScope).toBeNull();

    const missing = await storage.observations.timelineForScope({
      anchorId: 'does-not-exist',
      projectId: project.id,
      teamId: project.teamId
    });
    expect(missing).toBeNull();
  });

  it('respects depthBefore/depthAfter limits on the timeline window', async () => {
    const { project } = await createFixtureScope(storage);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const observation = await storage.observations.create({
        projectId: project.id,
        teamId: project.teamId,
        content: `Bounded timeline observation ${i}`
      });
      ids.push(observation.id);
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    const timeline = await storage.observations.timelineForScope({
      anchorId: ids[2],
      projectId: project.id,
      teamId: project.teamId,
      depthBefore: 1,
      depthAfter: 1
    });

    expect(timeline?.before.map(o => o.id)).toEqual([ids[1]]);
    expect(timeline?.after.map(o => o.id)).toEqual([ids[3]]);
  });

  it('does not silently exclude same-timestamp siblings from the timeline window (same-transaction batch insert)', async () => {
    const { project } = await createFixtureScope(storage);

    // A single generation job persists every observation it produces inside
    // one transaction (processGeneratedResponse.ts's withPostgresTransaction)
    // — Postgres freezes now() for the whole transaction, so siblings from
    // the same batch get an identical created_at. Reproduce that exactly
    // (via a real BEGIN/COMMIT on the same client) rather than faking a
    // timestamp, since that's the actual mechanism that triggers the bug.
    await client.query('BEGIN');
    const siblingIds: string[] = [];
    for (const content of ['sibling A', 'sibling B', 'sibling C']) {
      const observation = await storage.observations.create({
        projectId: project.id,
        teamId: project.teamId,
        content
      });
      siblingIds.push(observation.id);
    }
    await client.query('COMMIT');

    // A distinctly-later observation, so there's something unambiguous to
    // find in "after" regardless of how the tied siblings sort against it.
    await new Promise(resolve => setTimeout(resolve, 5));
    const later = await storage.observations.create({
      projectId: project.id,
      teamId: project.teamId,
      content: 'later observation'
    });

    const timeline = await storage.observations.timelineForScope({
      anchorId: siblingIds[0],
      projectId: project.id,
      teamId: project.teamId,
      depthBefore: 5,
      depthAfter: 5
    });

    expect(timeline).not.toBeNull();
    const contextIds = [...timeline!.before.map(o => o.id), ...timeline!.after.map(o => o.id)];
    // Neither same-timestamp sibling is silently dropped from the window —
    // which side of the anchor each lands on is an implementation detail
    // (id-tiebroken, not creation-order), so this only asserts presence.
    expect(contextIds).toContain(siblingIds[1]);
    expect(contextIds).toContain(siblingIds[2]);
    // The anchor never appears in its own before/after context.
    expect(contextIds).not.toContain(siblingIds[0]);
    // The distinctly-later observation is unambiguously placed after.
    expect(timeline!.after.map(o => o.id)).toContain(later.id);
  });

  it('accepts a pre-fetched anchor row instead of re-fetching it by id (used by /v1/timeline when resolving from `query`)', async () => {
    const { project } = await createFixtureScope(storage);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const observation = await storage.observations.create({
        projectId: project.id, teamId: project.teamId, content: `passthrough observation ${i}`
      });
      ids.push(observation.id);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const prefetchedAnchor = await storage.observations.getByIdForScope({
      id: ids[2], projectId: project.id, teamId: project.teamId
    });
    expect(prefetchedAnchor).not.toBeNull();

    const timeline = await storage.observations.timelineForScope({
      anchorId: ids[2],
      anchor: prefetchedAnchor!,
      projectId: project.id,
      teamId: project.teamId,
      depthBefore: 2,
      depthAfter: 2
    });

    expect(timeline).not.toBeNull();
    expect(timeline?.anchor).toEqual(prefetchedAnchor!);
    expect(timeline?.before.map(o => o.id)).toEqual([ids[0], ids[1]]);
    expect(timeline?.after.map(o => o.id)).toEqual([ids[3], ids[4]]);
  });

  it('scopes observation generation_key idempotency to project and team', async () => {
    const firstScope = await createFixtureScope(storage);
    const secondScope = await createFixtureScope(storage);
    const generationKey = 'shared-generation-key';

    const first = await storage.observations.create({
      projectId: firstScope.project.id,
      teamId: firstScope.project.teamId,
      content: 'First scoped generation key observation',
      generationKey
    });
    const retry = await storage.observations.create({
      projectId: firstScope.project.id,
      teamId: firstScope.project.teamId,
      content: 'First scoped generation key observation retry',
      generationKey
    });
    const second = await storage.observations.create({
      projectId: secondScope.project.id,
      teamId: secondScope.project.teamId,
      content: 'Second scoped generation key observation',
      generationKey
    });

    expect(retry.id).toBe(first.id);
    expect(second.id).not.toBe(first.id);
    expect(second.projectId).toBe(secondScope.project.id);
    expect(second.teamId).toBe(secondScope.project.teamId);
  });

  it('scopes observation source reads to the observation project and team', async () => {
    const { project, event, eventJob } = await createFixtureScopeWithEventJob(storage);
    const other = await createFixtureScope(storage);
    const observation = await storage.observations.create({
      projectId: project.id,
      teamId: project.teamId,
      content: 'Scoped observation source reader'
    });

    await storage.observationSources.addSource({
      observationId: observation.id,
      projectId: project.id,
      teamId: project.teamId,
      sourceType: 'agent_event',
      sourceId: event.id,
      generationJobId: eventJob.id
    });

    await expect(storage.observationSources.listByObservationForScope({
      observationId: observation.id,
      projectId: project.id,
      teamId: project.teamId
    })).resolves.toHaveLength(1);
    await expect(storage.observationSources.listByObservationForScope({
      observationId: observation.id,
      projectId: other.project.id,
      teamId: other.project.teamId
    })).resolves.toEqual([]);
  });

  it('does not mutate scoped observation source, job transition, or job event writes with the wrong scope', async () => {
    const { project, event, eventJob } = await createFixtureScopeWithEventJob(storage);
    const other = await createFixtureScope(storage);
    const observation = await storage.observations.create({
      projectId: project.id,
      teamId: project.teamId,
      content: 'Wrong-scope mutation guard'
    });

    await expect(storage.observationSources.addSource({
      observationId: observation.id,
      projectId: other.project.id,
      teamId: other.project.teamId,
      sourceType: 'agent_event',
      sourceId: event.id,
      generationJobId: eventJob.id
    })).rejects.toThrow(/observation_id/);
    await expect(storage.observationGenerationJobs.transitionStatus({
      id: eventJob.id,
      projectId: other.project.id,
      teamId: other.project.teamId,
      status: 'processing',
      lockedBy: 'wrong-scope-worker'
    })).resolves.toBeNull();
    await expect(storage.observationGenerationJobEvents.append({
      generationJobId: eventJob.id,
      projectId: other.project.id,
      teamId: other.project.teamId,
      eventType: 'processing',
      statusAfter: 'processing'
    })).rejects.toThrow(/generation_job_id must belong/);

    await expect(storage.observationSources.listByObservationForScope({
      observationId: observation.id,
      projectId: project.id,
      teamId: project.teamId
    })).resolves.toEqual([]);
    await expect(storage.observationGenerationJobs.getByIdForScope({
      id: eventJob.id,
      projectId: project.id,
      teamId: project.teamId
    })).resolves.toMatchObject({ status: 'queued', attempts: 0, lockedBy: null });
    await expect(storage.observationGenerationJobEvents.listByJobForScope({
      generationJobId: eventJob.id,
      projectId: project.id,
      teamId: project.teamId
    })).resolves.toEqual([]);
  });

  it('deduplicates sessions by deterministic identity when external session IDs are omitted', async () => {
    const { project } = await createFixtureScope(storage);

    const first = await storage.sessions.create({
      projectId: project.id,
      teamId: project.teamId,
      contentSessionId: 'content-session-1',
      agentId: 'agent-1',
      platformSource: 'claude-code',
      metadata: { first: true }
    });
    const second = await storage.sessions.create({
      projectId: project.id,
      teamId: project.teamId,
      contentSessionId: 'content-session-1',
      agentId: 'agent-1',
      platformSource: 'claude-code',
      metadata: { second: true }
    });

    expect(second.id).toBe(first.id);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.idempotencyKey).not.toBeNull();
  });

  it('scopes external session identity by normalized platform source when supplied', async () => {
    const { project } = await createFixtureScope(storage);
    const externalSessionId = 'shared-external-session-id';

    const cursor = await storage.sessions.create({
      projectId: project.id,
      teamId: project.teamId,
      externalSessionId,
      platformSource: 'Cursor',
    });
    const cursorAgain = await storage.sessions.create({
      projectId: project.id,
      teamId: project.teamId,
      externalSessionId,
      platformSource: 'cursor-cli',
    });
    const codex = await storage.sessions.create({
      projectId: project.id,
      teamId: project.teamId,
      externalSessionId,
      platformSource: 'Codex CLI',
    });
    const legacy = await storage.sessions.create({
      projectId: project.id,
      teamId: project.teamId,
      externalSessionId,
    });

    expect(cursorAgain.id).toBe(cursor.id);
    expect(cursor.platformSource).toBe('cursor');
    expect(codex.platformSource).toBe('codex');
    expect(legacy.platformSource).toBeNull();
    expect(codex.id).not.toBe(cursor.id);
    expect(legacy.id).not.toBe(cursor.id);
    expect(legacy.id).not.toBe(codex.id);
  });

  it('exposes scoped getters for auth-visible project resources', async () => {
    const { project, session, event, eventJob } = await createFixtureScopeWithEventJob(storage);
    const other = await createFixtureScope(storage);
    const observation = await storage.observations.create({
      projectId: project.id,
      teamId: project.teamId,
      serverSessionId: session.id,
      content: 'Scoped getter observation',
      createdByJobId: eventJob.id
    });

    await expect(storage.projects.getByIdForTeam(project.id, project.teamId)).resolves.toMatchObject({ id: project.id });
    await expect(storage.sessions.getByIdForScope({
      id: session.id,
      projectId: project.id,
      teamId: project.teamId
    })).resolves.toMatchObject({ id: session.id });
    await expect(storage.agentEvents.getByIdForScope({
      id: event.id,
      projectId: project.id,
      teamId: project.teamId
    })).resolves.toMatchObject({ id: event.id });
    await expect(storage.observationGenerationJobs.getByIdForScope({
      id: eventJob.id,
      projectId: project.id,
      teamId: project.teamId
    })).resolves.toMatchObject({ id: eventJob.id });
    await expect(storage.observations.getByIdForScope({
      id: observation.id,
      projectId: project.id,
      teamId: project.teamId
    })).resolves.toMatchObject({ id: observation.id });

    await expect(storage.projects.getByIdForTeam(project.id, other.project.teamId)).resolves.toBeNull();
    await expect(storage.sessions.getByIdForScope({
      id: session.id,
      projectId: other.project.id,
      teamId: other.project.teamId
    })).resolves.toBeNull();
    await expect(storage.agentEvents.getByIdForScope({
      id: event.id,
      projectId: other.project.id,
      teamId: other.project.teamId
    })).resolves.toBeNull();
    await expect(storage.observationGenerationJobs.getByIdForScope({
      id: eventJob.id,
      projectId: other.project.id,
      teamId: other.project.teamId
    })).resolves.toBeNull();
    await expect(storage.observations.getByIdForScope({
      id: observation.id,
      projectId: other.project.id,
      teamId: other.project.teamId
    })).resolves.toBeNull();
  });

  it('does not expose unscoped auth-visible getters on exported repositories', async () => {
    for (const repository of [
      storage.projects,
      storage.sessions,
      storage.agentEvents,
      storage.observationGenerationJobs,
      storage.observations,
      storage.observationSources
    ]) {
      const exposed = repository as unknown as Record<string, unknown>;
      expect(exposed.getById).toBeUndefined();
      expect(exposed[['getById', 'Internal'].join('')]).toBeUndefined();
      expect(exposed[['listBy', 'Status'].join('')]).toBeUndefined();
      expect(exposed[['listBy', 'Job'].join('')]).toBeUndefined();
      expect(exposed[['listBy', 'Observation'].join('')]).toBeUndefined();
    }
  });

  it('scopes team lookup by membership', async () => {
    const team = await storage.teams.create({ name: 'Scoped Team' });
    await storage.teams.addMember({ teamId: team.id, userId: 'member-1', role: 'viewer' });

    await expect(storage.teams.getByIdForUser({
      id: team.id,
      userId: 'member-1'
    })).resolves.toMatchObject({ id: team.id });
    await expect(storage.teams.getByIdForUser({
      id: team.id,
      userId: 'outsider'
    })).resolves.toBeNull();
  });

  it('rejects illegal generation job lifecycle transitions and max-attempt retries', async () => {
    const { project, event } = await createFixtureScopeWithEventJob(storage);
    const job = await storage.observationGenerationJobs.create({
      projectId: project.id,
      teamId: project.teamId,
      sourceType: 'agent_event',
      sourceId: event.id,
      agentEventId: event.id,
      jobType: 'single_attempt_generate',
      maxAttempts: 1
    });

    const processing = await storage.observationGenerationJobs.transitionStatus({
      id: job.id,
      projectId: project.id,
      teamId: project.teamId,
      status: 'processing',
      lockedBy: 'worker-1'
    });
    await expect(storage.observationGenerationJobs.transitionStatus({
      id: job.id,
      projectId: project.id,
      teamId: project.teamId,
      status: 'queued',
      nextAttemptAt: new Date('2026-05-07T22:00:00.000Z')
    })).rejects.toThrow(/max_attempts/);
    const failed = await storage.observationGenerationJobs.transitionStatus({
      id: job.id,
      projectId: project.id,
      teamId: project.teamId,
      status: 'failed',
      lastError: { message: 'attempt failed' }
    });

    expect(processing?.attempts).toBe(1);
    expect(failed?.failedAtEpoch).not.toBeNull();
    expect(failed?.completedAtEpoch).toBeNull();
    expect(failed?.cancelledAtEpoch).toBeNull();
    await expect(storage.observationGenerationJobs.transitionStatus({
      id: job.id,
      projectId: project.id,
      teamId: project.teamId,
      status: 'processing',
      lockedBy: 'worker-2'
    })).rejects.toThrow(/terminal status failed/);
  });

  it('allows only one worker to transition a queued generation job to processing', async () => {
    const { eventJob } = await createFixtureScopeWithEventJob(storage);
    let workerA: PostgresPoolClient | null = null;
    let workerB: PostgresPoolClient | null = null;

    try {
      workerA = await pool.connect();
      workerB = await pool.connect();
      await workerA.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
      await workerB.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
      const workerAStorage = createPostgresStorageRepositories(workerA);
      const workerBStorage = createPostgresStorageRepositories(workerB);

      const results = await Promise.allSettled([
        workerAStorage.observationGenerationJobs.transitionStatus({
          id: eventJob.id,
          projectId: eventJob.projectId,
          teamId: eventJob.teamId,
          status: 'processing',
          lockedBy: 'worker-a'
        }),
        workerBStorage.observationGenerationJobs.transitionStatus({
          id: eventJob.id,
          projectId: eventJob.projectId,
          teamId: eventJob.teamId,
          status: 'processing',
          lockedBy: 'worker-b'
        })
      ]);
      const fulfilled = results.filter(result => result.status === 'fulfilled');
      const rejected = results.filter(result => result.status === 'rejected');
      const claimed = await storage.observationGenerationJobs.getByIdForScope({
        id: eventJob.id,
        projectId: eventJob.projectId,
        teamId: eventJob.teamId
      });

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(claimed?.status).toBe('processing');
      expect(claimed?.attempts).toBe(1);
    } finally {
      workerA?.release();
      workerB?.release();
    }
  });

  it('validates server session ownership when creating event generation jobs', async () => {
    const scope = await createFixtureScopeWithEventJob(storage);
    const other = await createFixtureScope(storage);
    const siblingSession = await storage.sessions.create({
      projectId: scope.project.id,
      teamId: scope.team.id,
      externalSessionId: crypto.randomUUID()
    });

    await expect(storage.observationGenerationJobs.create({
      projectId: scope.project.id,
      teamId: scope.team.id,
      sourceType: 'agent_event',
      sourceId: scope.event.id,
      agentEventId: scope.event.id,
      serverSessionId: other.session.id,
      jobType: 'invalid_cross_scope_session'
    })).rejects.toThrow(/server_session_id must belong/);
    await expect(storage.observationGenerationJobs.create({
      projectId: scope.project.id,
      teamId: scope.team.id,
      sourceType: 'agent_event',
      sourceId: scope.event.id,
      agentEventId: scope.event.id,
      serverSessionId: siblingSession.id,
      jobType: 'invalid_event_session'
    })).rejects.toThrow(/server_session_id must match/);
  });

  it('requires linked generation jobs to match observation source models', async () => {
    const { project, event, eventJob } = await createFixtureScopeWithEventJob(storage);
    const secondEvent = await storage.agentEvents.create({
      projectId: project.id,
      teamId: project.teamId,
      sourceAdapter: 'claude-code',
      sourceEventId: crypto.randomUUID(),
      eventType: 'assistant_response',
      payload: { content: 'second response' },
      occurredAt: new Date('2026-05-07T21:30:00.000Z')
    });
    const secondJob = await storage.observationGenerationJobs.create({
      projectId: project.id,
      teamId: project.teamId,
      sourceType: 'agent_event',
      sourceId: secondEvent.id,
      agentEventId: secondEvent.id,
      jobType: 'generate_observations'
    });
    const observation = await storage.observations.create({
      projectId: project.id,
      teamId: project.teamId,
      content: 'Observation source model validation'
    });

    await expect(storage.observationSources.addSource({
      observationId: observation.id,
      projectId: project.id,
      teamId: project.teamId,
      sourceType: 'agent_event',
      sourceId: event.id,
      generationJobId: secondJob.id
    })).rejects.toThrow(/source model/);
    await expect(storage.observationSources.addSource({
      observationId: observation.id,
      projectId: project.id,
      teamId: project.teamId,
      sourceType: 'agent_event',
      sourceId: event.id,
      agentEventId: secondEvent.id,
      generationJobId: eventJob.id
    })).rejects.toThrow(/source_id must equal agent_event_id/);
  });

  it('validates non-agent observation sources that are not linked through generation jobs', async () => {
    const scope = await createFixtureScope(storage);
    const other = await createFixtureScope(storage);
    const targetObservation = await storage.observations.create({
      projectId: scope.project.id,
      teamId: scope.project.teamId,
      content: 'Target observation for non-agent source validation'
    });
    const sourceObservation = await storage.observations.create({
      projectId: scope.project.id,
      teamId: scope.project.teamId,
      content: 'Source observation for reindex validation'
    });
    const otherObservation = await storage.observations.create({
      projectId: other.project.id,
      teamId: other.project.teamId,
      content: 'Cross-scope source observation'
    });

    await expect(storage.observationSources.addSource({
      observationId: targetObservation.id,
      projectId: scope.project.id,
      teamId: scope.project.teamId,
      sourceType: 'session_summary',
      sourceId: scope.session.id
    })).resolves.toMatchObject({ sourceType: 'session_summary', sourceId: scope.session.id });
    await expect(storage.observationSources.addSource({
      observationId: targetObservation.id,
      projectId: scope.project.id,
      teamId: scope.project.teamId,
      sourceType: 'observation_reindex',
      sourceId: sourceObservation.id
    })).resolves.toMatchObject({ sourceType: 'observation_reindex', sourceId: sourceObservation.id });
    await expect(storage.observationSources.addSource({
      observationId: targetObservation.id,
      projectId: scope.project.id,
      teamId: scope.project.teamId,
      sourceType: 'session_summary',
      sourceId: other.session.id
    })).rejects.toThrow(/server_session_id must belong/);
    await expect(storage.observationSources.addSource({
      observationId: targetObservation.id,
      projectId: scope.project.id,
      teamId: scope.project.teamId,
      sourceType: 'observation_reindex',
      sourceId: otherObservation.id
    })).rejects.toThrow(/observation_reindex source_id must belong/);
  });

  it('scopes generation job source uniqueness to project and team', async () => {
    const firstScope = await createFixtureScope(storage);
    const secondScope = await createFixtureScope(storage);
    const sharedSourceId = 'shared-source-id';
    const jobType = 'shared_source_generate';

    await client.query(
      `
        INSERT INTO observation_generation_jobs (
          id, project_id, team_id, source_type, source_id, job_type, status, idempotency_key
        )
        VALUES ($1, $2, $3, 'observation_reindex', $4, $5, 'queued', $6)
      `,
      [
        crypto.randomUUID(),
        firstScope.project.id,
        firstScope.project.teamId,
        sharedSourceId,
        jobType,
        'first-scope-source-key'
      ]
    );
    await client.query(
      `
        INSERT INTO observation_generation_jobs (
          id, project_id, team_id, source_type, source_id, job_type, status, idempotency_key
        )
        VALUES ($1, $2, $3, 'observation_reindex', $4, $5, 'queued', $6)
      `,
      [
        crypto.randomUUID(),
        secondScope.project.id,
        secondScope.project.teamId,
        sharedSourceId,
        jobType,
        'second-scope-source-key'
      ]
    );
    await expect(client.query(
      `
        INSERT INTO observation_generation_jobs (
          id, project_id, team_id, source_type, source_id, job_type, status, idempotency_key
        )
        VALUES ($1, $2, $3, 'observation_reindex', $4, $5, 'queued', $6)
      `,
      [
        crypto.randomUUID(),
        firstScope.project.id,
        firstScope.project.teamId,
        sharedSourceId,
        jobType,
        'duplicate-first-scope-source-key'
      ]
    )).rejects.toThrow();
  });

  it('deduplicates generation jobs by source model and records lifecycle events', async () => {
    const { project, session, event, eventJob } = await createFixtureScopeWithEventJob(storage);
    const other = await createFixtureScope(storage);
    const duplicateEventJob = await storage.observationGenerationJobs.create({
      projectId: project.id,
      teamId: project.teamId,
      sourceType: 'agent_event',
      sourceId: event.id,
      agentEventId: event.id,
      jobType: 'generate_observations'
    });

    const summaryJob = await storage.observationGenerationJobs.create({
      projectId: project.id,
      teamId: project.teamId,
      sourceType: 'session_summary',
      sourceId: session.id,
      serverSessionId: session.id,
      jobType: 'generate_session_summary'
    });
    const observation = await storage.observations.create({
      projectId: project.id,
      teamId: project.teamId,
      content: 'Reindexable observation'
    });
    const reindexJob = await storage.observationGenerationJobs.create({
      projectId: project.id,
      teamId: project.teamId,
      sourceType: 'observation_reindex',
      sourceId: observation.id,
      jobType: 'reindex_observation'
    });
    const processing = await storage.observationGenerationJobs.transitionStatus({
      id: eventJob.id,
      projectId: project.id,
      teamId: project.teamId,
      status: 'processing',
      lockedBy: 'worker-1'
    });
    await storage.observationGenerationJobEvents.append({
      generationJobId: eventJob.id,
      projectId: project.id,
      teamId: project.teamId,
      eventType: 'queued',
      statusAfter: 'queued'
    });
    await storage.observationGenerationJobEvents.append({
      generationJobId: eventJob.id,
      projectId: project.id,
      teamId: project.teamId,
      eventType: 'processing',
      statusAfter: 'processing',
      attempt: processing?.attempts ?? 1
    });

    const scopedQueuedJobs = await storage.observationGenerationJobs.listByStatusForScope({
      status: 'queued',
      projectId: project.id,
      teamId: project.teamId
    });
    const wrongScopeQueuedJobs = await storage.observationGenerationJobs.listByStatusForScope({
      status: 'queued',
      projectId: other.project.id,
      teamId: other.project.teamId
    });
    const lifecycle = await storage.observationGenerationJobEvents.listByJobForScope({
      generationJobId: eventJob.id,
      projectId: project.id,
      teamId: project.teamId
    });
    const wrongScopeLifecycle = await storage.observationGenerationJobEvents.listByJobForScope({
      generationJobId: eventJob.id,
      projectId: other.project.id,
      teamId: other.project.teamId
    });

    expect(duplicateEventJob.id).toBe(eventJob.id);
    expect(summaryJob.sourceType).toBe('session_summary');
    expect(summaryJob.agentEventId).toBeNull();
    expect(summaryJob.serverSessionId).toBe(session.id);
    expect(reindexJob.sourceType).toBe('observation_reindex');
    expect(reindexJob.agentEventId).toBeNull();
    expect(processing?.attempts).toBe(1);
    expect(scopedQueuedJobs.map(job => job.id).sort()).toEqual([summaryJob.id, reindexJob.id].sort());
    expect(wrongScopeQueuedJobs).toEqual([]);
    expect(lifecycle.map(eventRecord => eventRecord.eventType)).toEqual(['queued', 'processing']);
    expect(wrongScopeLifecycle).toEqual([]);
  });
});

async function createFixtureScope(storage: PostgresStorageRepositories) {
  const team = await storage.teams.create({ name: 'Core' });
  const project = await storage.projects.create({ teamId: team.id, name: 'Claude Mem' });
  const session = await storage.sessions.create({
    projectId: project.id,
    teamId: team.id,
    externalSessionId: crypto.randomUUID(),
    platformSource: 'claude-code'
  });

  return { team, project, session };
}

async function createFixtureScopeWithEventJob(storage: PostgresStorageRepositories) {
  const scope = await createFixtureScope(storage);
  const event = await storage.agentEvents.create({
    projectId: scope.project.id,
    teamId: scope.team.id,
    serverSessionId: scope.session.id,
    sourceAdapter: 'claude-code',
    sourceEventId: crypto.randomUUID(),
    eventType: 'assistant_response',
    payload: { content: 'response' },
    occurredAt: new Date('2026-05-07T21:00:00.000Z')
  });
  const eventJob = await storage.observationGenerationJobs.create({
    projectId: scope.project.id,
    teamId: scope.team.id,
    sourceType: 'agent_event',
    sourceId: event.id,
    agentEventId: event.id,
    serverSessionId: scope.session.id,
    jobType: 'generate_observations'
  });

  return { ...scope, event, eventJob };
}
