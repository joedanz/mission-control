// ABOUTME: Client polling hook for the Mission tab — the single data seam. Phase 1 polls /api/activity;
// ABOUTME: Phase 3 swaps the body for an SSE subscription with NO change to consuming components.

import { useCallback, useEffect, useRef, useState } from 'react';

// JSON-over-the-wire shapes: Dates arrive as ISO strings (relativeTime() accepts string|Date).
export type FeedEvent = {
  id: string;
  seq: number;
  type: string;
  level: string;
  summary: string;
  actorLabel: string;
  runId: string | null;
  projectId: string | null;
  createdAt: string;
};

export type FeedRun = {
  id: string;
  agentLabel: string;
  status: string;
  title: string | null;
  live: boolean;
  lastHeartbeatAt: string;
  tokensIn: number;
  tokensOut: number;
  costMicros: number;
  // The task this run is currently working (null once the run ends — the claim is released/completed).
  claimedTask: { id: string; label: string; projectId: string } | null;
};

type Feed = { events: FeedEvent[]; runs: FeedRun[] };

export function useActivityFeed(opts: { projectId?: string; intervalMs?: number } = {}) {
  const { projectId, intervalMs = 4000 } = opts;
  const [data, setData] = useState<Feed>({ events: [], runs: [] });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Discard a superseded in-flight response: when a fetch is slower than the 4s interval (cold serverless DB,
  // flaky net), an OLDER response can resolve AFTER a newer one and clobber fresher data. Mirrors useWorkflowRun.
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const qs = new URLSearchParams();
      if (projectId) qs.set('projectId', projectId);
      const res = await fetch(`/api/activity?${qs.toString()}`, { cache: 'no-store' });
      if (!res.ok) {
        if (seq === loadSeq.current) setError(`HTTP ${res.status}`);
        return;
      }
      const json = await res.json();
      if (seq !== loadSeq.current) return; // a newer load superseded this one
      if (json.ok) {
        setData(json.data as Feed);
        setError(null);
      }
    } catch (e) {
      if (seq === loadSeq.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === loadSeq.current) setLoaded(true);
    }
  }, [projectId]);

  useEffect(() => {
    // Subscribe to the polling source: initial fetch + interval. load() is async, so its setState
    // runs after the awaited fetch (not synchronously) — the rule's heuristic misfires here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    const t = setInterval(load, intervalMs);
    return () => clearInterval(t);
  }, [load, intervalMs]);

  return { events: data.events, runs: data.runs, loaded, error, reload: load };
}
