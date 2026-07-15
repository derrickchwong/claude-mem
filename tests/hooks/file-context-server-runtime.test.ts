import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';

// Capture the REAL modules BEFORE mocking so afterAll can restore them.
// bun's `mock.module` is process-global and sticky; `mock.restore()` does NOT
// undo it, so we must explicitly re-register the real implementations to keep
// the suite order-independent (otherwise these mocks leak into later files).
import * as realSettingsDefaultsManager from '../../src/shared/SettingsDefaultsManager.js';
import * as realWorkerUtils from '../../src/shared/worker-utils.js';
import * as realProjectName from '../../src/utils/project-name.js';
import * as realProjectFilter from '../../src/utils/project-filter.js';
import * as realRuntimeSelector from '../../src/services/hooks/runtime-selector.js';

const realSettingsSnapshot = { ...realSettingsDefaultsManager };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };
const realProjectNameSnapshot = { ...realProjectName };
const realProjectFilterSnapshot = { ...realProjectFilter };
const realRuntimeSelectorSnapshot = { ...realRuntimeSelector };

let workerFallbackCalled = false;
let resolveRuntimeContextCalled = false;

mock.module('../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: (key: string) => {
      if (key === 'CLAUDE_MEM_DATA_DIR') return join(homedir(), '.claude-mem');
      return '';
    },
    getInt: () => 0,
    loadFromFile: () => ({ CLAUDE_MEM_EXCLUDED_PROJECTS: [] }),
  },
}));

mock.module('../../src/shared/worker-utils.js', () => ({
  ensureWorkerRunning: () => Promise.resolve(true),
  getWorkerPort: () => 37777,
  workerHttpRequest: (apiPath: string, options?: any) => {
    workerFallbackCalled = true;
    return globalThis.fetch(`http://127.0.0.1:37777${apiPath}`, {
      method: options?.method ?? 'GET',
      headers: options?.headers,
      body: options?.body,
    });
  },
  executeWithWorkerFallback: async () => {
    workerFallbackCalled = true;
    throw new Error('worker fallback should not be called in server-runtime mode');
  },
  isWorkerFallback: () => false,
}));

mock.module('../../src/utils/project-name.js', () => ({
  getProjectName: () => 'test-project',
  getProjectContext: () => ({ allProjects: ['test-project'] }),
}));

mock.module('../../src/utils/project-filter.js', () => ({
  isProjectExcluded: () => false,
}));

// This is the one mock that matters for this suite: server-runtime deployments
// have no worker to reach, and file-context.ts has no server-mode equivalent
// to the worker's /api/observations/by-file lookup, so it must degrade to a
// no-op rather than calling executeWithWorkerFallback (which would always hit
// the worker-unreachable path in this runtime).
mock.module('../../src/services/hooks/runtime-selector.js', () => ({
  resolveRuntimeContext: () => {
    resolveRuntimeContextCalled = true;
    return {
      runtime: 'server',
      projectId: 'server-project-1',
      serverBaseUrl: 'http://server.test',
      client: {},
    };
  },
}));

import { fileContextHandler } from '../../src/cli/handlers/file-context.js';
import { logger } from '../../src/utils/logger.js';

const PADDING = 'x'.repeat(2_000);

let tmpDir: string;
let testFile: string;
let loggerSpies: ReturnType<typeof spyOn>[] = [];
let fetchSpy: ReturnType<typeof spyOn> | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'file-context-server-runtime-test-'));
  testFile = join(tmpDir, 'test.md');
  writeFileSync(testFile, PADDING);

  workerFallbackCalled = false;
  resolveRuntimeContextCalled = false;

  loggerSpies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
  ];

  // Any call to fetch in this suite would mean the no-op branch was skipped
  // and the (mocked-to-fail) worker fallback path was reached instead.
  fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(
    new Error('fetch should not be called in server-runtime mode')
  );
});

afterEach(() => {
  loggerSpies.forEach(s => s.mockRestore());
  if (fetchSpy) {
    fetchSpy.mockRestore();
    fetchSpy = null;
  }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

afterAll(() => {
  mock.module('../../src/shared/SettingsDefaultsManager.js', () => realSettingsSnapshot);
  mock.module('../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
  mock.module('../../src/utils/project-name.js', () => realProjectNameSnapshot);
  mock.module('../../src/utils/project-filter.js', () => realProjectFilterSnapshot);
  mock.module('../../src/services/hooks/runtime-selector.js', () => realRuntimeSelectorSnapshot);
});

describe('fileContextHandler in server runtime (CLAUDE_MEM_RUNTIME=server)', () => {
  it('degrades to a silent no-op instead of hitting the worker-unreachable path', async () => {
    const result = await fileContextHandler.execute({
      sessionId: 'sess',
      cwd: tmpDir,
      toolName: 'Read',
      toolInput: { file_path: testFile },
    });

    expect(resolveRuntimeContextCalled).toBe(true);
    expect(workerFallbackCalled).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ continue: true, suppressOutput: true });
  });

  it('degrades before iterating a Codex filePaths array too', async () => {
    const otherFile = join(tmpDir, 'other.md');
    writeFileSync(otherFile, PADDING);

    const result = await fileContextHandler.execute({
      sessionId: 'sess',
      cwd: tmpDir,
      toolName: 'Bash',
      toolInput: { filePaths: [testFile, otherFile] },
    });

    expect(workerFallbackCalled).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ continue: true, suppressOutput: true });
  });
});
