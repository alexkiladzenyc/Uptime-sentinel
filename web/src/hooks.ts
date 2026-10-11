import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Loads data and refreshes it every `intervalMs` while the tab is visible.
 * `reload` triggers an immediate refresh (after a mutation).
 */
export function usePolling<T>(load: () => Promise<T>, intervalMs = 5000) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string | undefined>();
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(async () => {
    try {
      setData(await loadRef.current());
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void reload();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [reload, intervalMs]);

  return { data, error, reload };
}
