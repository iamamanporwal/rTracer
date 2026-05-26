import { useEffect, useState } from 'react';
import type { ManifestLoadError } from './load';

export type AsyncState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; value: T }
  | { status: 'error'; error: ManifestLoadError | Error };

/**
 * Minimal async-fetch hook for one-shot manifest loads. Phase 1 lives without
 * react-query; if the surface grows we'll lift to a real cache (blueprint
 * §3.1 keeps the stack lean).
 */
export function useAsync<T>(loader: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: 'idle' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    loader()
      .then((value) => {
        if (!cancelled) setState({ status: 'ready', value });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const error =
          err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'unknown');
        setState({ status: 'error', error });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}
