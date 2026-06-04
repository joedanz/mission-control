// ABOUTME: Slice-9b `mc workflow update` — the CLI twin of canvas authoring. Proves it replaces a workflow's
// ABOUTME: graph + bumps version, validates through the SAME validateGraph SSOT (a cyclic graph → exit 2), and
// ABOUTME: 404s an unknown slug. Real Neon (DATABASE_URL fallback); no spawn (update is a pure DB write).

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { inArray } from 'drizzle-orm';
import { db } from '../lib/db/index';
import { projects, type WorkflowGraph } from '../lib/db/schema';
import { createProject } from '../lib/mutations';
import { createWorkflow, getWorkflowBySlug } from '../lib/workflow-store';

const tsxBin = join(process.cwd(), 'node_modules', '.bin', 'tsx');
const tag = () => `wfu-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const projectIds: string[] = [];

afterEach(async () => {
  if (projectIds.length) await db.delete(projects).where(inArray(projects.id, projectIds)); // cascades workflows
  projectIds.length = 0;
});

type Envelope = { ok: boolean; data?: { version?: number; graph?: WorkflowGraph; slug?: string; name?: string }; error?: { code: string } };

function mcWorkflow(sub: string, args: string[]): { env: Envelope; status: number } {
  try {
    const out = execFileSync(tsxBin, ['cli/index.ts', 'workflow', sub, ...args, '--json'], {
      env: { ...process.env, MC_ALLOW_DATABASE_URL_FALLBACK: '1', INGEST_TOKEN: '' },
      encoding: 'utf8',
      timeout: 55000,
    });
    return { env: JSON.parse(out.trim()), status: 0 };
  } catch (e) {
    const err = e as { stdout?: string; status?: number };
    return { env: JSON.parse((err.stdout ?? '{}').trim()), status: err.status ?? 1 };
  }
}
const mcUpdate = (args: string[]) => mcWorkflow('update', args);
const mcCreate = (args: string[]) => mcWorkflow('create', args);

const seed = (): WorkflowGraph => ({
  nodes: [
    { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { trigger: 'manual' } },
    { id: 'a', type: 'agent', position: { x: 160, y: 0 }, data: { prompt: 'hi' } },
  ],
  edges: [{ id: 'e1', source: 't', target: 'a' }],
});

describe('mc workflow update', () => {
  it('replaces the graph + bumps version (validated through the SSOT)', async () => {
    const p = await createProject({ name: tag(), category: 'internal', status: 'prelaunch' });
    projectIds.push(p.id);
    const slug = tag();
    await createWorkflow({ projectId: p.id, slug, name: 'A', graph: seed() });

    const next: WorkflowGraph = {
      nodes: [{ id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { trigger: 'manual' } }],
      edges: [],
    };
    const { env, status } = mcUpdate([slug, '--graph', JSON.stringify(next), '--name', 'Renamed']);
    expect(status).toBe(0);
    expect(env.ok).toBe(true);
    expect(env.data?.version).toBe(2);
    expect(env.data?.graph?.nodes.length).toBe(1);
    expect((await getWorkflowBySlug(slug))?.name).toBe('Renamed');
  });

  it('rejects a cyclic graph with a VALIDATION error (exit 2) and does not persist', async () => {
    const p = await createProject({ name: tag(), category: 'internal', status: 'prelaunch' });
    projectIds.push(p.id);
    const slug = tag();
    await createWorkflow({ projectId: p.id, slug, name: 'A', graph: seed() });

    const cyclic: WorkflowGraph = {
      nodes: [
        { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { trigger: 'manual' } },
        { id: 'a', type: 'agent', position: { x: 160, y: 0 }, data: { prompt: 'hi' } },
        { id: 'b', type: 'agent', position: { x: 320, y: 0 }, data: { prompt: 'yo' } },
      ],
      edges: [{ id: 'e1', source: 't', target: 'a' }, { id: 'e2', source: 'a', target: 'b' }, { id: 'e3', source: 'b', target: 'a' }],
    };
    const { env, status } = mcUpdate([slug, '--graph', JSON.stringify(cyclic)]);
    expect(status).toBe(2);
    expect(env.error?.code).toBe('VALIDATION');
    expect((await getWorkflowBySlug(slug))?.version).toBe(1); // unchanged
  });

  it('accepts an empty graph as a valid draft (matching create)', async () => {
    const p = await createProject({ name: tag(), category: 'internal', status: 'prelaunch' });
    projectIds.push(p.id);
    const slug = tag();
    await createWorkflow({ projectId: p.id, slug, name: 'A', graph: seed() });
    const { env, status } = mcUpdate([slug, '--graph', JSON.stringify({ nodes: [], edges: [] })]);
    expect(status).toBe(0);
    expect(env.data?.graph?.nodes.length).toBe(0);
  });

  it('404s an unknown slug', () => {
    const { env, status } = mcUpdate(['nope-' + tag(), '--name', 'X']);
    expect(status).toBe(3);
    expect(env.error?.code).toBe('NOT_FOUND');
  });
});

// `mc workflow create` now routes through the shared createDraftWorkflow SSOT (slice 9c), so a duplicate slug
// is a clean CONFLICT (not a raw DB error) — the same path the canvas "New workflow" button uses.
describe('mc workflow create (shared SSOT)', () => {
  it('creates an empty draft and CONFLICTs on a duplicate slug', async () => {
    const p = await createProject({ name: tag(), category: 'internal', status: 'prelaunch' });
    projectIds.push(p.id);
    const slug = tag();
    const first = mcCreate(['--project', p.slug, '--name', 'Triage', '--slug', slug]);
    expect(first.status).toBe(0);
    expect(first.env.data?.slug).toBe(slug);
    expect((await getWorkflowBySlug(slug))?.graph.nodes.length).toBe(0); // empty draft

    const dup = mcCreate(['--project', p.slug, '--name', 'Triage again', '--slug', slug]);
    expect(dup.status).toBe(1); // CONFLICT exit code
    expect(dup.env.error?.code).toBe('CONFLICT');
  });
});
