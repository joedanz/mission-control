// ABOUTME: Client poll hook for the Kanban board. Mirrors useActivityFeed's 4s loop, but reconciles the
// ABOUTME: server payload against in-flight optimistic moves (merge-by-version + settle timeout) instead
// ABOUTME: of wholesale-replacing state — so a drag isn't clobbered by the next poll before the write lands.

/* eslint-disable react-hooks/set-state-in-effect -- polling hook: every setState runs AFTER an awaited
   fetch (in load/merge) or from an explicit user action (applyMove), never synchronously during the
   effect's render phase. Same shape as useActivityFeed; the rule's heuristic over-fires on the callbacks. */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BoardData, BoardTask } from './board';

type Pending = { version: number; settledUntil: number };

function findTask(data: BoardData, id: string): BoardTask | undefined {
  for (const p of data.projects) {
    const t = p.tasks.find((x) => x.id === id);
    if (t) return t;
  }
  return undefined;
}

export function useBoard(
  opts: { projectSlug?: string; intervalMs?: number; initial?: BoardData } = {},
) {
  const { projectSlug, intervalMs = 4000, initial } = opts;
  const [data, setData] = useState<BoardData>(initial ?? { projects: [], runs: [] });
  const [loaded, setLoaded] = useState(!!initial);
  const [error, setError] = useState<string | null>(null);

  // Tasks moved locally but not yet confirmed by the server. Keyed by task id.
  const pendingRef = useRef<Map<string, Pending>>(new Map());
  // Latest data, so the merge can read current local rows without re-subscribing the poll effect.
  // Synced in an effect (never during render) and read only from callbacks.
  const dataRef = useRef(data);
  useEffect(() => {
    dataRef.current = data;
  }, [data]);
  // Discard a superseded in-flight response: a board fetch slower than the 4s interval (cold DB / flaky net)
  // could otherwise resolve AFTER a newer one and merge stale rows. Mirrors useWorkflowRun's loadSeq guard.
  const loadSeq = useRef(0);

  const merge = useCallback((server: BoardData) => {
    const pending = pendingRef.current;
    if (pending.size === 0) {
      // Preserve per-project object identity when a lane is unchanged, so OverallBoard's per-lane memo actually
      // hits. The payload is freshly JSON-parsed each poll, so a blind setData(server) hands every lane a new
      // identity and re-renders + re-sorts the WHOLE board every 4s even when nothing changed.
      setData((cur) => {
        const prev = new Map(cur.projects.map((p) => [p.slug, p]));
        const projects = server.projects.map((p) => {
          const before = prev.get(p.slug);
          return before && JSON.stringify(before) === JSON.stringify(p) ? before : p;
        });
        return { projects, runs: server.runs };
      });
      return;
    }
    const now = Date.now();
    const localById = new Map<string, BoardTask>();
    for (const p of dataRef.current.projects) for (const t of p.tasks) localById.set(t.id, t);

    const projects = server.projects.map((p) => ({
      ...p,
      tasks: p.tasks.map((t) => {
        const pend = pending.get(t.id);
        if (!pend) return t;
        if (t.version >= pend.version) {
          pending.delete(t.id); // server caught up — accept it
          return t;
        }
        if (now < pend.settledUntil) return localById.get(t.id) ?? t; // hold the optimistic row
        pending.delete(t.id); // settle window elapsed (write likely conflicted) — accept server
        return t;
      }),
    }));
    setData({ projects, runs: server.runs });
  }, []);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const qs = new URLSearchParams();
      if (projectSlug) qs.set('project', projectSlug);
      const res = await fetch(`/api/board?${qs.toString()}`, { cache: 'no-store' });
      if (!res.ok) {
        if (seq === loadSeq.current) setError(`HTTP ${res.status}`);
        return;
      }
      const json = await res.json();
      if (seq !== loadSeq.current) return; // a newer load superseded this one — don't merge stale rows
      if (json.ok) {
        merge(json.data as BoardData);
        setError(null);
      }
    } catch (e) {
      if (seq === loadSeq.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === loadSeq.current) setLoaded(true);
    }
  }, [projectSlug, merge]);

  useEffect(() => {
    load();
    const t = setInterval(load, intervalMs);
    return () => clearInterval(t);
  }, [load, intervalMs]);

  /** Apply a drag optimistically: set the moved task's status (if changed) and reindex `orderedIds`,
   *  then mark the moved task pending so the next poll won't snap it back before the write lands. */
  const applyMove = useCallback(
    (movedId: string, toStatus: string | undefined, orderedIds: string[]) => {
      const prior = findTask(dataRef.current, movedId);
      setData((cur) => ({
        ...cur,
        projects: cur.projects.map((p) => ({
          ...p,
          tasks: p.tasks.map((t) => {
            let next = t;
            if (t.id === movedId && toStatus && toStatus !== t.status) {
              // Mirror moveTask: a card entering Done needs a completedAt so it sorts INTO the (capped) Done
              // window instead of vanishing for a poll cycle (null sorts last → sliced out, or filtered by a
              // today/7d window). Leaving Done clears it. (M16)
              next = { ...next, status: toStatus, completedAt: toStatus === 'done' ? new Date().toISOString() : null };
            }
            const idx = orderedIds.indexOf(t.id);
            if (idx >= 0) next = { ...next, sortOrder: idx };
            return next;
          }),
        })),
      }));
      // Hold optimism until the server bumps version (status change) OR the settle window elapses (a pure
      // reorder doesn't bump version, so it always settles by timeout — by which point the reindex landed).
      pendingRef.current.set(movedId, {
        version: (prior?.version ?? 0) + 1,
        settledUntil: Date.now() + intervalMs * 2,
      });
    },
    [intervalMs],
  );

  // Drop a task's pending hold so the NEXT merge accepts server truth immediately. Called on a refused move
  // (res.ok false) before reload() — otherwise merge() keeps holding the failed optimistic row for the full
  // settle window (intervalMs*2), and the revert fetch is silently ignored, so the card sits in the wrong
  // place with no error indicator until the window elapses (M15).
  const clearPending = useCallback((taskId: string) => {
    pendingRef.current.delete(taskId);
  }, []);

  return { projects: data.projects, runs: data.runs, loaded, error, reload: load, applyMove, clearPending };
}
