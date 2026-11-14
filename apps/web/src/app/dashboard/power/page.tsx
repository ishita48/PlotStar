import { PageHeader } from "@/components/PageHeader";
import { EmptyState, Panel } from "@/components/ui";

export default function PowerReadyPage() {
  return (
    <>
      <PageHeader
        title="PowerReady"
        subtitle="Preliminary grid feasibility and investment underwriting for each feasible parcel. Grid capacity and energization dates stay scenario assumptions until a utility confirms them."
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Investment underwriting">
          <EmptyState
            title="Underwriting model not run"
            phase={3}
            needs={[
              "Construction cost per MW (sourced or team assumption)",
              "Cooling capex and opex per MW by type",
              "Discount rate and revenue per MW-year",
              "Interconnection upgrade cost scenarios",
              "Land price: CoStar asking or last sale, else Unknown",
              "Delay penalty per month",
            ]}
          >
            CAPEX, OPEX, NPV, payback and cost-of-delay sensitivity from a unit-tested pure function. IRR appears only when the
            cash-flow assumptions support it. NPV stays blocked while any assumption is unset.
          </EmptyState>
        </Panel>
        <Panel title="Grid-connection feasibility">
          <EmptyState
            title="No feasibility assessment yet"
            phase={3}
            needs={[
              "Substation proximity (OpenStreetMap)",
              "ERCOT large-load study threshold [VERIFY]",
              "CoStar heavy-power and service amps (loaded)",
              "Any user-supplied utility data",
            ]}
          >
            A preliminary assessment with a confidence level and an explicit &ldquo;requires utility confirmation&rdquo; list. A
            nearby substation is not available capacity.
          </EmptyState>
        </Panel>
        <Panel title="Time-to-power and phasing" className="lg:col-span-2">
          <EmptyState title="Scenarios not configured" phase={3}>
            Earliest plausible energization with its dependencies, the financial effect of delay (delay slider moves NPV through
            the model), and phased 20 / 50 / 100 MW development against a single phase. These are P1 and follow the P0 chain.
          </EmptyState>
        </Panel>
      </div>
    </>
  );
}
