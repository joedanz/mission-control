'use client';

// ABOUTME: MC-themed @xyflow/react custom nodes for the read-only workflow canvas. One component per executable
// ABOUTME: node type (trigger, agent, integration) + a generic fallback so future graphs (branch/gate) still
// ABOUTME: render. Each is memo()'d and reads its live step status from node.data (ephemeral overlay, never
// ABOUTME: persisted). nodeTypes is a module-level const so React Flow doesn't re-instantiate it per render.

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { BranchCase, WorkflowNodeType, WorkflowStepStatus } from '@/lib/db/schema';

// node.data the canvas injects (graph data.* + the polled overlay). Kept loose — RF data is Record-typed.
export type WfNodeData = {
  kind: WorkflowNodeType;
  prompt?: string;
  profileSlug?: string;
  trigger?: string;
  toolkit?: string;
  action?: string;
  cases?: BranchCase[];
  message?: string;
  stepStatus?: WorkflowStepStatus;
};

const STEP_LABEL: Record<WorkflowStepStatus, string> = {
  pending: 'pending', running: 'running', completed: 'done', failed: 'failed', skipped: 'skipped',
};

function StepBadge({ status }: { status?: WorkflowStepStatus }) {
  if (!status) return null;
  return <span className={`wf-badge wf-badge--${status}`}>{STEP_LABEL[status]}</span>;
}

// A node's outer chrome — status drives the border/glow via wf-node--<status>.
function Shell({ data, kind, accent, children }: { data: WfNodeData; kind: string; accent: string; children: React.ReactNode }) {
  const status = data.stepStatus;
  return (
    <div className={`wf-node wf-node--${accent}${status ? ` wf-node--${status}` : ''}`}>
      <div className="wf-node__head">
        <span className="wf-node__kind">{kind}</span>
        <StepBadge status={status} />
      </div>
      {children}
    </div>
  );
}

const SOURCE = <Handle type="source" position={Position.Right} />;
const TARGET = <Handle type="target" position={Position.Left} />;

export const TriggerNode = memo(function TriggerNode({ data }: NodeProps) {
  const d = data as WfNodeData;
  return (
    <Shell data={d} kind="trigger" accent="trigger">
      <div className="wf-node__body wf-node__body--mono">{d.trigger ?? 'manual'}</div>
      {SOURCE}
    </Shell>
  );
});

export const AgentNode = memo(function AgentNode({ data }: NodeProps) {
  const d = data as WfNodeData;
  return (
    <Shell data={d} kind="agent" accent="agent">
      {TARGET}
      {d.prompt && <div className="wf-node__body">{firstLine(d.prompt)}</div>}
      {d.profileSlug && <div className="wf-node__meta">{d.profileSlug}</div>}
      {SOURCE}
    </Shell>
  );
});

export const IntegrationNode = memo(function IntegrationNode({ data }: NodeProps) {
  const d = data as WfNodeData;
  return (
    <Shell data={d} kind="integration" accent="integration">
      {TARGET}
      {d.toolkit && <div className="wf-node__body">{d.toolkit}</div>}
      {d.action && <div className="wf-node__meta wf-node__body--mono">{d.action}</div>}
      {SOURCE}
    </Shell>
  );
});

// A branch node (slice 6a) routes by case: one source handle per case name (+ the implicit 'else'). The
// handle ids match edge.sourceHandle, so the canvas wires each case's edge to its own port.
export const BranchNode = memo(function BranchNode({ data }: NodeProps) {
  const d = data as WfNodeData;
  const handles = [...(d.cases ?? []).map((c) => c.name), 'else'];
  return (
    <Shell data={d} kind="branch" accent="branch">
      {TARGET}
      {(d.cases ?? []).map((c) => (
        <div key={c.name} className="wf-node__meta wf-node__body--mono">{`${c.name}: ${condLabel(c)}`}</div>
      ))}
      {handles.map((name, i) => (
        <Handle key={name} id={name} type="source" position={Position.Right} style={{ top: `${handleTop(i, handles.length)}%` }} />
      ))}
    </Shell>
  );
});

// A gate node (slice 9a) pauses the run for a human. While the run is paused its step status is 'running' —
// shown here as "awaiting approval"; the WorkflowsTab renders the Approve/Reject buttons separately.
export const GateNode = memo(function GateNode({ data }: NodeProps) {
  const d = data as WfNodeData;
  return (
    <Shell data={d} kind="gate" accent="gate">
      {TARGET}
      {d.message && <div className="wf-node__body">{firstLine(d.message)}</div>}
      {d.stepStatus === 'running' && <div className="wf-node__meta wf-node__body--mono">awaiting approval</div>}
      {SOURCE}
    </Shell>
  );
});

// branch is routed above; any not-yet-rendered node type shares GenericNode.
export const GenericNode = memo(function GenericNode({ data }: NodeProps) {
  const d = data as WfNodeData;
  return (
    <Shell data={d} kind={d.kind} accent="generic">
      {TARGET}
      {SOURCE}
    </Shell>
  );
});

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0].trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

// A compact one-line label for a branch case's condition (e.g. "score gte 80", "label truthy").
function condLabel(c: BranchCase): string {
  const ref = (v: unknown) => (typeof v === 'string' ? v.replace(/\{\{\s*|\s*\}\}/g, '') : JSON.stringify(v));
  const { left, op, right } = c.when;
  return op === 'truthy' || op === 'falsy' ? `${ref(left)} ${op}` : `${ref(left)} ${op} ${ref(right)}`;
}

// Distribute N source handles down the node's right edge (avoids overlap when a branch has several cases).
const handleTop = (i: number, n: number): number => (n <= 1 ? 50 : 20 + (60 * i) / (n - 1));

// Every persisted node.type maps to a renderer.
export const nodeTypes = {
  trigger: TriggerNode,
  agent: AgentNode,
  integration: IntegrationNode,
  branch: BranchNode,
  gate: GateNode,
} as const;
