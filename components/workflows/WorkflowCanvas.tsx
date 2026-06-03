'use client';

// ABOUTME: The read-only @xyflow/react surface. Maps a persisted WorkflowGraph + the polled per-node step
// ABOUTME: status into React Flow nodes/edges (status injected into node.data — ephemeral, never persisted),
// ABOUTME: then renders pan/zoom-only (no drag/connect/select — authoring is slice 9). An edge animates while
// ABOUTME: its target node is running, so the "flow" reads live during a run.

import { useMemo } from 'react';
import { ReactFlow, Background, Controls, type Node, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { WorkflowGraph, WorkflowStepStatus } from '@/lib/db/schema';
import { nodeTypes, type WfNodeData } from './WorkflowNodes';

type StepStatusMap = Record<string, WorkflowStepStatus>;

function toNodes(graph: WorkflowGraph, stepStatus: StepStatusMap): Node<WfNodeData>[] {
  return graph.nodes.map((n) => ({
    id: n.id,
    type: n.type, // matches a key in nodeTypes
    position: n.position,
    data: { ...(n.data as object), kind: n.type, stepStatus: stepStatus[n.id] } as WfNodeData,
  }));
}

function toEdges(graph: WorkflowGraph, stepStatus: StepStatusMap): Edge[] {
  return graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? undefined,
    targetHandle: e.targetHandle ?? undefined,
    label: e.label,
    animated: stepStatus[e.target] === 'running', // the live edge feeding the node that's running now
  }));
}

export function WorkflowCanvas({ graph, stepStatus }: { graph: WorkflowGraph; stepStatus: StepStatusMap }) {
  const nodes = useMemo(() => toNodes(graph, stepStatus), [graph, stepStatus]);
  const edges = useMemo(() => toEdges(graph, stepStatus), [graph, stepStatus]);

  return (
    <div className="wf-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: false }}
      >
        <Background gap={16} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
