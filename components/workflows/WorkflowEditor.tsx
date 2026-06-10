'use client';

// ABOUTME: The EDITABLE @xyflow/react surface (slice 9b canvas authoring). Drag node types from the palette
// ABOUTME: onto the pane, drag between handles to connect (isValidConnection = the canConnect SSOT, so a cycle /
// ABOUTME: self-loop / edge-into-a-trigger can't be drawn), edit the selected node in the inspector (typed common
// ABOUTME: fields + a data-JSON escape hatch), Backspace to delete, then Save → POST {action:'save'} (validated by
// ABOUTME: the SAME validateGraph the CLI/runner use). Reuses the read-only nodeTypes so nodes look identical.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, Controls,
  useNodesState, useEdgesState, addEdge, useReactFlow,
  type Node, type Edge, type Connection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { WorkflowGraph, WorkflowNode, WorkflowNodeType } from '@/lib/db/schema';
import { canConnect } from '@/lib/workflows';
import { nodeTypes, type WfNodeData } from './WorkflowNodes';

const PALETTE: { type: WorkflowNodeType; label: string }[] = [
  { type: 'trigger', label: 'Trigger' },
  { type: 'agent', label: 'Agent' },
  { type: 'integration', label: 'Integration' },
  { type: 'branch', label: 'Branch' },
  { type: 'gate', label: 'Gate' },
];

// Sensible starting data for a freshly-dropped node (validated on Save; the JSON hatch fills the rest).
const DEFAULT_DATA: Record<WorkflowNodeType, Record<string, unknown>> = {
  trigger: { trigger: 'manual' },
  agent: { prompt: '' },
  integration: { toolkit: '', action: '' },
  branch: { cases: [] },
  gate: {},
};

const DND_TYPE = 'application/wf-node';
const DELETE_KEYS = ['Backspace', 'Delete'];
const FIT_VIEW_OPTIONS = { padding: 0.2 };
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const shortId = (): string => crypto.randomUUID().slice(0, 8);

// node.data carries an injected `kind` (for the renderers) + a transient `stepStatus` overlay — neither is
// persisted, so strip both before saving / showing the JSON.
function dataNoKind(data: WfNodeData): Record<string, unknown> {
  const rest = { ...(data as Record<string, unknown>) };
  delete rest.kind;
  delete rest.stepStatus;
  return rest;
}

function toRfNode(n: WorkflowNode): Node<WfNodeData> {
  return { id: n.id, type: n.type, position: n.position, data: { ...(n.data as object), kind: n.type } as WfNodeData };
}

function toGraph(nodes: Node<WfNodeData>[], edges: Edge[]): WorkflowGraph {
  return {
    nodes: nodes.map((n) => ({ id: n.id, type: (n.type ?? 'agent') as WorkflowNodeType, position: n.position, data: dataNoKind(n.data) })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
      ...(typeof e.label === 'string' ? { label: e.label } : {}),
    })),
  };
}

type EditorProps = {
  projectSlug: string;
  workflowSlug: string;
  graph: WorkflowGraph;
  onSaved: () => void;
  onCancel: () => void;
};

