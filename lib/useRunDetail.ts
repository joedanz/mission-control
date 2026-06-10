// ABOUTME: Client polling hook for the run drill-in — fetches /api/runs/[id], the single data seam.
// ABOUTME: Polls every 4s WHILE the run is live; stops once terminal (a finished run never changes).

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FeedEvent } from './useActivityFeed';

// JSON-over-the-wire shape: Dates arrive as ISO strings (relativeTime() accepts string|Date).
export type RunDetailView = {
  id: string;
  agentLabel: string;
  status: string;
  title: string | null;
  source: string;
  model: string | null;
  live: boolean;
  cancelRequested: boolean;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costMicros: number;
  sessionId: string | null;
  workDir: string | null;
  startedAt: string;
  endedAt: string | null;
  lastHeartbeatAt: string;
  claimedTask: { id: string; label: string; projectId: string } | null;
  project: { slug: string; name: string } | null;
  events: FeedEvent[];
  eventsTruncated: boolean;
};

export function useRunDetail(id: string, intervalMs = 4000) {
  const [run, setRun] = useState<RunDetailView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Discard a superseded in-flight response: a slow fetch (cold DB / flaky net) can resolve AFTER a newer
  // poll and clobber fresher run state. Mirrors useWorkflowRun's loadSeq guard.
  const loadSeq = useRef(0);

  const stop = useCallback(() => {
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const res = await fetch(`/api/runs/${id}`, { cache: 'no-store' });
      if (seq !== loadSeq.current) return; // a newer load superseded this one
      if (res.status === 404) {
        setNotFound(true);
        stop(); // a missing run won't appear later
        return;
      }
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const json = await res.json();
      if (seq !== loadSeq.current) return; // superseded between fetch and json parse
      if (json.ok) {
        const next = json.data.run as RunDetailView;
        setRun(next);
        setError(null);
        // Stop only when the run reaches a terminal STATUS, not merely when `live` is false: a
        // still-`running` run whose heartbeat lapsed past the stale window reports live=false but can
        // resume, so we must keep polling. Only a non-running status is immutable.
        if (next.status !== 'running') stop();
      }
    } catch (e) {
      if (seq === loadSeq.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === loadSeq.current) setLoaded(true);
    }
  }, [id, stop]);

  useEffect(() => {
    // Initial fetch + interval. load() is async, so setState runs after the awaited fetch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    timer.current = setInterval(load, intervalMs);
    return stop;
  }, [load, intervalMs, stop]);

  return { run, loaded, notFound, error, reload: load };
}
