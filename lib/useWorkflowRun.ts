// ABOUTME: Client poll hook for one workflow's detail (graph + recent runs + latest-run per-node step status).
// ABOUTME: Same 4s loop + out-of-order guard as useBoard; polls continuously (not just while a run is live) so a
// ABOUTME: run started elsewhere — e.g. `mc workflow run` in a terminal — appears without a manual refresh.

/* eslint-disable react-hooks/set-state-in-effect -- polling hook: every setState runs AFTER an awaited fetch,
   never synchronously during the effect's render phase. Same shape as useBoard/useActivityFeed; the rule's
   heuristic over-fires on the async callback. */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkflowDetail } from './workflow-view';

export function useWorkflowRun(
  opts: { projectSlug: string; workflowSlug: string | null; intervalMs?: number },
) {
  const { projectSlug, workflowSlug, intervalMs = 4000 } = opts;
  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    if (!workflowSlug) return;
    const seq = ++loadSeq.current;
    try {
      const res = await fetch(`/api/projects/${projectSlug}/workflows?workflow=${encodeURIComponent(workflowSlug)}`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        if (seq === loadSeq.current) setError(`HTTP ${res.status}`);
        return;
      }
      const json = await res.json();
      if (seq !== loadSeq.current) return; // a newer load superseded this one
      if (json.ok) {
        setDetail(json.data.workflow as WorkflowDetail);
        setError(null);
      }
    } catch (e) {
      if (seq === loadSeq.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === loadSeq.current) setLoaded(true);
    }
  }, [projectSlug, workflowSlug]);

  // Reset when the selected workflow changes so a stale graph never flashes under the new selection.
  useEffect(() => {
    setDetail(null);
    setLoaded(false);
    if (!workflowSlug) return;
    load();
    const t = setInterval(load, intervalMs);
    return () => clearInterval(t);
  }, [workflowSlug, load, intervalMs]);

  return { detail, loaded, error };
}
