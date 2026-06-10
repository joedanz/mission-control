// ABOUTME: Integration tests for POST /api/workflows/[slug]/webhook (slice 8 event trigger). Drives the real
// ABOUTME: route handler with a signed Request and asserts DB effects against real Neon. Covers the HMAC gate
// ABOUTME: (incl. the security property: a bad signature writes NOTHING), the event-type allowlist, the active
// ABOUTME: gate, single-flight suppression, and the happy path (a 'event'-trigger queued run carrying the payload
// ABOUTME: in context). Self-cleaning (throwaway project per test cascades its workflows → runs).

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { inArray } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import { POST } from '../app/api/workflows/[slug]/webhook/route';
import { deriveWorkflowWebhookSecret } from '../lib/webhook-signature';
import { db } from '../lib/db/index';
import { projects, type WorkflowGraph } from '../lib/db/schema';
import { createProject } from '../lib/mutations';
import { createWorkflow, setWorkflowStatus, listWorkflowRuns } from '../lib/workflow-store';

const SECRET = 'vitest-webhook-secret';
const ENDPOINT = (slug: string) => `http://localhost/api/workflows/${slug}/webhook`;

beforeAll(() => {
  process.env.WORKFLOW_WEBHOOK_SECRET = SECRET; // the route reads this per-request
});

