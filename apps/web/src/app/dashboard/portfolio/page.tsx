"use client";

import { Trash2 } from "lucide-react";
import { useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState, ErrorBox, LabelChip, Metric, Panel, Skeleton } from "@/components/ui";
import { api, ApiError, type DataSummary, type Project, type ProjectIn } from "@/lib/api";
import { num, pct, usd } from "@/lib/format";
import { useApi } from "@/lib/useApi";

export default function PortfolioPage() {
  const summary = useApi<DataSummary>("/data/summary");
  const projects = useApi<Project[]>("/projects");
  const active = projects.data?.[0];

  return (
    <>
      <PageHeader
        title="Portfolio"
        subtitle="Define a development project, see what the CoStar extract covers, and compare the cost-first plan with the optimized plan once the optimizer runs."
      />

      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          {active ? <ProjectHeader p={active} candidates={summary.data?.by_market?.find((m) => m.market === active.region)?.candidates} /> : null}

          <Panel title="Cost-first vs PlotStar">
            <EmptyState
              title="No optimizer run yet"
              phase={4}
              needs={[
                "Screened parcels (Phase 2 hard gates)",
                "Assumptions set with a source or 'team assumption' tag",
                "Cached ERCOT hourly prices and fuel mix",
                "Optimizer run_id with baseline and optimized plans",
              ]}
            >
              This panel will show the cheapest feasible site (no flexibility, flat load) beside the optimizer&apos;s choice of
              site, cooling, flexibility and schedule, with the difference in dollars, estimated tonnes of CO2 and MW added to
              the grid peak. Every value will come from the optimizer response.
            </EmptyState>
          </Panel>

          <Panel title="CoStar Data Extract coverage" action={<LabelChip label="Sourced" />}>
            {summary.error && <ErrorBox error={summary.error} />}
            {summary.loading && !summary.data && <Skeleton className="h-28" />}
            {summary.data && !summary.data.ready && (
              <p className="text-sm text-muted">
                Parcel store is empty. Run <code>python -m app.costar.loader</code> in services/api.
              </p>
            )}
            {summary.data?.by_market && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted">
                    <tr className="border-b border-line">
                      <th className="py-2 pr-4 font-medium">Market</th>
                      <th className="py-2 pr-4 font-medium">All properties</th>
                      <th className="py-2 pr-4 font-medium">Site candidates</th>
                      <th className="py-2 pr-4 font-medium">With asking price</th>
                      <th className="py-2 pr-4 font-medium">With sale price</th>
                      <th className="py-2 pr-4 font-medium">Heavy power</th>
                      <th className="py-2 font-medium">3D scan</th>
                    </tr>
                  </thead>
                  <tbody className="tabular">
                    {summary.data.by_market.map((m) => (
                      <tr key={m.market} className="border-b border-line/50">
                        <td className="py-2 pr-4 font-medium">{m.market}</td>
                        <td className="py-2 pr-4">{num(m.properties)}</td>
                        <td className="py-2 pr-4">{num(m.candidates)}</td>
                        <td className="py-2 pr-4">{num(m.candidates_with_asking_price)}</td>
                        <td className="py-2 pr-4">{num(m.candidates_with_sale_price)}</td>
                        <td className="py-2 pr-4">{num(m.candidates_with_heavy_power)}</td>
                        <td className="py-2">{num(m.candidates_with_matterport)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-3 text-xs leading-relaxed text-muted">
                  Site candidates are Industrial, Flex and Land properties. The kit covers properties on CoStar&apos;s Matterport
                  list, so most are existing buildings, not raw land, and price coverage is sparse. Missing prices stay
                  Unknown and appear as evidence gaps.
                </p>
              </div>
            )}
          </Panel>
        </div>

        <div className="space-y-6">
          <NewProject onCreated={projects.reload} />
          <Panel title="Saved projects">
            {projects.error && <ErrorBox error={projects.error} />}
            {projects.data?.length === 0 && <p className="text-sm text-muted">No projects yet. Create one above.</p>}
            <ul className="space-y-2">
              {projects.data?.map((p) => (
                <li key={p.id} className="flex items-center justify-between rounded-lg border border-line bg-panel-2 px-3 py-2">
                  <div>
                    <div className="text-sm font-medium">{p.name}</div>
                    <div className="text-xs text-muted">
                      {num(p.capacity_mw)} MW · {p.region} · {pct(p.flexible_share)} flexible
                    </div>
                  </div>
                  <button
                    onClick={() => api(`/projects/${p.id}`, { method: "DELETE" }).then(projects.reload)}
                    className="rounded p-1 text-muted hover:text-bad"
                    aria-label={`Delete ${p.name}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </>
  );
}

function ProjectHeader({ p, candidates }: { p: Project; candidates?: number }) {
  return (
    <div>
      <div className="mb-3 flex items-baseline gap-3">
        <h2 className="text-lg font-semibold">{p.name}</h2>
        <span className="text-xs text-muted">Active project · created {new Date(p.created_at).toLocaleDateString()}</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Capacity" value={`${num(p.capacity_mw)} MW`} tag="Sourced" hint="User input" />
        <Metric label="Region" value={p.region} tag="Sourced" hint="User input" />
        <Metric
          label="Candidate parcels"
          value={candidates == null ? "Unknown" : num(candidates)}
          tag={candidates == null ? "Unknown" : "Sourced"}
          hint="CoStar Industrial, Flex, Land"
        />
        <Metric label="Passing screen" value="Not screened" tag="Unknown" hint="Hard gates arrive in Phase 2" />
      </div>
      <div className="mt-3 rounded-lg border border-warn/30 bg-warn/5 px-4 py-3 text-xs text-warn">
        {p.assumptions_unset.length} of {Object.keys(p.assumptions).length} financial assumptions are unset. NPV, payback and
        the optimizer stay blocked until each has a value and a source: {p.assumptions_unset.join(", ")}.
      </div>
    </div>
  );
}

function NewProject({ onCreated }: { onCreated: () => void }) {
  const [form, setForm] = useState({
    name: "Houston 100 MW",
    capacity_mw: "100",
    region: "Houston",
    max_land_cost: "",
    target_cod: "",
    flexible_share: "30",
  });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const body: ProjectIn = {
      name: form.name,
      capacity_mw: Number(form.capacity_mw),
      region: form.region,
      max_land_cost: form.max_land_cost ? Number(form.max_land_cost) : null,
      target_cod: form.target_cod || null,
      flexible_share: Number(form.flexible_share) / 100,
    };
    try {
      await api("/projects", { method: "POST", body: JSON.stringify(body) });
      onCreated();
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  const input = "w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-accent/70";
  return (
    <Panel title="New project">
      <form onSubmit={submit} className="space-y-3">
        <Field label="Name">
          <input className={input} value={form.name} onChange={set("name")} required />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Capacity (MW)">
            <input className={input} type="number" min={1} value={form.capacity_mw} onChange={set("capacity_mw")} required />
          </Field>
          <Field label="Region">
            <select className={input} value={form.region} onChange={set("region")}>
              <option>Houston</option>
              <option>Los Angeles</option>
            </select>
          </Field>
          <Field label="Max land cost ($)">
            <input className={input} type="number" min={0} placeholder="Optional" value={form.max_land_cost} onChange={set("max_land_cost")} />
          </Field>
          <Field label="Target operation date">
            <input className={input} type="date" value={form.target_cod} onChange={set("target_cod")} />
          </Field>
        </div>
        <Field label={`Flexible workload share: ${form.flexible_share}%`}>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={form.flexible_share}
            onChange={set("flexible_share")}
            className="w-full accent-[var(--accent)]"
          />
        </Field>
        <p className="text-xs text-muted">
          Max land cost: {form.max_land_cost ? usd(Number(form.max_land_cost)) : "not set"}. Financial assumptions start unset
          on purpose.
        </p>
        {err && <p className="text-xs text-bad">{err}</p>}
        <button
          disabled={busy}
          className="w-full rounded-lg bg-accent py-2 text-sm font-semibold text-black transition hover:brightness-110 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Create project"}
        </button>
      </form>
    </Panel>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-muted">{label}</span>
      {children}
    </label>
  );
}
