// SPDX-License-Identifier: Apache-2.0
//
// formatContextBlock — the `context` string POST /v1/context returns and the
// SessionStart hook injects verbatim. Each memory carries its id and UTC
// creation date so an agent can cite it and a caller can tell which memories
// a run received (derrickchwong/app-rewrite Issue #2277).

import { describe, expect, it } from 'bun:test';
import { formatContextBlock, formatContextEntry } from '../../src/server/context-block.js';

// 2026-09-29T23:30:00Z — late enough in the day that a local-time render
// east of UTC would print 2026-09-30.
const LATE_UTC = Date.UTC(2026, 8, 29, 23, 30);
const EARLY_UTC = Date.UTC(2026, 0, 2, 0, 5);

describe('formatContextEntry', () => {
  it('renders the header from metadata.title and drops a first content line equal to it', () => {
    expect(formatContextEntry({
      id: 'obs_a',
      content: 'Build uses pnpm\nThe root package.json pins pnpm 9; npm install fails.',
      metadata: { title: 'Build uses pnpm' },
      createdAtEpoch: LATE_UTC,
    })).toBe('[memory:obs_a · 2026-09-29] Build uses pnpm\nThe root package.json pins pnpm 9; npm install fails.');
  });

  it('keeps the whole content when its first line differs from metadata.title', () => {
    expect(formatContextEntry({
      id: 'obs_b',
      content: 'Tests need Postgres 16.\nSet CLAUDE_MEM_TEST_POSTGRES_URL.',
      metadata: { title: 'Test database' },
      createdAtEpoch: EARLY_UTC,
    })).toBe('[memory:obs_b · 2026-01-02] Test database\nTests need Postgres 16.\nSet CLAUDE_MEM_TEST_POSTGRES_URL.');
  });

  it('falls back to the first non-empty content line when metadata.title is missing, blank or not a string', () => {
    for (const metadata of [{}, { title: '   ' }, { title: 42 }]) {
      expect(formatContextEntry({
        id: 'obs_c',
        content: 'Deploys go through Cloud Build\nNever push images by hand.',
        metadata,
        createdAtEpoch: EARLY_UTC,
      })).toBe('[memory:obs_c · 2026-01-02] Deploys go through Cloud Build\nNever push images by hand.');
    }
  });

  it('uses the first NON-empty line as the fallback title, leaving content whose first line is blank intact', () => {
    expect(formatContextEntry({
      id: 'obs_d',
      content: '\n  Cache lives in /tmp\nClear it when inodes run out.',
      metadata: {},
      createdAtEpoch: EARLY_UTC,
    })).toBe('[memory:obs_d · 2026-01-02] Cache lives in /tmp\n\n  Cache lives in /tmp\nClear it when inodes run out.');
  });

  it('collapses a multi-line title to one line so the header stays one line', () => {
    const entry = formatContextEntry({
      id: 'obs_e',
      content: 'Body text.',
      metadata: { title: 'Auth flow\n  uses\r\nOIDC' },
      createdAtEpoch: EARLY_UTC,
    });
    expect(entry).toBe('[memory:obs_e · 2026-01-02] Auth flow uses OIDC\nBody text.');
    expect(entry.split('\n')[0]).toBe('[memory:obs_e · 2026-01-02] Auth flow uses OIDC');
  });

  it('renders a single-line observation whose only line is the title as the header alone', () => {
    expect(formatContextEntry({
      id: 'obs_f',
      content: 'Only line',
      metadata: {},
      createdAtEpoch: EARLY_UTC,
    })).toBe('[memory:obs_f · 2026-01-02] Only line');
  });
});

describe('formatContextBlock', () => {
  it('opens with a newest-first header, separates entries by a blank line and keeps the given order', () => {
    const block = formatContextBlock([
      { id: 'obs_new', content: 'Newer note\nSecond line.', metadata: {}, createdAtEpoch: LATE_UTC },
      { id: 'obs_old', content: 'Older note', metadata: { title: 'Old title' }, createdAtEpoch: EARLY_UTC },
    ], 'newest-first');
    expect(block).toBe(
      '# Project memory: 2 memories, newest first\n\n'
      + '[memory:obs_new · 2026-09-29] Newer note\nSecond line.\n\n'
      + '[memory:obs_old · 2026-01-02] Old title\nOlder note',
    );
  });

  it('makes no ordering claim in the header for a relevance-ranked result', () => {
    const block = formatContextBlock([
      { id: 'obs_old', content: 'Older note', metadata: {}, createdAtEpoch: EARLY_UTC },
      { id: 'obs_new', content: 'Newer note', metadata: {}, createdAtEpoch: LATE_UTC },
    ], 'ranked');
    expect(block).toBe(
      '# Project memory: 2 memories\n\n'
      + '[memory:obs_old · 2026-01-02] Older note\n\n'
      + '[memory:obs_new · 2026-09-29] Newer note',
    );
  });

  it('counts only rendered entries: observations with empty content are skipped, as the previous join did', () => {
    expect(formatContextBlock([
      { id: 'obs_empty', content: '', metadata: { title: 'x' }, createdAtEpoch: EARLY_UTC },
      { id: 'obs_kept', content: 'Kept', metadata: {}, createdAtEpoch: EARLY_UTC },
    ], 'newest-first')).toBe('# Project memory: 1 memories, newest first\n\n[memory:obs_kept · 2026-01-02] Kept');
  });

  it('returns an empty string, with no header, when there is nothing to inject', () => {
    expect(formatContextBlock([], 'newest-first')).toBe('');
    expect(formatContextBlock([], 'ranked')).toBe('');
    expect(formatContextBlock([
      { id: 'obs_empty', content: '', metadata: {}, createdAtEpoch: EARLY_UTC },
    ], 'newest-first')).toBe('');
  });
});