const projectIds: string[] = [];
const tag = () => `wh-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

afterEach(async () => {
  if (projectIds.length) await db.delete(projects).where(inArray(projects.id, projectIds)); // cascades workflows → runs
  projectIds.length = 0;
});

async function freshProject() {
  const p = await createProject({ name: tag(), category: 'internal', status: 'prelaunch' });
  projectIds.push(p.id);
  return p;
}

// A minimal valid event-triggered graph. The prompt is static — this suite tests the HTTP gate + DB effects;
// the daemon suite proves {{trigger.output.*}} payload passing (with the matching node id).
const eventGraph = (types?: string[]): WorkflowGraph => ({
  nodes: [
    { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { event: types ? { source: 'github', types } : {} } },
    { id: 'a', type: 'agent', position: { x: 160, y: 0 }, data: { prompt: 'triage the incoming issue' } },
  ],
  edges: [{ id: 'e1', source: 't', target: 'a' }],
});

/** Seed an ACTIVE event-triggered workflow and return it. */
async function activeEventWorkflow(types?: string[]) {
  const p = await freshProject();
  const slug = tag();
  const wf = await createWorkflow({ projectId: p.id, slug, name: slug, graph: eventGraph(types) });
  await setWorkflowStatus(slug, 'active');
  return wf;
}

type HookOpts = { secret?: string | null; headers?: Record<string, string>; rawBody?: string };
/** POST a JSON payload to the real webhook handler. Signs with the slug's PER-WORKFLOW secret by default (M7);
 *  `secret:null` omits the header, `secret:'x'` signs with the wrong key. `rawBody` sends bytes verbatim. */
async function hook(slug: string, payload: unknown, opts: HookOpts = {}) {
  const raw = opts.rawBody ?? JSON.stringify(payload);
  const headers: Record<string, string> = { 'content-type': 'application/json', ...opts.headers };
  if (opts.secret !== null) {
    const s = opts.secret ?? deriveWorkflowWebhookSecret(SECRET, slug); // default = the correct per-workflow key
    headers['x-hub-signature-256'] = `sha256=${createHmac('sha256', s).update(raw).digest('hex')}`;
  }
  const req = new Request(ENDPOINT(slug), { method: 'POST', headers, body: raw });
  const res = await POST(req, { params: Promise.resolve({ slug }) });
  return { status: res.status, json: (await res.json()) as { ok: boolean; data?: { fired?: boolean; status?: string; workflowRunId?: string }; error?: { code: string } } };
}

describe('POST /api/workflows/[slug]/webhook (slice 8 event trigger)', () => {
  it('a valid signature + matching event type enqueues a queued event run carrying the payload', async () => {
    const wf = await activeEventWorkflow(['issues']);
    const r = await hook(wf.slug, { action: 'opened', issue: { number: 7 } }, { headers: { 'x-github-event': 'issues' } });

    expect(r.status).toBe(200);
    expect(r.json.data?.fired).toBe(true);
    const runs = await listWorkflowRuns({ workflowId: wf.id });
    expect(runs.length).toBe(1);
    expect(runs[0].trigger).toBe('event');
    expect(runs[0].status).toBe('queued');
    expect(runs[0].context).toEqual({ action: 'opened', issue: { number: 7 } }); // payload → workflow_runs.context
  });

  it('a bad signature is rejected 401 and writes NOTHING (the security property)', async () => {
    const wf = await activeEventWorkflow();
    const r = await hook(wf.slug, { action: 'opened' }, { secret: 'wrong-secret' });

    expect(r.status).toBe(401);
    expect(r.json.error?.code).toBe('UNAUTHORIZED');
    expect((await listWorkflowRuns({ workflowId: wf.id })).length).toBe(0);
  });

  it('a delivery signed for one workflow cannot be re-aimed at another (M7 — per-workflow secret)', async () => {
    const [wfA, wfB] = [await activeEventWorkflow(), await activeEventWorkflow()];
    const payload = { action: 'opened' };
    const raw = JSON.stringify(payload);
    // Sign with workflow A's per-workflow secret, then POST to workflow B's endpoint.
    const sigForA = `sha256=${createHmac('sha256', deriveWorkflowWebhookSecret(SECRET, wfA.slug)).update(raw).digest('hex')}`;
    const req = new Request(ENDPOINT(wfB.slug), { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sigForA }, body: raw });
    const res = await POST(req, { params: Promise.resolve({ slug: wfB.slug }) });

    expect(res.status).toBe(401); // B verifies against ITS own derived secret → the A-signature fails
    expect((await listWorkflowRuns({ workflowId: wfB.id })).length).toBe(0);
  });

  it('matches the event type via the x-event-type fallback header (not just x-github-event)', async () => {
    const wf = await activeEventWorkflow(['deploy']);
    const r = await hook(wf.slug, { ref: 'main' }, { headers: { 'x-event-type': 'deploy' } });

    expect(r.status).toBe(200);
    expect(r.json.data?.fired).toBe(true);
    expect((await listWorkflowRuns({ workflowId: wf.id })).length).toBe(1);
  });

  it('a non-matching event type is ignored (200 fired:false) with no run', async () => {
    const wf = await activeEventWorkflow(['issues']);
    const r = await hook(wf.slug, { ref: 'main' }, { headers: { 'x-github-event': 'push' } });

    expect(r.status).toBe(200);
    expect(r.json.data?.fired).toBe(false);
    expect((await listWorkflowRuns({ workflowId: wf.id })).length).toBe(0);
  });

  it('a non-active workflow is ignored (200 fired:false) with no run', async () => {
    const p = await freshProject();
    const slug = tag();
    const wf = await createWorkflow({ projectId: p.id, slug, name: slug, graph: eventGraph() }); // stays draft
    const r = await hook(slug, { action: 'opened' });

    expect(r.status).toBe(200);
    expect(r.json.data?.fired).toBe(false);
    expect((await listWorkflowRuns({ workflowId: wf.id })).length).toBe(0);
  });

  it('an unknown slug is a 404', async () => {
    const r = await hook('no-such-workflow-' + tag(), { action: 'opened' });
    expect(r.status).toBe(404);
    expect(r.json.error?.code).toBe('NOT_FOUND');
  });

  it('single-flight: a second webhook while one run is queued is ignored (still one run)', async () => {
    const wf = await activeEventWorkflow();
    const first = await hook(wf.slug, { action: 'opened' });
    expect(first.json.data?.fired).toBe(true);

    const second = await hook(wf.slug, { action: 'edited' });
    expect(second.status).toBe(200);
    expect(second.json.data?.fired).toBe(false); // suppressed, not retried
    expect((await listWorkflowRuns({ workflowId: wf.id })).length).toBe(1);
  });
});
