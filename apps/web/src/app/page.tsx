import { ArrowRight, Building2, Cpu, Zap } from "lucide-react";
import Link from "next/link";
import { LiveProof } from "@/components/LiveProof";
import { EVENT, ONE_LINER, PRODUCT, TAGLINE } from "@/lib/brand";

const STEPS = [
  {
    icon: Building2,
    title: "Where to build",
    body: "Real commercial parcels from CoStar, screened by hard pass/fail gates for homes, water, flood and cooling. A rejected site shows the gate, the value and the limit.",
  },
  {
    icon: Zap,
    title: "When power can arrive",
    body: "Preliminary grid feasibility, time-to-power scenarios and an underwriting model with every assumption visible. Anything a utility must confirm is listed, not guessed.",
  },
  {
    icon: Cpu,
    title: "How to run",
    body: "One optimizer chooses site, cooling, flexibility and the hourly schedule together, then compares itself with a cost-first plan on the same feasible parcels.",
  },
];

const LABELS = [
  ["Measured", "var(--lbl-measured)", "Our own sensors: watts, runtime, job completion."],
  ["Sourced", "var(--lbl-sourced)", "Named datasets with timestamps: CoStar, ERCOT, WRI."],
  ["Estimated", "var(--lbl-estimated)", "Documented methods: distance to homes, CO2, modeled cost."],
  ["Simulated", "var(--lbl-simulated)", "Scenarios and replays: the miniature grid, scaled-to-100 MW figures."],
] as const;

export default function Landing() {
  return (
    <main className="relative overflow-hidden">
      {/* afterglow */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-[520px] w-[1100px] -translate-x-1/2 rounded-full opacity-40 blur-3xl"
        style={{ background: "radial-gradient(closest-side, var(--accent-2), var(--accent) 45%, transparent)" }}
      />

      <nav className="relative mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <div className="flex items-baseline gap-2">
          <span className="text-xl font-bold tracking-tight">{PRODUCT}</span>
          <span className="text-xs text-muted">{EVENT}</span>
        </div>
        <Link href="/dashboard/portfolio" className="text-sm text-muted transition hover:text-text">
          Dashboard →
        </Link>
      </nav>

      <section className="relative mx-auto max-w-6xl px-6 pb-20 pt-16 sm:pt-24">
        <p className="text-sm font-medium uppercase tracking-[0.25em] text-accent">Data center development intelligence</p>
        <h1 className="mt-5 max-w-4xl text-4xl font-semibold leading-tight tracking-tight sm:text-6xl">{TAGLINE}</h1>
        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted">{ONE_LINER}</p>
        <div className="mt-10 flex flex-wrap items-center gap-4">
          <Link
            href="/dashboard/portfolio"
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-3 font-semibold text-black transition hover:brightness-110"
          >
            Launch dashboard <ArrowRight size={18} />
          </Link>
          <Link
            href="/dashboard/sites"
            className="rounded-lg border border-line px-5 py-3 font-medium text-text transition hover:border-accent/60"
          >
            Explore Houston parcels
          </Link>
        </div>
      </section>

      <section className="relative mx-auto max-w-6xl px-6 pb-20">
        <div className="grid gap-4 md:grid-cols-3">
          {STEPS.map(({ icon: Icon, title, body }, i) => (
            <div key={title} className="rounded-2xl border border-line bg-panel p-6">
              <div className="flex items-center gap-3">
                <span className="grid h-9 w-9 place-items-center rounded-lg bg-accent/15 text-accent">
                  <Icon size={18} />
                </span>
                <span className="text-xs text-muted">Step {i + 1}</span>
              </div>
              <h3 className="mt-4 text-lg font-semibold">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="relative mx-auto max-w-6xl px-6 pb-20">
        <h2 className="text-sm font-medium uppercase tracking-[0.2em] text-muted">Proof, not promises</h2>
        <LiveProof />
      </section>

      <section className="relative mx-auto max-w-6xl px-6 pb-24">
        <div className="rounded-2xl border border-line bg-panel p-6 sm:p-8">
          <h2 className="text-lg font-semibold">Honest limits</h2>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted">
            Every number in {PRODUCT} carries a label. A nearby substation is not available capacity. Wholesale ERCOT prices
            are not retail tariffs. Annual emissions factors are not hourly carbon. Shifting work to another hour changes
            cost, carbon and peak, not total energy. Grid capacity and energization dates require utility confirmation.
          </p>
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {LABELS.map(([name, color, text]) => (
              <div key={name} className="rounded-xl border border-line bg-panel-2 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold" style={{ color }}>
                  <span className="h-2 w-2 rounded-full" style={{ background: color }} />
                  {name}
                </div>
                <p className="mt-2 text-xs leading-relaxed text-muted">{text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <footer className="border-t border-line py-8 text-center text-xs text-muted">
        {PRODUCT} · {EVENT} · Property data © CoStar Group, used under the hackathon kit license
      </footer>
    </main>
  );
}
