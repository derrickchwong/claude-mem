// SPDX-License-Identifier: Apache-2.0
//
// POST /v1/memories/batch and POST /v1/timeline — the server-runtime REST
// endpoints that back the legacy worker-mode MCP tools `get_observations`
// and `timeline`. Before this change, those tools always called a local
// per-container worker over HTTP that the plugin deliberately never starts
// when CLAUDE_MEM_RUNTIME=server, so every call failed. Postgres-gated,
// mirrors the isolation pattern in context-recency-mode.test.ts.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import pg from 'pg';
import { Server } from '../../src/services/server/Server.js';
import { ServerV1PostgresRoutes } from '../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../src/storage/postgres/index.js';
import { DisabledServerQueueManager } from '../../src/server/runtime/types.js';
import { logger } from '../../src/utils/logger.js';
import { newApiKey, createIsolatedSchema, poolForSchema, dropSchema } from '../sdk/pg-isolation.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

describe('POST /v1/memories/batch and POST /v1/timeline', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  let pool: pg.Pool;
  let client: PostgresPoolClient;
  let schemaName: string;
  let storage: PostgresStorageRepositories;
  let server: Server;
  let port: number;
  let readKey: string;
  let otherProjectReadKey: string;
  let teamId: string;
  let projectId: string;
  let otherProjectId: string;
  let ids: string[];
  let spies: ReturnType<typeof spyOn>[] = [];

  beforeEach(async () => {
    spies = ['info', 'warn', 'error', 'debug'].map((m) => spyOn(logger, m as 'info').mockImplementation(() => {}));
    schemaName = await createIsolatedSchema(testDatabaseUrl!, 'cm_batch_timeline');
    pool = poolForSchema(testDatabaseUrl!, schemaName);
    client = await pool.connect();
    await bootstrapServerPostgresSchema(client);
    storage = createPostgresStorageRepositories(client);

    const team = await storage.teams.create({ name: 'team' });
    teamId = team.id;
    const project = await storage.projects.create({ teamId, name: 'P' });
    projectId = project.id;
    const otherProject = await storage.projects.create({ teamId, name: 'Other' });
    otherProjectId = otherProject.id;

    ids = [];
    for (let i = 0; i < 5; i++) {
      const observation = await storage.observations.create({
        projectId, teamId, kind: 'manual', content: `timeline observation ${i}`,
      });
      ids.push(observation.id);
      // Distinct created_at values matter for timeline ordering.
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    const readKeyMaterial = newApiKey(); readKey = readKeyMaterial.raw;
    await storage.auth.createApiKey({
      keyHash: readKeyMaterial.hash, teamId, projectId, actorId: 't', scopes: ['memories:read', 'memories:write'],
    });
    const otherKeyMaterial = newApiKey(); otherProjectReadKey = otherKeyMaterial.raw;
    await storage.auth.createApiKey({
      keyHash: otherKeyMaterial.hash, teamId, projectId: otherProjectId, actorId: 't2', scopes: ['memories:read'],
    });

    server = new Server({
      getInitializationComplete: () => true, getMcpReady: () => true,
      onShutdown: mock(() => Promise.resolve()), onRestart: mock(() => Promise.resolve()),
      workerPath: '/test/worker.cjs', runtime: 'server-beta',
      getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
    });
    server.registerRoutes(new ServerV1PostgresRoutes({
      pool: pool as never, queueManager: new DisabledServerQueueManager('disabled'),
      authMode: 'api-key',
    }));
    server.finalizeRoutes();
    await server.listen(0, '127.0.0.1');
    const addr = server.getHttpServer()?.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    port = addr.port;
  });

  afterEach(async () => {
    try { await server.close(); } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ERR_SERVER_NOT_RUNNING') throw e;
    }
    client.release();
    await pool.end();
    await dropSchema(testDatabaseUrl!, schemaName);
    spies.forEach((s) => s.mockRestore());
    mock.restore();
  });

  const url = (p: string) => `http://127.0.0.1:${port}${p}`;
  const authHeaders = (key: string) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' });
  const post = (p: string, body: unknown, key: string = readKey) =>
    fetch(url(p), { method: 'POST', headers: authHeaders(key), body: JSON.stringify(body) });

  describe('/v1/memories/batch', () => {
    it('fetches multiple observations by id in one call, preserving requested order', async () => {
      const r = await post('/v1/memories/batch', { projectId, ids: [ids[2], ids[0]] });
      expect(r.status).toBe(200);
      const body = await r.json() as { observations: Array<{ id: string; content: string }> };
      expect(body.observations.map(o => o.id)).toEqual([ids[2], ids[0]]);
    });

    it('silently omits ids that do not exist', async () => {
      const r = await post('/v1/memories/batch', { projectId, ids: [ids[0], 'does-not-exist'] });
      expect(r.status).toBe(200);
      const body = await r.json() as { observations: Array<{ id: string }> };
      expect(body.observations.map(o => o.id)).toEqual([ids[0]]);
    });

    it('does not leak observations from another project scoped to the same team', async () => {
      const r = await post('/v1/memories/batch', { projectId: otherProjectId, ids: [ids[0]] }, otherProjectReadKey);
      expect(r.status).toBe(200);
      const body = await r.json() as { observations: unknown[] };
      expect(body.observations).toEqual([]);
    });

    it('403s when a project-scoped key requests a different project', async () => {
      const r = await post('/v1/memories/batch', { projectId: otherProjectId, ids: [ids[0]] });
      expect(r.status).toBe(403);
    });

    it('400s when ids is missing or empty', async () => {
      const missing = await post('/v1/memories/batch', { projectId });
      expect(missing.status).toBe(400);
      const empty = await post('/v1/memories/batch', { projectId, ids: [] });
      expect(empty.status).toBe(400);
    });
  });

  describe('/v1/timeline', () => {
    it('returns the anchor plus chronological before/after context by anchorId', async () => {
      const r = await post('/v1/timeline', { projectId, anchorId: ids[2], depthBefore: 2, depthAfter: 2 });
      expect(r.status).toBe(200);
      const body = await r.json() as {
        anchor: { id: string };
        before: Array<{ id: string }>;
        after: Array<{ id: string }>;
      };
      expect(body.anchor.id).toBe(ids[2]);
      expect(body.before.map(o => o.id)).toEqual([ids[0], ids[1]]);
      expect(body.after.map(o => o.id)).toEqual([ids[3], ids[4]]);
    });

    it('resolves an anchor from the top search hit when only query is given', async () => {
      const r = await post('/v1/timeline', { projectId, query: 'observation 2', depthBefore: 1, depthAfter: 1 });
      expect(r.status).toBe(200);
      const body = await r.json() as { anchor: { id: string; content: string } };
      expect(body.anchor.id).toBe(ids[2]);
    });

    it('defaults depthBefore/depthAfter to 10 (matching worker-mode\'s real SearchManager.timeline() default) when omitted', async () => {
      // The shared 5-row fixture can't distinguish a default of 3 from 10
      // (only 2 rows are ever available on either side of ids[2]) — seed
      // enough rows around a fresh anchor to make a wrong default fail loudly.
      const extraIds: string[] = [];
      for (let i = 0; i < 24; i++) {
        const observation = await storage.observations.create({
          projectId, teamId, kind: 'manual', content: `depth-default observation ${i}`,
        });
        extraIds.push(observation.id);
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      const anchorId = extraIds[12];

      const r = await post('/v1/timeline', { projectId, anchorId });
      expect(r.status).toBe(200);
      const body = await r.json() as { before: Array<{ id: string }>; after: Array<{ id: string }> };
      expect(body.before).toHaveLength(10);
      expect(body.after).toHaveLength(10);
      expect(body.before.map(o => o.id)).toEqual(extraIds.slice(2, 12));
      expect(body.after.map(o => o.id)).toEqual(extraIds.slice(13, 23));
    });

    it('404s when the anchor id does not exist', async () => {
      const r = await post('/v1/timeline', { projectId, anchorId: 'does-not-exist' });
      expect(r.status).toBe(404);
    });

    it('404s when neither the anchor nor a query resolves any observation', async () => {
      const r = await post('/v1/timeline', { projectId, query: 'no such content anywhere' });
      expect(r.status).toBe(404);
    });

    it('400s when neither anchorId nor query is given', async () => {
      const r = await post('/v1/timeline', { projectId });
      expect(r.status).toBe(400);
    });

    it('resolves via query when anchorId is an explicit empty string, instead of 400ing on it', async () => {
      // A caller/template that always sends anchorId (empty when unset)
      // rather than omitting the key must still fall through to query-based
      // resolution, not fail the field-level .min(1) check first.
      const r = await post('/v1/timeline', { projectId, anchorId: '', query: 'observation 2' });
      expect(r.status).toBe(200);
      const body = await r.json() as { anchor: { id: string } };
      expect(body.anchor.id).toBe(ids[2]);
    });

    it('still 400s when anchorId and query are both empty strings', async () => {
      const r = await post('/v1/timeline', { projectId, anchorId: '', query: '' });
      expect(r.status).toBe(400);
    });

    it('403s when a project-scoped key requests a different project', async () => {
      const r = await post('/v1/timeline', { projectId: otherProjectId, anchorId: ids[0] });
      expect(r.status).toBe(403);
    });
  });
});
