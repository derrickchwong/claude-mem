// SPDX-License-Identifier: Apache-2.0
//
// End-to-end verification that `search`/`timeline`/`get_observations` work
// under CLAUDE_MEM_RUNTIME=server: spawns the REAL mcp-server.ts entrypoint
// as a subprocess (never imported — importing it runs the stdio bootstrap,
// see mcp-server-name-safety.test.ts) and speaks raw MCP JSON-RPC to it over
// stdio, exactly as Claude Code / Codex would, against a real Server +
// ServerV1PostgresRoutes instance on a real (schema-isolated) Postgres.
//
// Before this change these three tools always called a local per-container
// worker over HTTP that the plugin deliberately never starts when
// CLAUDE_MEM_RUNTIME=server — every call failed with "Worker API: fetch
// failed" (verified directly against the deployed plugin bundle). This test
// pins the fix at the protocol level, not just the unit level.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import pg from 'pg';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
const MCP_SERVER_ENTRYPOINT = path.join(import.meta.dir, '..', '..', 'src', 'servers', 'mcp-server.ts');

describe('search/timeline/get_observations over real MCP stdio under CLAUDE_MEM_RUNTIME=server', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  let pool: pg.Pool;
  let client: PostgresPoolClient;
  let schemaName: string;
  let storage: PostgresStorageRepositories;
  let httpServer: Server;
  let httpPort: number;
  let apiKey: string;
  let projectId: string;
  let ids: string[];
  let spies: ReturnType<typeof spyOn>[] = [];
  let tmpHome: string;
  let child: ChildProcessWithoutNullStreams;
  let rl: Interface;
  let nextId = 1;
  const pending = new Map<number, (msg: any) => void>();

  function send(obj: unknown): void {
    child.stdin.write(JSON.stringify(obj) + '\n');
  }

  function request(method: string, params: unknown, timeoutMs = 15000): Promise<any> {
    const id = nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); resolve({ __timeout: true }); }
      }, timeoutMs);
      pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
      send({ jsonrpc: '2.0', id, method, params });
    });
  }

  async function callTool(name: string, args: unknown): Promise<{ isError: boolean; text: string }> {
    const resp = await request('tools/call', { name, arguments: args });
    if (resp.__timeout) return { isError: true, text: '__TIMEOUT__' };
    if (resp.error) return { isError: true, text: JSON.stringify(resp.error) };
    const r = resp.result ?? {};
    const text = (r.content ?? []).map((c: any) => c.text ?? '').join('\n');
    return { isError: r.isError === true, text };
  }

  beforeAll(async () => {
    spies = ['info', 'warn', 'error', 'debug'].map((m) => spyOn(logger, m as 'info').mockImplementation(() => {}));
    schemaName = await createIsolatedSchema(testDatabaseUrl!, 'cm_mcp_stdio');
    pool = poolForSchema(testDatabaseUrl!, schemaName);
    client = await pool.connect();
    await bootstrapServerPostgresSchema(client);
    storage = createPostgresStorageRepositories(client);

    const team = await storage.teams.create({ name: 'team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'P' });
    projectId = project.id;

    ids = [];
    for (const content of ['alpha memory entry', 'beta memory entry', 'gamma memory entry']) {
      const observation = await storage.observations.create({ projectId, teamId: team.id, kind: 'manual', content });
      ids.push(observation.id);
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    const keyMaterial = newApiKey();
    apiKey = keyMaterial.raw;
    await storage.auth.createApiKey({
      keyHash: keyMaterial.hash, teamId: team.id, projectId, actorId: 't', scopes: ['memories:read', 'memories:write'],
    });

    httpServer = new Server({
      getInitializationComplete: () => true, getMcpReady: () => true,
      onShutdown: mock(() => Promise.resolve()), onRestart: mock(() => Promise.resolve()),
      workerPath: '/test/worker.cjs', runtime: 'server-beta',
      getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
    });
    httpServer.registerRoutes(new ServerV1PostgresRoutes({
      pool: pool as never, queueManager: new DisabledServerQueueManager('disabled'), authMode: 'api-key',
    }));
    httpServer.finalizeRoutes();
    await httpServer.listen(0, '127.0.0.1');
    const addr = httpServer.getHttpServer()?.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    httpPort = addr.port;

    // Isolate the spawned plugin process's settings.json (~/.claude-mem)
    // from the real developer machine — see src/shared/paths.ts, which
    // derives everything from os.homedir(), which respects $HOME.
    tmpHome = mkdtempSync(path.join(tmpdir(), 'claude-mem-mcp-stdio-home-'));

    child = spawn('bun', ['run', MCP_SERVER_ENTRYPOINT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: tmpHome,
        CLAUDE_MEM_RUNTIME: 'server',
        CLAUDE_MEM_SERVER_URL: `http://127.0.0.1:${httpPort}`,
        CLAUDE_MEM_SERVER_API_KEY: apiKey,
        CLAUDE_MEM_SERVER_PROJECT_ID: projectId,
      },
    });
    rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      let msg: any;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    });

    const init = await request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0.0.0' },
    }, 20000);
    if (init.__timeout) throw new Error('mcp-server subprocess did not respond to initialize in time');
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }, 30000);

  afterAll(async () => {
    rl?.close();
    child?.kill('SIGTERM');
    try { await httpServer.close(); } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ERR_SERVER_NOT_RUNNING') throw e;
    }
    client.release();
    await pool.end();
    await dropSchema(testDatabaseUrl!, schemaName);
    rmSync(tmpHome, { recursive: true, force: true });
    spies.forEach((s) => s.mockRestore());
    mock.restore();
  }, 15000);

  it('search returns real server-backed observations for a plain-text query (previously: instant "Worker API: fetch failed")', async () => {
    const result = await callTool('search', { query: 'beta memory' });
    expect(result.isError).toBe(false);
    expect(result.text).toContain('beta memory entry');
  });

  it('search relaxes a verbose multi-word query to OR semantics instead of returning nothing', async () => {
    // No stored observation contains every one of these words, so the strict
    // websearch AND pass is empty; the OR fallback still surfaces the
    // closest match instead of the empty result agents used to get.
    const result = await callTool('search', { query: 'delta beta memory bulletin' });
    expect(result.isError).toBe(false);
    expect(result.text).toContain('beta memory entry');
  });

  it('session_start_context serves the connected project in server mode (previously: dead worker path)', async () => {
    // Schema-following callers always send `project` (worker mode requires
    // it); server mode is key-scoped to one project, so the name filter is
    // accepted and ignored rather than rejected.
    const result = await callTool('session_start_context', { project: 'some/worker-mode-name' });
    expect(result.isError).toBe(false);
    expect(result.text).toContain('memory entry');
  });

  it('session_start_context needs no project argument at all in server mode', async () => {
    const result = await callTool('session_start_context', {});
    expect(result.isError).toBe(false);
    expect(result.text).toContain('memory entry');
  });

  it('search rejects an unsupported filter (dateStart) with a clear, actionable error instead of silently ignoring it', async () => {
    const result = await callTool('search', { query: 'alpha', dateStart: '2026-01-01' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('dateStart');
    expect(result.text).toContain('not supported');
  });

  it('search with no query at all falls back to recency-ordered browse instead of erroring', async () => {
    const result = await callTool('search', {});
    expect(result.isError).toBe(false);
    expect(result.text).toContain('gamma memory entry');
  });

  it('get_observations fetches full content by id, preserving the requested (reverse-of-creation) order', async () => {
    const result = await callTool('get_observations', { ids: [ids[2], ids[0]] });
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.text);
    expect(parsed.observations.map((o: { id: string }) => o.id)).toEqual([ids[2], ids[0]]);
  });

  it('timeline resolves an anchor by id and returns chronological before/after context', async () => {
    const result = await callTool('timeline', { anchor: ids[1], depth_before: 1, depth_after: 1 });
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.text);
    expect(parsed.anchor.id).toBe(ids[1]);
    expect(parsed.before.map((o: { id: string }) => o.id)).toEqual([ids[0]]);
    expect(parsed.after.map((o: { id: string }) => o.id)).toEqual([ids[2]]);
  });

  it('timeline resolves an anchor from a query when no anchor id is given', async () => {
    const result = await callTool('timeline', { query: 'gamma memory' });
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.text);
    expect(parsed.anchor.id).toBe(ids[2]);
  });

  it('search accepts offset: 0 (its own no-op default) instead of rejecting it as an unsupported filter', async () => {
    const result = await callTool('search', { query: 'beta memory', offset: 0 });
    expect(result.isError).toBe(false);
    expect(result.text).toContain('beta memory entry');
  });

  it('search still rejects a real pagination offset (non-zero) as unsupported', async () => {
    const result = await callTool('search', { query: 'beta memory', offset: 5 });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('offset');
    expect(result.text).toContain('not supported');
  });

  it('search rejects the worker-mode "project" name filter instead of silently misapplying it as the Postgres project id', async () => {
    const result = await callTool('search', { query: 'beta memory', project: 'some-worker-mode-project-name' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('project');
    expect(result.text).toContain('not supported');
  });

  it('timeline rejects the worker-mode "project" name filter the same way', async () => {
    const result = await callTool('timeline', { anchor: ids[1], project: 'some-worker-mode-project-name' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('project');
    expect(result.text).toContain('not supported');
  });

  it('get_observations rejects the worker-mode "project" name filter the same way', async () => {
    const result = await callTool('get_observations', { ids: [ids[0]], project: 'some-worker-mode-project-name' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('project');
    expect(result.text).toContain('not supported');
  });

  it('get_observations honors orderBy and limit instead of silently ignoring them', async () => {
    const result = await callTool('get_observations', {
      ids: [ids[0], ids[2], ids[1]],
      orderBy: 'date_desc',
      limit: 2,
    });
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.text);
    // date_desc over ids[0..2] (created in that chronological order) is
    // ids[2], ids[1], ids[0] — capped to the 2 most recent by limit.
    expect(parsed.observations.map((o: { id: string }) => o.id)).toEqual([ids[2], ids[1]]);
  });
});

describe('get_observations worker-mode ids validation (CLAUDE_MEM_RUNTIME unset)', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  let workerChild: ChildProcessWithoutNullStreams;
  let workerRl: Interface;
  let workerTmpHome: string;
  let workerNextId = 1;
  const workerPending = new Map<number, (msg: any) => void>();

  function workerSend(obj: unknown): void {
    workerChild.stdin.write(JSON.stringify(obj) + '\n');
  }

  function workerRequest(method: string, params: unknown, timeoutMs = 15000): Promise<any> {
    const id = workerNextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (workerPending.has(id)) { workerPending.delete(id); resolve({ __timeout: true }); }
      }, timeoutMs);
      workerPending.set(id, (m) => { clearTimeout(timer); resolve(m); });
      workerSend({ jsonrpc: '2.0', id, method, params });
    });
  }

  async function workerCallTool(name: string, args: unknown): Promise<{ isError: boolean; text: string }> {
    const resp = await workerRequest('tools/call', { name, arguments: args });
    if (resp.__timeout) return { isError: true, text: '__TIMEOUT__' };
    if (resp.error) return { isError: true, text: JSON.stringify(resp.error) };
    const r = resp.result ?? {};
    const text = (r.content ?? []).map((c: any) => c.text ?? '').join('\n');
    return { isError: r.isError === true, text };
  }

  beforeAll(async () => {
    workerTmpHome = mkdtempSync(path.join(tmpdir(), 'claude-mem-mcp-worker-home-'));
    workerChild = spawn('bun', ['run', MCP_SERVER_ENTRYPOINT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: workerTmpHome,
        // Deliberately unset: defaults to worker mode.
        CLAUDE_MEM_RUNTIME: '',
      },
    });
    workerRl = createInterface({ input: workerChild.stdout });
    workerRl.on('line', (line) => {
      let msg: any;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id !== undefined && workerPending.has(msg.id)) {
        workerPending.get(msg.id)!(msg);
        workerPending.delete(msg.id);
      }
    });
    const init = await workerRequest('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0.0.0' },
    }, 20000);
    if (init.__timeout) throw new Error('worker-mode mcp-server subprocess did not respond to initialize in time');
    workerSend({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }, 30000);

  afterAll(async () => {
    workerRl?.close();
    workerChild?.kill('SIGTERM');
    rmSync(workerTmpHome, { recursive: true, force: true });
  }, 15000);

  it('rejects a non-numeric id with a clear error instead of forwarding it to the worker (which would 400 with a less clear message)', async () => {
    const result = await workerCallTool('get_observations', { ids: ['not-a-number'] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('not-a-number');
    expect(result.text).toContain('not a valid worker-mode id');
  });
});
