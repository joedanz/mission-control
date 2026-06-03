'use client';

// ABOUTME: MC-themed @xyflow/react custom nodes for the read-only workflow canvas. One component per slice-1
// ABOUTME: node type (trigger, agent) + a generic fallback so future graphs (integration/branch/gate) still
// ABOUTME: render. Each is memo()'d and reads its live step status from node.data (ephemeral overlay, never
// ABOUTME: persisted). nodeTypes is a module-level const so React Flow doesn't re-instantiate it per render.

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { WorkflowNodeType, WorkflowStepStatus } from '@/lib/db/schema';

// node.data the canvas injects (graph data.* + the polled overlay). Kept loose — RF data is Record-typed.
export type WfNodeData = {
  kind: WorkflowNodeType;
  prompt?: string;
  profileSlug?: string;
  trigger?: string;
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

// integration / branch / gate aren't executed until later slices, but render so the whole graph is visible.
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

// Every persisted node.type maps to a renderer; the three not-yet-executed types share GenericNode.
export const nodeTypes = {
  trigger: TriggerNode,
  agent: AgentNode,
  integration: GenericNode,
  branch: GenericNode,
  gate: GenericNode,
} as const;
