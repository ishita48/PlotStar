"""Modeling assumptions (PRD section 10). Each has a value, a unit, a basis and a label.

Nothing here is presented as measured. "team assumption" values are editable in the UI and in every
what-if request; values marked verify=True must be source-checked before they appear in the pitch.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


@dataclass(frozen=True)
class Assumption:
    key: str
    value: float
    unit: str
    basis: str
    label: str = "Estimated"
    verify: bool = False


ASSUMPTIONS: dict[str, Assumption] = {a.key: a for a in [
    Assumption("mw_per_acre", 1.0, "MW IT / acre",
               "Team assumption: single-story campus density used to size a site's supportable IT load."),
    Assumption("pue", 1.4, "ratio",
               "Team assumption for a new air/hybrid-cooled facility; industry survey averages are higher.",
               verify=True),
    Assumption("it_load_factor", 0.8, "share",
               "Team assumption: average IT utilization over the year."),
    Assumption("wue_water", 1.8, "L / kWh IT",
               "Team assumption for evaporative (water) cooling.", verify=True),
    Assumption("wue_hybrid", 0.7, "L / kWh IT", "Team assumption for hybrid cooling.", verify=True),
    Assumption("wue_air", 0.1, "L / kWh IT", "Team assumption for closed-loop air cooling.", verify=True),
    Assumption("capex_per_mw", 11_000_000, "USD / MW IT",
               "Team assumption for shell, electrical and mechanical build cost.", verify=True),
    Assumption("grid_kg_co2_per_mwh", 400.0, "kg CO2 / MWh",
               "Placeholder grid intensity until the ERCOT hourly fuel-mix feed is cached; replaced by the "
               "hourly Estimated value when available.", label="Simulated", verify=True),
    Assumption("jobs_construction_per_mw", 0.0, "jobs / MW",
               "Not modeled: no sourced jobs factor loaded.", label="Unknown"),
]}

COOLING_WUE = {"water": "wue_water", "hybrid": "wue_hybrid", "air": "wue_air"}
LITERS_PER_GALLON = 3.785411784


def as_list() -> list[dict[str, Any]]:
    return [asdict(a) for a in ASSUMPTIONS.values()]


def value(key: str, overrides: dict[str, float] | None = None) -> float:
    if overrides and key in overrides:
        return float(overrides[key])
    return ASSUMPTIONS[key].value


def impact(mw_it: float, cooling: str = "air", overrides: dict[str, float] | None = None,
           grid_kg_per_mwh: float | None = None) -> dict[str, Any]:
    """Annual energy, water, carbon and capex for an IT load. Pure function; every output is Estimated."""
    if cooling not in COOLING_WUE:
        raise ValueError(f"cooling must be one of {sorted(COOLING_WUE)}")
    lf, pue = value("it_load_factor", overrides), value("pue", overrides)
    it_mwh = mw_it * lf * 8760
    facility_mwh = it_mwh * pue
    wue = value(COOLING_WUE[cooling], overrides)
    water_l_per_day = it_mwh * 1000 * wue / 365
    intensity = grid_kg_per_mwh if grid_kg_per_mwh is not None else value("grid_kg_co2_per_mwh", overrides)
    return {
        "mw_it": mw_it,
        "cooling": cooling,
        "energy_gwh_per_year": round(facility_mwh / 1000, 1),
        "water_gal_per_day": round(water_l_per_day / LITERS_PER_GALLON),
        "co2_t_per_year": round(facility_mwh * intensity / 1000),
        "capex_usd": round(mw_it * value("capex_per_mw", overrides)),
        "peak_mw_facility": round(mw_it * pue, 1),
        "label": "Estimated",
        "formula": {
            "energy": f"MW_IT x load factor {lf} x 8760 h x PUE {pue}",
            "water": f"IT MWh x {wue} L/kWh ({cooling}) / 365 / {LITERS_PER_GALLON:.3f} L per gal",
            "carbon": f"facility MWh x {intensity:.0f} kg CO2/MWh",
            "capex": f"MW_IT x ${value('capex_per_mw', overrides):,.0f} per MW",
        },
    }
