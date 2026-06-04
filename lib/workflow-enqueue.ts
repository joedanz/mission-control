// ABOUTME: Lib-tier (NO spawn) entry to start a workflow run — validate the graph, enforce the single-flight
// ABOUTME: guard, and create the run row. enqueueWorkflowRun creates a 'queued' run for the workflow-daemon to
// ABOUTME: claim; it touches only lib/ (validateGraph + the store), so the Vercel web route and the CLI can
// ABOUTME: import it directly WITHOUT pulling in daemon/runner's child-process machinery (the web tier never
// ABOUTME: spawns — plan correction #2). The synchronous daemon runner reuses prepareWorkflowRun for the same
// ABOUTME: validate + guard before it walks in-process.

import { getWorkflowBySlug, countPendingWorkflowRuns, createWorkflowRun } from './workflow-store';
import { validateGraph } from './workflows';
import { NotFoundError, ConflictError } from './validation';
import type { Workflow, WorkflowRun, WorkflowTrigger } from './db/schema';

// `context` (slice 8) is the trigger payload (e.g. a webhook body) persisted onto workflow_runs.context; the
// walker exposes it to the graph as {{trigger.output.*}}. Manual/cron callers omit it (context stays null).
export type EnqueueOpts = { trigger?: WorkflowTrigger; allowConcurrent?: boolean; context?: unknown };

/** Look up + validate a workflow and enforce the single-flight guard (refuse a second run while one is queued
 *  OR running — so a not-yet-claimed queued run still blocks a duplicate). Shared by the synchronous runner
 *  and enqueueWorkflowRun. Throws NotFoundError / ValidationError / ConflictError. */
export async function prepareWorkflowRun(slug: string, opts: EnqueueOpts = {}): Promise<Workflow> {
  const wf = await getWorkflowBySlug(slug);
  if (!wf) throw new NotFoundError('workflow', slug, "run 'mc workflow list' to see slugs");
  validateGraph(wf.graph); // ValidationError on a malformed graph (single source of truth)
  if (!opts.allowConcurrent && (await countPendingWorkflowRuns(wf.id)) > 0) {
    throw new ConflictError('workflow', `workflow "${slug}" already has a run queued or in progress`);
  }
  return wf;
}

/** Enqueue a workflow run for the workflow-daemon to execute (the async / web Run-button / `mc workflow run
 *  --async` path). Validates + single-flight-guards, then creates a 'queued' run and returns it — NO spawn,
 *  so the web route imports + calls it directly (the daemon owns execution). */
export async function enqueueWorkflowRun(slug: string, opts: EnqueueOpts = {}): Promise<WorkflowRun> {
  const wf = await prepareWorkflowRun(slug, opts);
  return createWorkflowRun({ workflowId: wf.id, trigger: opts.trigger ?? 'manual', graphSnapshot: wf.graph, status: 'queued', context: opts.context });
}
