"use client";

import { X } from "lucide-react";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { api, type ApiError, type AuditChain } from "@/lib/api";
import { LabelChip } from "./ui";

// The audit panel (PRD U6 / V-3): click any number and see where it came from.

type Ctx = { openParcelAudit: (parcelId: string, field: string) => void };
const AuditCtx = createContext<Ctx>({ openParcelAudit: () => {} });
export const useAudit = () => useContext(AuditCtx);

export function AuditProvider({ children }: { children: ReactNode }) {
  const [chain, setChain] = useState<AuditChain | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const openParcelAudit = useCallback((parcelId: string, field: string) => {
    setOpen(true);
    setChain(null);
    setError(null);
    api<AuditChain>(`/audit/parcel/${encodeURIComponent(parcelId)}/${encodeURIComponent(field)}`)
      .then(setChain)
      .catch((e: ApiError) => setError(e.message));
  }, []);

  return (
    <AuditCtx.Provider value={{ openParcelAudit }}>
      {children}
      {open && (
        <div className="fixed inset-0 z-[2000] flex justify-end bg-black/50" onClick={() => setOpen(false)}>
          <aside
            className="h-full w-full max-w-md overflow-y-auto border-l border-line bg-panel p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Evidence chain</h2>
              <button onClick={() => setOpen(false)} className="rounded p-1 text-muted hover:text-text" aria-label="Close">
                <X size={18} />
              </button>
            </div>
            {error && <p className="mt-4 text-sm text-bad">{error}</p>}
            {!chain && !error && <p className="mt-4 text-sm text-muted">Loading…</p>}
            {chain && (
              <dl className="mt-4 space-y-3 text-sm">
                <Row k="Field" v={<code className="text-accent">{chain.field}</code>} />
                <Row k="Value" v={<span className="tabular">{chain.value == null ? "Unknown" : String(chain.value)}</span>} />
                <Row k="Label" v={<LabelChip label={chain.label} />} />
                <Row k="Source" v={chain.source} />
                <Row k="File" v={<code>{chain.source_file}</code>} />
                <Row k="Line" v={chain.source_row ?? "No source record (value not in data)"} />
                <Row k="JSON path" v={<code className="break-all">{chain.json_path}</code>} />
                {chain.formula && <Row k="Method" v={chain.formula} />}
                {chain.extra &&
                  Object.entries(chain.extra).map(([k, v]) => <Row key={k} k={k} v={v == null ? "Unknown" : String(v)} />)}
                <Row k="Loaded" v={new Date(chain.loaded_at).toLocaleString()} />
                <Row k="Parcel" v={<code>{chain.parcel_id}</code>} />
              </dl>
            )}
          </aside>
        </div>
      )}
    </AuditCtx.Provider>
  );
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-3 border-b border-line/60 pb-2">
      <dt className="text-muted">{k}</dt>
      <dd className="text-text">{v}</dd>
    </div>
  );
}
