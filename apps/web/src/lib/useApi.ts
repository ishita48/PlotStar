"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api";

type State<T> = { key: string | null; data: T | null; error: ApiError | null };

/** Fetch `path` from the API. Pass null to skip. `loading` is derived: true until the current key resolves. */
export function useApi<T>(path: string | null) {
  const [nonce, setNonce] = useState(0);
  const key = path == null ? null : `${nonce}|${path}`;
  const [state, setState] = useState<State<T>>({ key: null, data: null, error: null });

  useEffect(() => {
    if (path == null || key == null) return;
    let alive = true;
    api<T>(path)
      .then((data) => alive && setState({ key, data, error: null }))
      .catch((error: ApiError) => alive && setState((s) => ({ key, data: s.data, error })));
    return () => {
      alive = false;
    };
  }, [path, key]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data: state.data, error: state.error, loading: key != null && state.key !== key, reload };
}
