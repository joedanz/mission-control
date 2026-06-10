// ABOUTME: External event/webhook trigger (slice 8). A public POST that an outside system (GitHub, Slack, CI)
// ABOUTME: calls to fire a workflow. Auth is an HMAC over the RAW body (WORKFLOW_WEBHOOK_SECRET, GitHub
// ABOUTME: X-Hub-Signature-256 compatible) — NOT a session, so this route is intentionally un-gated. On a valid
// ABOUTME: signature it ENQUEUES a 'event'-trigger run (the web tier never spawns — the workflow-daemon walks it,
// ABOUTME: plan correction #2); the payload lands in workflow_runs.context → {{trigger.output.*}} in the graph.
// ABOUTME: Deliberate non-fires (inactive / not an event trigger / filtered-out / single-flight) return 200
// ABOUTME: {fired:false} so the sender doesn't retry; only real faults (bad sig / bad JSON / unknown slug) 4xx.

import { getWorkflowBySlug } from '@/lib/workflow-store';
import { triggerEvent } from '@/lib/workflows';
import { enqueueWorkflowRun } from '@/lib/workflow-enqueue';
import { verifyWebhookSignature, deriveWorkflowWebhookSecret } from '@/lib/webhook-signature';
import { ConflictError, ValidationError } from '@/lib/validation';

export const runtime = 'nodejs'; // node:crypto + lib/db — never edge
export const dynamic = 'force-dynamic';

const json = (data: unknown, status = 200) => Response.json(data, { status });
// A deliberate no-op (the request authenticated but the workflow chose not to fire) — 200 so GitHub et al.
// don't retry, but `fired:false` + a reason makes it observable.
const ignored = (reason: string) => json({ ok: true, data: { fired: false, reason } });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const secret = process.env.WORKFLOW_WEBHOOK_SECRET;
  if (!secret) {
    return json({ ok: false, error: { code: 'NOT_CONFIGURED', message: 'WORKFLOW_WEBHOOK_SECRET is not set' } }, 503);
  }

  const { slug } = await params;
  // The RAW body — HMAC must see the exact bytes the sender signed (a parse + re-serialize would change them).
  const raw = await request.text();
  // Verify against the PER-WORKFLOW secret (derived from the slug) so a signed delivery can't be re-aimed at a
  // different workflow by swapping the URL slug (M7). The slug is part of the key, not the signed message.
  const perWorkflowSecret = deriveWorkflowWebhookSecret(secret, slug);
  if (!verifyWebhookSignature(raw, request.headers.get('x-hub-signature-256'), perWorkflowSecret)) {
    return json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'bad or missing webhook signature' } }, 401);
  }

  let payload: unknown;
  try {
    payload = raw === '' ? {} : JSON.parse(raw);
  } catch {
    return json({ ok: false, error: { code: 'BAD_REQUEST', message: 'invalid JSON body' } }, 400);
  }

  const wf = await getWorkflowBySlug(slug);
  if (!wf) return json({ ok: false, error: { code: 'NOT_FOUND', message: `no workflow "${slug}"` } }, 404);

  if (wf.status !== 'active') return ignored('workflow not active'); // same activation gate as cron
  let event;
  try {
    event = triggerEvent(wf.graph);
  } catch {
    return ignored('workflow graph is invalid'); // a broken graph can't fire — don't 500 an external caller
  }
  if (!event) return ignored('not an event-triggered workflow');

  // Optional event-type allowlist (slice 8): X-GitHub-Event, falling back to a generic X-Event-Type header.
  if (event.types && event.types.length > 0) {
    const eventType = request.headers.get('x-github-event') ?? request.headers.get('x-event-type');
    if (!eventType || !event.types.includes(eventType)) {
      return ignored(`event type "${eventType ?? ''}" not in the allowlist`);
    }
  }

  try {
    const run = await enqueueWorkflowRun(slug, { trigger: 'event', context: payload });
    return json({ ok: true, data: { workflowRunId: run.id, status: run.status, fired: true } });
  } catch (e) {
    if (e instanceof ConflictError) return ignored('a run is already queued or in progress'); // single-flight
    if (e instanceof ValidationError) return ignored('workflow graph is invalid');
    return json({ ok: false, error: { code: 'DB', message: e instanceof Error ? e.message : String(e) } }, 500);
  }
}
