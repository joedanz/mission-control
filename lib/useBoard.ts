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

  const merge = useCallback((server: BoardData) => {
    const pending = pendingRef.current;
    if (pending.size === 0) {
      setData(server);
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
    try {
      const qs = new URLSearchParams();
      if (projectSlug) qs.set('project', projectSlug);
      const res = await fetch(`/api/board?${qs.toString()}`, { cache: 'no-store' });
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const json = await res.json();
      if (json.ok) {
        merge(json.data as BoardData);
        setError(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
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
            if (t.id === movedId && toStatus && toStatus !== t.status) next = { ...next, status: toStatus };
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

  return { projects: data.projects, runs: data.runs, loaded, error, reload: load, applyMove };
}
