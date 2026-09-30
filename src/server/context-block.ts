// SPDX-License-Identifier: Apache-2.0
//
// The `context` string `POST /v1/context` returns for prompt injection (the
// SessionStart hook in server mode and the `observation_context` MCP tool both
// inject it verbatim). Each observation renders as
//
//   [memory:<id> · <YYYY-MM-DD of created_at, UTC>] <title>
//   <content, minus its first line when that line is the title>
//
// so an agent can cite the memory it acted on and see how old it is, and a
// caller can tell from the transcript which memories a run was given. Entries
// are separated by a blank line and keep the caller's order, under a single
// `# Project memory: …` header line.

export interface ContextBlockObservation {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAtEpoch: number;
}

function collapseToOneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

function firstNonEmptyLine(content: string): string {
  for (const line of content.split(/\r?\n/)) {
    if (line.trim().length > 0) return line.trim();
  }
  return '';
}

function utcDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export function formatContextEntry(observation: ContextBlockObservation): string {
  const metadataTitle = observation.metadata?.title;
  const title = typeof metadataTitle === 'string' && metadataTitle.trim().length > 0
    ? collapseToOneLine(metadataTitle)
    : collapseToOneLine(firstNonEmptyLine(observation.content));

  // Drop the content's first line only when it repeats the title, so the
  // header is not immediately followed by the same text.
  const lines = observation.content.split(/\r?\n/);
  const body = lines[0].trim() === title ? lines.slice(1).join('\n').replace(/^\s*\n/, '') : observation.content;

  const header = `[memory:${observation.id} · ${utcDate(observation.createdAtEpoch)}] ${title}`;
  return body.length > 0 ? `${header}\n${body}` : header;
}

// `newest-first` only when the caller really fetched in created_at DESC order
// (the query-less recency mode); a relevance-ranked result must not claim it.
export type ContextBlockOrder = 'newest-first' | 'ranked';

// The block opens with one header line naming it: a SessionStart hook's
// output reaches the SDK only as "SessionStart:startup", identical for every
// plugin, so this line is how a reader of the transcript tells claude-mem's
// injection apart. An empty result stays an empty string — nothing injected,
// nothing to identify.
export function formatContextBlock(
  observations: readonly ContextBlockObservation[],
  order: ContextBlockOrder,
): string {
  const entries = observations
    .filter(observation => typeof observation.content === 'string' && observation.content.length > 0)
    .map(formatContextEntry);
  if (entries.length === 0) return '';
  // Always "memories", even for one: the header is matched by callers, so its
  // shape does not vary with the count.
  const header = order === 'newest-first'
    ? `# Project memory: ${entries.length} memories, newest first`
    : `# Project memory: ${entries.length} memories`;
  return [header, ...entries].join('\n\n');
}