function EditorInner({ projectSlug, workflowSlug, graph, onSaved, onCancel }: EditorProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<WfNodeData>>(graph.nodes.map(toRfNode));
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(
    graph.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? undefined, label: e.label })),
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The data-JSON escape hatch holds raw text while it's being edited (so invalid JSON doesn't clobber data).
  // Always belongs to the current selection — cleared whenever the selection changes or a typed field is edited.
  const [draft, setDraft] = useState<{ text: string; error: string | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const { screenToFlowPosition } = useReactFlow();

  const selected = nodes.find((n) => n.id === selectedId) ?? null;
  // The persistable graph — rebuilt only when nodes/edges change, not per drag-validation tick.
  const graphSnapshot = useMemo(() => toGraph(nodes, edges), [nodes, edges]);

  const select = useCallback((id: string | null) => { setSelectedId(id); setDraft(null); }, []);

  // Reconcile branch edges: when a branch node's `cases` change (rename/remove via the JSON inspector), edges
  // wired to a now-gone case handle become invisible on the canvas (no matching port) but persist in `edges`,
  // silently breaking routing and failing the save (validateGraph rejects a stale-handle edge). Prune them so
  // the editable graph stays self-consistent. Returns the same array reference when nothing changed (no loop).
  useEffect(() => {
    setEdges((eds) => {
      let changed = false;
      const next = eds.filter((e) => {
        const src = nodes.find((n) => n.id === e.source);
        if (src?.type !== 'branch') return true;
        const valid = new Set<string>(['else', ...(((src.data as { cases?: { name: string }[] }).cases ?? []).map((c) => c.name))]);
        const handle = e.sourceHandle ?? (typeof e.label === 'string' ? e.label : '') ?? '';
        if (!valid.has(handle)) { changed = true; return false; }
        return true;
      });
      return changed ? next : eds;
    });
  }, [nodes, setEdges]);

  // Merge a partial patch into a node's data (typed fields), or replace it wholesale (the JSON hatch).
  const patchData = useCallback((id: string, value: Record<string, unknown>, replace: boolean) => {
    setNodes((nds) => nds.map((n) => {
      if (n.id !== id) return n;
      const next = replace ? { ...value, kind: n.type } : { ...n.data, ...value };
      return { ...n, data: next as WfNodeData };
    }));
  }, [setNodes]);

  // A typed-field edit merges into data + clears the JSON draft so the textarea re-renders from the new data.
  const onField = useCallback((key: string, value: unknown) => {
    if (!selectedId) return;
    patchData(selectedId, { [key]: value }, false);
    setDraft(null);
  }, [selectedId, patchData]);

  const onConnect = useCallback((c: Connection) => {
    setEdges((eds) => addEdge({ ...c, id: `e-${c.source}-${c.target}-${shortId()}` }, eds));
  }, [setEdges]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const type = e.dataTransfer.getData(DND_TYPE) as WorkflowNodeType;
    if (!type) return;
    const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const id = shortId();
    setNodes((nds) => [...nds, { id, type, position, data: { ...DEFAULT_DATA[type], kind: type } as WfNodeData }]);
  }, [screenToFlowPosition, setNodes]);

  const onSave = useCallback(async () => {
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/projects/${projectSlug}/workflows`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'save', workflow: workflowSlug, graph: graphSnapshot }),
      });
      const json = await res.json();
      if (res.ok && json.ok) onSaved();
      else setMsg(json.message ?? json.error ?? `failed (HTTP ${res.status})`); // 422 surfaces the validateGraph message
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [projectSlug, workflowSlug, graphSnapshot, onSaved]);

  const jsonValue = selected ? (draft ? draft.text : JSON.stringify(dataNoKind(selected.data), null, 2)) : '';

  return (
    <div className="wf-editor">
      <div className="wf-palette" role="toolbar" aria-label="Add node">
        <span className="wf-palette__label">drag to add:</span>
        {PALETTE.map((p) => (
          <div
            key={p.type}
            className={`wf-palette__chip wf-node--${p.type}`}
            draggable
            onDragStart={(e) => { e.dataTransfer.setData(DND_TYPE, p.type); e.dataTransfer.effectAllowed = 'move'; }}
          >
            {p.label}
          </div>
        ))}
        <div className="wf-editor__actions">
          {msg && <span className="wf-run-msg detail-muted">{msg}</span>}
          <button type="button" className="btn-sm" disabled={saving} onClick={onCancel}>Cancel</button>
          <button type="button" className="btn-sm btn-sm--primary" disabled={saving} onClick={onSave}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      <div className="wf-editor__body">
        <div
          className="wf-canvas wf-canvas--edit"
          onDrop={onDrop}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={(c) => canConnect(graphSnapshot, c.source, c.target)}
            onNodeClick={(_, n) => select(n.id)}
            onPaneClick={() => select(null)}
            onNodesDelete={(deleted) => { if (deleted.some((n) => n.id === selectedId)) select(null); }}
            deleteKeyCode={DELETE_KEYS}
            fitView
            fitViewOptions={FIT_VIEW_OPTIONS}
          >
            <Background gap={16} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>

        <aside className="wf-inspector" aria-label="Node inspector">
          {!selected && <p className="wf-inspector__hint">Select a node to edit, or drag one from the palette. Backspace deletes the selected node/edge.</p>}
          {selected && (
            <>
              <div className="wf-inspector__title">{selected.type} · <code>{selected.id}</code></div>

              {selected.type === 'agent' && (
                <>
                  <label className="wf-inspector__field">prompt
                    <textarea rows={4} value={str(selected.data.prompt)} onChange={(e) => onField('prompt', e.target.value)} />
                  </label>
                  <label className="wf-inspector__field">profile
                    <input type="text" value={str(selected.data.profileSlug)} onChange={(e) => onField('profileSlug', e.target.value || undefined)} />
                  </label>
                  <OnErrorField data={selected.data} onChange={(v) => onField('onError', v)} />
                </>
              )}

              {selected.type === 'gate' && (
                <>
                  <label className="wf-inspector__field">message
                    <input type="text" value={str(selected.data.message)} onChange={(e) => onField('message', e.target.value || undefined)} />
                  </label>
                  <OnErrorField data={selected.data} onChange={(v) => onField('onError', v)} />
                </>
              )}

              {selected.type === 'integration' && (
                <>
                  <label className="wf-inspector__field">toolkit
                    <input type="text" value={str(selected.data.toolkit)} onChange={(e) => onField('toolkit', e.target.value)} />
                  </label>
                  <label className="wf-inspector__field">action
                    <input type="text" value={str(selected.data.action)} onChange={(e) => onField('action', e.target.value)} />
                  </label>
                  <OnErrorField data={selected.data} onChange={(v) => onField('onError', v)} />
                </>
              )}

              {selected.type === 'trigger' && <p className="wf-inspector__hint">manual trigger — set a <code>schedule</code> or <code>event</code> in the JSON below.</p>}
              {selected.type === 'branch' && <p className="wf-inspector__hint">edit the ordered <code>cases</code> in the JSON below.</p>}

              <label className="wf-inspector__field">data (JSON)
                <textarea
                  className={`wf-inspector__json${draft?.error ? ' wf-inspector__json--err' : ''}`}
                  rows={7}
                  value={jsonValue}
                  onChange={(e) => {
                    const text = e.target.value;
                    try {
                      const parsed = JSON.parse(text);
                      setDraft({ text, error: null });
                      patchData(selected.id, parsed as Record<string, unknown>, true);
                    } catch {
                      setDraft({ text, error: 'invalid JSON' });
                    }
                  }}
                />
              </label>
              {draft?.error && <span className="wf-inspector__err">{draft.error}</span>}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

function OnErrorField({ data, onChange }: { data: WfNodeData; onChange: (v: string) => void }) {
  const value = str((data as Record<string, unknown>).onError) || 'halt';
  return (
    <label className="wf-inspector__field">onError
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="halt">halt</option>
        <option value="continue">continue</option>
      </select>
    </label>
  );
}

export function WorkflowEditor(props: EditorProps) {
  return (
    <ReactFlowProvider>
      <EditorInner {...props} />
    </ReactFlowProvider>
  );
}
