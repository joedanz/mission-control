// ABOUTME: Framework-agnostic workflow view shapes + the row → client-DTO projections for the canvas tab.
// ABOUTME: Type-only schema imports (erased), so this is safe in the API route AND the client components —
// ABOUTME: one payload contract, Date→ISO at a single boundary. Pure (no DB), mirroring lib/board.ts.

import type {
  Workflow, WorkflowRun, WorkflowStepRun, WorkflowGraph,
  WorkflowStatus, WorkflowRunStatus, WorkflowTrigger, WorkflowStepStatus,
} from './db/schema';

export type WorkflowRunSummary = {
  id: string;
  status: WorkflowRunStatus;
  trigger: WorkflowTrigger;
  startedAt: string;
  endedAt: string | null;
};

export type WorkflowListItem = {
  slug: string;
  name: string;
  description: string | null;
  status: WorkflowStatus;
  nodeCount: number;
  latestRun: WorkflowRunSummary | null;
};

export type WorkflowDetail = {
  slug: string;
  name: string;
  description: string | null;
  status: WorkflowStatus;
  graph: WorkflowGraph;
  latestRun: WorkflowRunSummary | null;
  // node id → step status for the latest run — the canvas's live overlay.
  stepStatus: Record<string, WorkflowStepStatus>;
};

export function toRunSummary(r: WorkflowRun): WorkflowRunSummary {
  return {
    id: r.id,
    status: r.status as WorkflowRunStatus,
    trigger: r.trigger as WorkflowTrigger,
    startedAt: r.startedAt.toISOString(),
    endedAt: r.endedAt ? r.endedAt.toISOString() : null,
  };
}

export function toWorkflowListItem(wf: Workflow, latestRun: WorkflowRun | null): WorkflowListItem {
  return {
    slug: wf.slug,
    name: wf.name,
    description: wf.description,
    status: wf.status as WorkflowStatus,
    nodeCount: wf.graph.nodes.length,
    latestRun: latestRun ? toRunSummary(latestRun) : null,
  };
}

/** node id → step status. One row per node per run (the (run,node) unique key), so a flat map is exact. */
export function stepStatusByNode(steps: WorkflowStepRun[]): Record<string, WorkflowStepStatus> {
  const map: Record<string, WorkflowStepStatus> = {};
  for (const s of steps) map[s.nodeId] = s.status as WorkflowStepStatus;
  return map;
}

/** `runs` arrives newest-first (store orders by startedAt desc); latest = runs[0], whose steps drive the overlay. */
export function toWorkflowDetail(wf: Workflow, runs: WorkflowRun[], latestRunSteps: WorkflowStepRun[]): WorkflowDetail {
  return {
    slug: wf.slug,
    name: wf.name,
    description: wf.description,
    status: wf.status as WorkflowStatus,
    graph: wf.graph,
    latestRun: runs.length ? toRunSummary(runs[0]) : null,
    stepStatus: stepStatusByNode(latestRunSteps),
  };
}
