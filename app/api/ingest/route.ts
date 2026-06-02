// ABOUTME: Telemetry ingest for agent runs + events (Claude Code hooks POST here). Bearer-auth via
// ABOUTME: INGEST_TOKEN; writes go THROUGH lib/mutations (no inline Drizzle) so the single-writer holds.

import { withActor } from '@/lib/actor-context';
import * as mutations from '@/lib/mutations';
import * as queries from '@/lib/queries';
import { RUN_STATUSES, RUN_SOURCES, EVENT_TYPES, EVENT_LEVELS } from '@/lib/db/schema';
import type { RunStatus, RunSource, EventType, EventLevel } from '@/lib/db/schema';

export const runtime = 'nodejs'; // touches lib/db — never edge

// ── tiny typed coercion over an untrusted JSON body ─────────────────────────────
type Body = Record<string, unknown>;
const str = (b: Body, k: string): string | null => (typeof b[k] === 'string' ? (b[k] as string) : null);
const numOrU = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
function inEnum<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}
function metricsFrom(b: Body) {
  return {
    tokensIn: numOrU(b.tokensIn),
    tokensOut: numOrU(b.tokensOut),
    cacheReadTokens: numOrU(b.cacheReadTokens),
    cacheWriteTokens: numOrU(b.cacheWriteTokens),
    costMicros: numOrU(b.costMicros),
    model: str(b, 'model') ?? undefined,
  };
}
const json = (data: unknown, status = 200) => Response.json(data, { status });

export async function POST(request: Request): Promise<Response> {
  const token = process.env.INGEST_TOKEN;
  if (!token || request.headers.get('authorization') !== `Bearer ${token}`) {
    return json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'bad or missing bearer token' } }, 401);
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return json({ ok: false, error: { code: 'BAD_REQUEST', message: 'invalid JSON body' } }, 400);
  }

  const type = str(body, 'type');
  const agentLabel = str(body, 'agentLabel') ?? 'claude-code';

  try {
    switch (type) {
      case 'run.start': {
        // Auto-associate with a project from the hook's cwd (workDir) if no explicit projectId.
        let projectId = str(body, 'projectId');
        const workDir = str(body, 'workDir');
        if (!projectId && workDir) projectId = await queries.getProjectIdByRepoPath(workDir);
        const run = await withActor({ label: agentLabel, kind: 'agent' }, () =>
          mutations.recordRunStart({
            id: str(body, 'id') ?? undefined,
            agentLabel,
            parentRunId: str(body, 'parentRunId'),
            projectId,
            title: str(body, 'title'),
            source: inEnum<RunSource>(body.source, RUN_SOURCES, 'hook'),
            model: str(body, 'model'),
            sessionId: str(body, 'sessionId'),
            workDir,
            transcriptRef: str(body, 'transcriptRef'),
          }),
        );
        return json({ ok: true, data: run });
      }
      case 'run.heartbeat': {
        const id = str(body, 'id');
        if (!id) return json({ ok: false, error: { code: 'BAD_REQUEST', message: 'id required' } }, 400);
        const run = await mutations.recordRunHeartbeat(id, metricsFrom(body));
        return json({ ok: true, data: run });
      }
      case 'run.end': {
        const id = str(body, 'id');
        if (!id) return json({ ok: false, error: { code: 'BAD_REQUEST', message: 'id required' } }, 400);
        const status = inEnum<RunStatus>(body.status, RUN_STATUSES, 'completed');
        const run = await withActor({ label: agentLabel, kind: 'agent', runId: id }, () =>
          mutations.recordRunEnd(id, status, metricsFrom(body)),
        );
        return json({ ok: true, data: run });
      }
      case 'event': {
        const summary = str(body, 'summary');
        if (!summary) return json({ ok: false, error: { code: 'BAD_REQUEST', message: 'summary required' } }, 400);
        const runId = str(body, 'runId');
        const ev = await withActor({ label: agentLabel, kind: 'agent', runId }, () =>
          mutations.createEvent({
            type: inEnum<EventType>(body.eventType, EVENT_TYPES, 'note'),
            summary,
            level: inEnum<EventLevel>(body.level, EVENT_LEVELS, 'info'),
            projectId: str(body, 'projectId'),
            taskId: str(body, 'taskId'),
            runId,
            payload: body.payload ?? null,
            idempotencyKey: str(body, 'idempotencyKey'),
          }),
        );
        return json({ ok: true, data: ev });
      }
      default:
        return json({ ok: false, error: { code: 'BAD_REQUEST', message: `unknown type "${type}"` } }, 400);
    }
  } catch (err) {
    return json({ ok: false, error: { code: 'DB', message: err instanceof Error ? err.message : String(err) } }, 500);
  }
}
