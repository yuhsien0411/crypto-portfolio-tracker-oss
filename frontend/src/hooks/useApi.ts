import { useEffect, useRef, useState } from "react";

export interface ApiState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  refetch: () => void;
}

// Module-level cache shared across mounts. Surviving unmount is the whole
// point: when the user navigates away and back, we want the previous page's
// data to be there immediately (no "flash" of empty UI) while we refetch in
// the background. Lives for the lifetime of the tab.
//
// Memory-only by design — we used to mirror to localStorage so the cache
// survived a page refresh, but that meant a portfolio summary (balances,
// holdings, top assets) sat on disk indefinitely after the tab closed. On a
// shared/borrowed machine that's a leak even after logout. The cost of
// dropping the persistent tier is one extra "Loading…" frame after refresh —
// a fair trade for an app that holds financial data.
const cache = new Map<string, unknown>();

// One-time cleanup of the old localStorage cache layer. Prior versions of
// this hook mirrored every API response to localStorage under
// `portfolio:cache:v1:*`. Existing installs still have those entries
// sitting on disk; sweep them on load so users who upgrade aren't carrying
// the leak forward. Safe to run more than once — no-ops once the keys are
// gone — but cheap enough to leave in for a few releases.
try {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith("portfolio:cache:v1:")) localStorage.removeItem(k);
  }
} catch {
  // Storage disabled (private mode, etc.) — nothing to clean.
}

// Tracks the user the in-memory cache currently belongs to. Set on
// login/auth-refresh and cleared on logout — when the scope changes we wipe
// the cache so a stale hit from the previous user can't satisfy a read for
// the next one.
let scope: string | null = null;

export function setCacheScope(nextScope: string | null): void {
  if (nextScope === scope) return;
  scope = nextScope;
  cache.clear();
}

export function clearApiCache(prefix?: string): void {
  if (!prefix) {
    cache.clear();
    return;
  }
  for (const k of [...cache.keys()]) {
    if (k.startsWith(prefix)) cache.delete(k);
  }
}

function readCache<T>(key: string): T | null {
  return cache.has(key) ? (cache.get(key) as T) : null;
}

function writeCache<T>(key: string, value: T): void {
  cache.set(key, value);
}

/**
 * Small async data hook — re-fetches when `deps` changes.
 *
 * If `key` is provided, the hook uses stale-while-revalidate: on mount it
 * seeds `data` from the in-memory cache so navigating between pages within
 * the same tab shows prior results instantly, then refetches silently to
 * keep the data fresh.
 */
export function useApi<T>(
  fetcher: () => Promise<T>,
  deps: unknown[] = [],
  key?: string,
): ApiState<T> {
  const cached = key ? readCache<T>(key) : null;
  const [data, setData] = useState<T | null>(cached);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(cached === null);
  const [tick, setTick] = useState(0);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    const hit = key ? readCache<T>(key) : null;
    if (hit !== null) {
      setData(hit);
      setLoading(false);
    } else {
      setLoading(true);
    }
    fetcher()
      .then((d) => {
        if (!live.current) return;
        setData(d);
        setError(null);
        if (key) writeCache(key, d);
      })
      .catch((e: Error) => {
        if (live.current) setError(e);
      })
      .finally(() => {
        if (live.current) setLoading(false);
      });
    return () => {
      live.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, key]);

  return { data, error, loading, refetch: () => setTick((t) => t + 1) };
}
