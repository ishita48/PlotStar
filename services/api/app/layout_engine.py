"""Studio layout engine: one design brief -> three distinct conceptual layouts, each measured and scored.

Deterministic geometry only. No model is involved: rack counts, room sizes, routes, cost, noise, carbon and
water are all computed here from the brief and from the planning assumptions below. Every assumption is
registered in the shared assumption sheet (GET /assumptions) with its basis, and can be overridden per request.

Coordinates are metres, x east, y north, origin at the south-west corner of the site rectangle.
This is early-stage planning evidence. It is not engineering design and certifies nothing.
"""
from __future__ import annotations

import math
from typing import Any

from . import assumptions as A
from .assumptions import Assumption

_T = "Team planning assumption"
STUDIO_ASSUMPTIONS = [
    Assumption("rack_width_m", 0.6, "m", f"{_T}: standard 600 mm rack."),
    Assumption("rack_depth_m", 1.2, "m", f"{_T}: 1200 mm deep rack."),
    Assumption("row_pitch_m", 2.4, "m", f"{_T}: one rack depth plus one 1.2 m aisle per row."),
    Assumption("hall_clearance_m", 1.8, "m", f"{_T}: clear perimeter inside a data hall."),
    Assumption("corridor_width_m", 4.0, "m", f"{_T}: service spine wide enough to move equipment."),
    Assumption("ups_m2_per_mw", 22.0, "m2 / MW IT / string", f"{_T} for UPS room area.", verify=True),
    Assumption("battery_m2_per_mw", 14.0, "m2 / MW IT / string", f"{_T} for battery room area.", verify=True),
    Assumption("switchgear_m2_per_mw", 12.0, "m2 / MW IT", f"{_T} for switchgear room area.", verify=True),
    Assumption("mech_m2_per_mw_air", 45.0, "m2 / MW IT", f"{_T}: air handler galleries.", verify=True),
    Assumption("mech_m2_per_mw_hybrid", 36.0, "m2 / MW IT", f"{_T}.", verify=True),
    Assumption("mech_m2_per_mw_water", 32.0, "m2 / MW IT", f"{_T}.", verify=True),
    Assumption("mech_m2_per_mw_liquid", 28.0, "m2 / MW IT", f"{_T}: coolant distribution and pump rooms.", verify=True),
    Assumption("pue_liquid", 1.15, "ratio", f"{_T} for direct liquid cooling with dry coolers.", verify=True),
    Assumption("wue_liquid", 0.05, "L / kWh IT", f"{_T} for closed-loop liquid cooling.", verify=True),
    Assumption("cooling_capex_liquid", 2_400_000, "USD / MW IT", f"{_T}.", verify=True),
    Assumption("genset_mw", 2.5, "MW", f"{_T}: one standby generator."),
    Assumption("cooling_yard_m2_per_mw", 15.0, "m2 / MW IT", f"{_T} for outdoor heat rejection.", verify=True),
    Assumption("equipment_share_of_capex", 0.75, "share",
               f"{_T}: share of the per-MW build cost that is electrical and mechanical equipment.", verify=True),
    Assumption("shell_cost_per_m2", 3000.0, "USD / m2", f"{_T} for the building shell.", verify=True),
    Assumption("busway_cost_per_m", 3500.0, "USD / m", f"{_T} for installed electrical distribution.", verify=True),
    Assumption("pipe_cost_per_m", 2200.0, "USD / m", f"{_T} for installed cooling pipework.", verify=True),
    Assumption("redundancy_cost_n", 0.92, "x", f"{_T}: equipment cost factor at N."),
    Assumption("redundancy_cost_n1", 1.0, "x", f"{_T}: equipment cost factor at N+1."),
    Assumption("redundancy_cost_2n", 1.18, "x", f"{_T}: equipment cost factor at 2N.", verify=True),
    Assumption("genset_dba_at_7m", 75.0, "dBA", f"{_T}: one enclosed generator at 7 m.", verify=True),
    Assumption("noise_limit_dba", 55.0, "dBA", f"{_T}: daytime residential guideline used as the comparison line.",
               verify=True),
    Assumption("embodied_kgco2_per_m2", 500.0, "kg CO2e / m2", f"{_T} for shell and structure.", verify=True),
    Assumption("roof_solar_usable_share", 0.6, "share", f"{_T}: roof area free of plant."),
    Assumption("roof_solar_kw_per_m2", 0.18, "kWp / m2", f"{_T}."),
    Assumption("solar_kwh_per_kwp", 1400.0, "kWh / kWp / yr", f"{_T}; use the local-conditions PVWatts figure when known.",
               verify=True),
    Assumption("bess_mwh_per_m2", 0.1, "MWh / m2", f"{_T}: containerised battery storage with access aisles.", verify=True),
    Assumption("bess_cost_per_mwh", 350_000, "USD / MWh", f"{_T} for installed battery storage.", verify=True),
    Assumption("solar_cost_per_kwp", 1400.0, "USD / kWp", f"{_T} for an installed solar canopy.", verify=True),
    Assumption("max_site_coverage", 0.6, "share", f"{_T}: building plus yard may cover at most this share of the site."),
]
for _a in STUDIO_ASSUMPTIONS:
    A.ASSUMPTIONS.setdefault(_a.key, _a)

COOLING = ("air", "hybrid", "water", "liquid")
REDUNDANCY = ("N", "N+1", "2N")
STRINGS = {"N": 1.0, "N+1": 1.5, "2N": 2.0}
RED_COST = {"N": "redundancy_cost_n", "N+1": "redundancy_cost_n1", "2N": "redundancy_cost_2n"}
FLOOR_H = 6.0
# outdoor items a user may add in the studio: display name and height
ADDED = {"yard_bess": ("Battery storage", 3.0), "yard_solar": ("Solar canopy", 4.5), "yard_water": ("Water storage", 8.0)}


def default_halls(mw: float) -> int:
    return int(min(12, max(1, round(mw / 5.0))))


def _split(x: float, y: float, w: float, d: float, parts: list[tuple[str, str, str, float]], axis: str) -> list[dict]:
    """Fill a rectangle with rooms whose sizes are proportional to their required areas."""
    total = sum(p[3] for p in parts) or 1.0
    out, cur = [], 0.0
    for code, name, typ, area in parts:
        share = area / total
        if axis == "x":
            out.append(dict(code=code, name=name, type=typ, x=x + cur, y=y, w=w * share, d=d, need_m2=area))
            cur += w * share
        else:
            out.append(dict(code=code, name=name, type=typ, x=x, y=y + cur, w=w, d=d * share, need_m2=area))
            cur += d * share
    return out


class _Ctx:
    """Everything derived from the brief that every concept shares."""

    def __init__(self, b: dict[str, Any], ov: dict[str, float]):
        v = lambda k: A.value(k, ov)  # noqa: E731
        self.v = v
        self.mw = float(b["mw_it"])
        self.rack_kw = float(b["rack_kw"])
        self.cooling = b["cooling"]
        self.red = b["redundancy"]
        self.halls = int(b.get("halls") or default_halls(self.mw))
        self.racks = int(math.ceil(self.mw * 1000.0 / self.rack_kw))
        self.per_hall = [self.racks // self.halls + (1 if i < self.racks % self.halls else 0) for i in range(self.halls)]
        self.hall_mw = self.mw / self.halls
        self.rw, self.rd, self.pitch, self.clr, self.spine = (v("rack_width_m"), v("rack_depth_m"), v("row_pitch_m"),
                                                              v("hall_clearance_m"), v("corridor_width_m"))
        s = STRINGS[self.red]
        self.elec_parts = [("UPS-A", "UPS A", "electrical", v("ups_m2_per_mw") * self.hall_mw)]
        if s > 1:
            self.elec_parts.append(("UPS-B", "UPS B", "electrical", v("ups_m2_per_mw") * self.hall_mw * (s - 1)))
        self.elec_parts += [("BAT", "Battery", "battery", v("battery_m2_per_mw") * self.hall_mw * s),
                            ("SWG", "Switchgear", "electrical", v("switchgear_m2_per_mw") * self.hall_mw)]
        self.elec_area = sum(p[3] for p in self.elec_parts)
        self.mech_area = v(f"mech_m2_per_mw_{self.cooling}") * self.hall_mw
        self.shared_parts = [("LD-01", "Loading / staging", "loading", 200 + 6 * self.mw),
                             ("NOC-01", "NOC / control", "support", 120.0),
                             ("OF-01", "Office / welfare", "support", 260.0),
                             ("MMR-A", "Meet-me room A", "network", 70.0),
                             ("MMR-B", "Meet-me room B", "network", 70.0),
                             ("SEC-01", "Security", "support", 60.0)]
        self.shared_area = sum(p[3] for p in self.shared_parts)
        self.pue = v(f"pue_{self.cooling}")
        self.fac_mw = self.mw * self.pue
        n = math.ceil(self.fac_mw / v("genset_mw"))
        self.gens = n if self.red == "N" else n + 1 if self.red == "N+1" else 2 * n
        self.gens_needed = n

    def hall(self, length: float) -> tuple[int, int, float] | None:
        rpr = int((length - 2 * self.clr) // self.rw)
        if rpr < 8:
            return None
        rows = math.ceil(max(self.per_hall) / rpr)
        return rpr, rows, rows * self.pitch + 2 * self.clr

    def hall_room(self, i: int, x: float, y: float, w: float, d: float, rpr: int, rows: int) -> dict:
        placed, rws = self.per_hall[i], []
        left = placed
        for j in range(rows):
            n = min(rpr, left)
            left -= n
            rws.append(dict(x=x + self.clr, y=y + self.clr + j * self.pitch, w=rpr * self.rw, d=self.rd, n=n, cap=rpr))
        return dict(code=f"DH-{i + 1:02d}", name=f"Data hall {i + 1}", type="data_hall", x=x, y=y, w=w, d=d,
                    racks=placed, positions=rows * rpr, mw=round(placed * self.rack_kw / 1000.0, 2), rows=rws)

    def tag(self, rooms: list[dict], i: int) -> list[dict]:
        for r in rooms:
            r["code"], r["hall"] = f"{r['code']}-{i + 1}", i + 1
        return rooms


def _long_halls(c: _Ctx, length: float) -> dict | None:
    """Halls stacked north-south, one service spine down the west side, technical rooms west of the spine."""
    h = c.hall(length)
    if not h:
        return None
    rpr, rows, dh = h
    if not 1.0 <= length / dh <= 7.0:
        return None
    tw, mc = max(8.0, c.elec_area / dh), max(6.0, c.mech_area / dh)
    w = tw + c.spine + length + mc
    sb = max(10.0, c.shared_area / w)
    rooms = _split(0, 0, w, sb, c.shared_parts, "x")
    for i in range(c.halls):
        y = sb + i * dh
        rooms += c.tag(_split(0, y, tw, dh, c.elec_parts, "y"), i)
        rooms.append(c.hall_room(i, tw + c.spine, y, length, dh, rpr, rows))
        rooms.append(dict(code=f"ME-{i + 1}", name="Mechanical plant", type="mechanical", x=tw + c.spine + length, y=y,
                          w=mc, d=dh, need_m2=c.mech_area, hall=i + 1))
    rooms.append(dict(code="SP-01", name="Service spine", type="corridor", x=tw, y=sb, w=c.spine, d=c.halls * dh))
    return dict(w=w, d=sb + c.halls * dh, rooms=rooms)


def _service_bands(c: _Ctx, length: float) -> dict | None:
    """Halls side by side; one shared electrical band to the north and one mechanical band to the south."""
    h = c.hall(length)
    if not h:
        return None
    rpr, rows, dh = h
    if not 0.45 <= length / dh <= 3.0:
        return None
    eb, mb = max(8.0, c.elec_area / length), max(6.0, c.mech_area / length)
    d = mb + c.spine + dh + c.spine + eb
    sw = max(10.0, c.shared_area / d)
    hw = c.halls * length
    rooms = _split(hw, 0, sw, d, c.shared_parts, "y")
    for i in range(c.halls):
        x = i * length
        rooms.append(dict(code=f"ME-{i + 1}", name="Mechanical plant", type="mechanical", x=x, y=0, w=length, d=mb,
                          need_m2=c.mech_area, hall=i + 1))
        rooms.append(c.hall_room(i, x, mb + c.spine, length, dh, rpr, rows))
        rooms += c.tag(_split(x, mb + 2 * c.spine + dh, length, eb, c.elec_parts, "x"), i)
    rooms.append(dict(code="SP-01", name="Mechanical corridor", type="corridor", x=0, y=mb, w=hw, d=c.spine))
    rooms.append(dict(code="SP-02", name="Electrical corridor", type="corridor", x=0, y=mb + c.spine + dh, w=hw, d=c.spine))
    return dict(w=hw + sw, d=d, rooms=rooms)


def _opposed_banks(c: _Ctx, length: float) -> dict | None:
    """Two banks of halls facing a central cross spine; technical rooms on the outer north and south edges."""
    h = c.hall(length)
    if not h:
        return None
    rpr, rows, dh = h
    if not 0.45 <= length / dh <= 4.0:
        return None
    nt = math.ceil(c.halls / 2)
    nb = c.halls - nt
    cs = c.spine + 1.0
    tb = max(8.0, (c.elec_area + c.mech_area) / length)
    mech = [("ME", "Mechanical plant", "mechanical", c.mech_area)]
    south = (tb + dh) if nb else 0.0
    d = south + cs + dh + tb
    sw = max(10.0, c.shared_area / d)
    hw = nt * length
    rooms = _split(hw, 0, sw, d, c.shared_parts, "y")
    for k in range(nt):  # north bank
        x = k * length
        rooms.append(c.hall_room(k, x, south + cs, length, dh, rpr, rows))
        rooms += c.tag(_split(x, south + cs + dh, length, tb, c.elec_parts + mech, "x"), k)
    for k in range(nt):  # south bank; an empty slot is kept as an expansion bay
        x = k * length
        if k < nb:
            i = nt + k
            rooms += c.tag(_split(x, 0, length, tb, c.elec_parts + mech, "x"), i)
            rooms.append(c.hall_room(i, x, tb, length, dh, rpr, rows))
        elif nb:
            rooms.append(dict(code=f"EX-{k + 1}", name="Expansion bay", type="reserve", x=x, y=0, w=length, d=south,
                              positions=rows * rpr))
    rooms.append(dict(code="SP-01", name="Central spine", type="corridor", x=0, y=south, w=hw, d=cs))
    return dict(w=hw + sw, d=d, rooms=rooms)


CONCEPTS = [
    ("long-halls", "Long halls, side spine", _long_halls,
     "Long halls stacked north to south; one service spine on the west; technical rooms beside each hall."),
    ("service-bands", "Shared service bands", _service_bands,
     "Short halls side by side; one shared electrical band to the north and a mechanical band to the south."),
    ("opposed-banks", "Opposed hall banks", _opposed_banks,
     "Two banks of halls facing a central spine; technical rooms on the outer edges; spare bay kept for growth."),
]


def _best(c: _Ctx, fn, env_w: float, env_d: float) -> tuple[dict, bool]:
    fit, over = None, None
    length = 14.4
    while length <= max(env_w, env_d) + 0.01:
        g = fn(c, length)
        if g:
            area = g["w"] * g["d"]
            if g["w"] <= env_w + 1e-6 and g["d"] <= env_d + 1e-6:
                if fit is None or area < fit[0]:
                    fit = (area, g)
            else:
                ratio = max(g["w"] / env_w, g["d"] / env_d)
                if over is None or ratio < over[0]:
                    over = (ratio, g)
        length += c.rw * 2
    if fit:
        return fit[1], True
    if over:
        return over[1], False
    raise ValueError("The brief cannot be laid out: reduce capacity or raise rack density.")


def _yard(c: _Ctx, hmax: float) -> dict:
    """Outdoor plant east of the building: substation, standby generators, heat rejection, water storage."""
    v = c.v
    items: list[dict] = []
    sub_area = max(1200.0, 25.0 * c.fac_mw)
    items.append(dict(code="SUB-01", name="Substation", type="yard_sub", w=40.0, d=sub_area / 40.0, h=5.0))
    per_col = max(1, min(8, int(hmax // 13)))
    cols = math.ceil(c.gens / per_col)
    items.append(dict(code="GEN", name="Generator yard", type="yard_gen", w=cols * 6.0, d=min(c.gens, per_col) * 13.0,
                      h=0.3, per_col=per_col))
    cool_area = v("cooling_yard_m2_per_mw") * c.mw
    items.append(dict(code="CY-01", name="Heat rejection yard", type="yard_cool", w=30.0, d=cool_area / 30.0, h=4.0))
    if c.cooling in ("water", "hybrid"):
        items.append(dict(code="WT-01", name="Water storage", type="yard_water", w=14.0, d=14.0, h=8.0))
    x = y = colw = 0.0
    for it in items:
        if it["d"] > hmax:  # too tall for the yard strip: make it wider instead
            it["w"], it["d"] = it["w"] * it["d"] / hmax, hmax
        if y > 0 and y + it["d"] > hmax:
            x, y, colw = x + colw + 4.0, 0.0, 0.0
        it["x"], it["y"] = x, y
        y += it["d"] + 4.0
        colw = max(colw, it["w"])
    return dict(items=items, w=x + colw)


def _c(r: dict) -> tuple[float, float]:
    return r["x"] + r["w"] / 2, r["y"] + r["d"] / 2


def _route(a: tuple[float, float], b: tuple[float, float]) -> tuple[list[list[float]], float]:
    pts = [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]]]
    return pts, abs(a[0] - b[0]) + abs(a[1] - b[1])


def _flex_avg(series: list[float], order: list[float], share: float, mult: float) -> float:
    """Average of `series` when `share` of the energy runs in the cheapest hours (ranked by `order`)."""
    flat = sum(series) / len(series)
    if share <= 0:
        return flat
    k = max(1, math.ceil(len(series) / max(mult, 1.0)))
    idx = sorted(range(len(order)), key=lambda i: order[i])[:k]
    return (1 - share) * flat + share * sum(series[i] for i in idx) / k


def _gate(site: dict, name: str) -> dict | None:
    return next((g for g in (site.get("gates") or []) if g.get("gate") == name), None)


def generate(brief: dict[str, Any], site: dict[str, Any], grid: dict[str, Any], priorities: dict[str, float],
             overrides: dict[str, float] | None = None, edits: dict[str, Any] | None = None) -> dict[str, Any]:
    """`edits` holds the user's changes per concept id: {"building": {dx, dy}, "yard": {code: {x, y}}, "added": [...]}.
    Edited geometry is measured and checked exactly like generated geometry."""
    ov = overrides or {}
    c = _Ctx(brief, ov)
    v = c.v
    site_w, site_d, setback = float(brief["site_w"]), float(brief["site_d"]), float(brief.get("setback_m", 8.0))
    reserve = float(brief.get("expansion_pct", 10.0)) / 100.0
    usable_w, usable_d = site_w - 2 * setback, site_d - 2 * setback
    if usable_w < 40 or usable_d < 40:
        raise ValueError("The site is too small once setbacks are applied.")
    yard0 = _yard(c, usable_d)
    gap = 6.0
    env_w = float(brief.get("env_w") or max(30.0, usable_w - yard0["w"] - gap))
    env_d = float(brief.get("env_d") or usable_d)

    flex = float(brief.get("flexible_share", 0.0))
    price, carbon = grid["price"], grid["carbon"]
    mult = v("flex_rate_multiple")
    p_flat, p_flex = sum(price) / len(price), _flex_avg(price, price, flex, mult)
    c_flat, c_flex = sum(carbon) / len(carbon), _flex_avg(carbon, price, flex, mult)
    it_mwh = c.mw * v("it_load_factor") * 8760.0
    fac_mwh = it_mwh * c.pue
    water_m3 = it_mwh * 1000.0 * v(f"wue_{c.cooling}") / 1000.0
    water_cost = water_m3 * 264.172 / 1000.0 * v("water_price_per_kgal")

    homes, gridg = _gate(site, "Residential proximity"), _gate(site, "Grid proximity")
    home_m = float(homes["value"]) if homes and isinstance(homes.get("value"), (int, float)) else None
    sub_km = float(gridg["value"]) if gridg and isinstance(gridg.get("value"), (int, float)) else None
    interconnect = (sub_km if sub_km is not None else v("default_substation_km")) * v("interconnect_cost_per_km")

    out = []
    for cid, name, fn, strategy in CONCEPTS:
        g, fits = _best(c, fn, env_w, env_d)
        bw, bd = g["w"], g["d"]
        yard = _yard(c, max(usable_d, 40.0))
        total_w = bw + gap + yard["w"]
        ox, oy = (site_w - total_w) / 2, (site_d - bd) / 2
        ed = (edits or {}).get(cid) or {}
        yx, yy = ox + bw + gap, (site_d - min(usable_d, max(i["y"] + i["d"] for i in yard["items"]))) / 2
        ox, oy = ox + float((ed.get("building") or {}).get("dx", 0)), oy + float((ed.get("building") or {}).get("dy", 0))
        rooms = g["rooms"]
        for r in rooms:
            r["x"], r["y"] = r["x"] + ox, r["y"] + oy
            r["h"] = 0.15 if r["type"] == "corridor" else FLOOR_H
            for rw in r.get("rows", []):
                rw["x"], rw["y"] = rw["x"] + ox, rw["y"] + oy
        equipment = []
        moved = ed.get("yard") or {}
        for it in yard["items"]:
            it["x"], it["y"] = it["x"] + yx, it["y"] + yy
            if it["code"] in moved:
                it["x"], it["y"] = float(moved[it["code"]]["x"]), float(moved[it["code"]]["y"])
            if it["type"] == "yard_gen":
                for k in range(c.gens):
                    equipment.append(dict(code=f"G-{k + 1:02d}", type="generator", x=it["x"] + (k // it["per_col"]) * 6.0 + 1.5,
                                          y=it["y"] + (k % it["per_col"]) * 13.0 + 0.5, w=3.0, d=12.0, h=3.5))
        yard_items = yard["items"] + [
            dict(code=a["code"], name=ADDED[a["type"]][0], type=a["type"], x=float(a["x"]), y=float(a["y"]), w=float(a["w"]),
                 d=float(a["d"]), h=ADDED[a["type"]][1], added=True)
            for a in ed.get("added") or [] if a.get("type") in ADDED]
        halls = [r for r in rooms if r["type"] == "data_hall"]
        by = lambda t: next(i for i in yard_items if i["type"] == t)  # noqa: E731
        sub, gen, cool = by("yard_sub"), by("yard_gen"), by("yard_cool")
        mmr = next(r for r in rooms if r["code"] == "MMR-A")
        routes: dict[str, list] = {"power": [], "cooling": [], "data": []}
        lens = {"power": 0.0, "cooling": 0.0, "data": 0.0}
        for hl in halls:
            n = int(hl["code"][-2:])
            swg = next(r for r in rooms if r.get("hall") == n and r["code"].startswith("SWG"))
            me = next(r for r in rooms if r.get("hall") == n and r["code"].startswith("ME"))
            for kind, chain in (("power", [_c(sub), _c(swg), _c(hl)]), ("cooling", [_c(cool), _c(me), _c(hl)]),
                                ("data", [_c(mmr), _c(hl)])):
                for a, b2 in zip(chain, chain[1:]):
                    pts, ln = _route(a, b2)
                    routes[kind].append(pts)
                    lens[kind] += ln

        footprint = bw * bd
        yard_area = sum(i["w"] * i["d"] for i in yard_items)
        coverage = (footprint + yard_area) / (site_w * site_d)
        placed = sum(hl["racks"] for hl in halls)
        positions = sum(hl["positions"] for hl in halls)
        bay = sum(r.get("positions", 0) for r in rooms if r["type"] == "reserve")
        hall_area = sum(hl["w"] * hl["d"] for hl in halls)
        corridor_area = sum(r["w"] * r["d"] for r in rooms if r["type"] == "corridor")

        # Money
        equip = c.mw * v("capex_per_mw") * v("equipment_share_of_capex") * v(RED_COST[c.red])
        cool_capex = c.mw * v(f"cooling_capex_{c.cooling}")
        shell = footprint * v("shell_cost_per_m2")
        distribution = lens["power"] * v("busway_cost_per_m") + lens["cooling"] * v("pipe_cost_per_m")
        bess_mwh = sum(i["w"] * i["d"] for i in yard_items if i["type"] == "yard_bess") * v("bess_mwh_per_m2")
        canopy_kwp = sum(i["w"] * i["d"] for i in yard_items if i["type"] == "yard_solar") * v("roof_solar_kw_per_m2")
        added_cost = bess_mwh * v("bess_cost_per_mwh") + canopy_kwp * v("solar_cost_per_kwp")
        capex = equip + cool_capex + shell + distribution + interconnect + added_cost
        energy_flat, energy_flex = fac_mwh * p_flat, fac_mwh * p_flex
        opex = c.mw * v("opex_per_mw_year")
        ten_year = capex + 10 * (energy_flex + opex + water_cost)

        # People: standby generator noise, heard only during tests and outages
        gx, gy = _c(gen)
        edge = max(1.0, min(gx, site_w - gx, gy, site_d - gy))
        src = v("genset_dba_at_7m") + 10 * math.log10(max(1, c.gens_needed))
        noise_edge = src - 20 * math.log10(max(edge, 7.0) / 7.0)
        noise_home = src - 20 * math.log10(max(edge + home_m, 7.0) / 7.0) if home_m is not None else None

        # Planet
        embodied_t = footprint * v("embodied_kgco2_per_m2") / 1000.0
        solar_kwp = footprint * v("roof_solar_usable_share") * v("roof_solar_kw_per_m2") + canopy_kwp
        solar_mwh = solar_kwp * v("solar_kwh_per_kwp") / 1000.0
        co2_flat, co2_flex = fac_mwh * c_flat / 1000.0, fac_mwh * c_flex / 1000.0
        solar_t = solar_mwh * c_flat / 1000.0

        every = [dict(x=ox, y=oy, w=bw, d=bd, code="Building")] + yard_items
        margin = min(min(i["x"], i["y"], site_w - i["x"] - i["w"], site_d - i["y"] - i["d"]) for i in every)
        clash = [f"{a['code']} and {o['code']}" for n_, a in enumerate(every) for o in every[n_ + 1:]
                 if min(a["x"] + a["w"], o["x"] + o["w"]) - max(a["x"], o["x"]) > 0.05
                 and min(a["y"] + a["d"], o["y"] + o["d"]) - max(a["y"], o["y"]) > 0.05]
        gens_ok = c.gens >= c.gens_needed + (1 if c.red != "N" else 0) or c.red == "N"
        checks = [
            dict(name="Fits the building envelope", ok=fits,
                 detail=f"Building {bw:.0f} x {bd:.0f} m in a {env_w:.0f} x {env_d:.0f} m envelope."),
            dict(name="Inside the setback", ok=margin >= setback - 1e-6,
                 detail=("Something sits outside the site boundary." if margin < 0 else
                         f"Closest point is {margin:.0f} m from the boundary; the setback is {setback:.0f} m.")),
            dict(name="Nothing overlaps", ok=not clash,
                 detail=f"Overlapping: {'; '.join(clash[:3])}." if clash else "Building and outdoor plant are clear of each other."),
            dict(name="All racks placed", ok=placed == c.racks, detail=f"{placed:,} of {c.racks:,} racks placed."),
            dict(name="Backup power covers the load", ok=gens_ok,
                 detail=f"{c.gens} generators of {v('genset_mw')} MW for a {c.fac_mw:.1f} MW facility load at {c.red}."),
            dict(name="Site coverage", ok=coverage <= v("max_site_coverage"),
                 detail=f"{coverage * 100:.0f}% of the site is building or yard; limit {v('max_site_coverage') * 100:.0f}%."),
            dict(name="Land kept for expansion", ok=1 - coverage >= reserve,
                 detail=f"{(1 - coverage) * 100:.0f}% of the site stays open; the brief reserves {reserve * 100:.0f}%."),
        ]
        if noise_home is not None:
            checks.append(dict(name="Generator noise at the nearest home", ok=noise_home <= v("noise_limit_dba"),
                               detail=f"{noise_home:.0f} dBA estimated during a test, against {v('noise_limit_dba'):.0f} dBA."))
        for r in rooms:
            for k in ("x", "y", "w", "d"):
                r[k] = round(r[k], 2)
            for rw in r.get("rows", []):
                for k in ("x", "y", "w", "d"):
                    rw[k] = round(rw[k], 2)
            if "need_m2" in r:
                r["need_m2"] = round(r["need_m2"], 1)
            r["area_m2"] = round(r["w"] * r["d"], 1)
        out.append(dict(
            id=cid, name=name, strategy=strategy, feasible=all(k["ok"] for k in checks[:5]),
            building=dict(x=round(ox, 2), y=round(oy, 2), w=round(bw, 2), d=round(bd, 2), h=FLOOR_H),
            rooms=rooms, yard=[{k: (round(val, 2) if isinstance(val, float) else val) for k, val in i.items()} for i in yard_items],
            equipment=equipment, routes=routes, checks=checks,
            metrics=dict(
                footprint_m2=round(footprint), placed_racks=placed, rack_positions=positions,
                spare_positions=positions - placed, expansion_bay_positions=bay, hall_area_m2=round(hall_area),
                corridor_area_m2=round(corridor_area), corridor_share=round(corridor_area / footprint, 3),
                power_route_m=round(lens["power"]), cooling_route_m=round(lens["cooling"]), data_route_m=round(lens["data"]),
                site_coverage=round(coverage, 3), yard_area_m2=round(yard_area), generators=c.gens),
            money=dict(capex=round(capex), shell=round(shell), equipment=round(equip + cool_capex),
                       distribution=round(distribution), interconnect=round(interconnect), added=round(added_cost),
                       energy_per_year=round(energy_flex), energy_per_year_flat=round(energy_flat),
                       opex_per_year=round(opex), water_per_year=round(water_cost), ten_year=round(ten_year)),
            people=dict(noise_at_boundary_dba=round(noise_edge, 1),
                        noise_at_home_dba=round(noise_home, 1) if noise_home is not None else None,
                        generator_to_boundary_m=round(edge), home_distance_m=home_m),
            planet=dict(co2_t_per_year=round(co2_flex), co2_t_per_year_flat=round(co2_flat), embodied_t=round(embodied_t),
                        roof_solar_kwp=round(solar_kwp), canopy_solar_kwp=round(canopy_kwp), roof_solar_mwh=round(solar_mwh),
                        roof_solar_share=round(solar_mwh / fac_mwh, 4), solar_avoided_t=round(solar_t)),
            resources=dict(water_m3_per_year=round(water_m3), energy_mwh_per_year=round(fac_mwh),
                           facility_mw=round(c.fac_mw, 1), open_land_share=round(1 - coverage, 3),
                           spare_positions=positions - placed + bay, bess_mwh=round(bess_mwh, 1),
                           bess_minutes=round(bess_mwh / c.fac_mw * 60.0, 1)),
        ))

    _score(out, priorities)
    return dict(
        brief=dict(mw_it=c.mw, rack_kw=c.rack_kw, racks=c.racks, halls=c.halls, racks_per_hall=c.per_hall,
                   redundancy=c.red, cooling=c.cooling, pue=c.pue, facility_mw=round(c.fac_mw, 1), generators=c.gens,
                   site_w=site_w, site_d=site_d, setback_m=setback, env_w=round(env_w, 1), env_d=round(env_d, 1),
                   expansion_pct=reserve * 100, flexible_share=flex),
        concepts=out,
        operating=dict(price_flat=round(p_flat, 2), price_flex=round(p_flex, 2), carbon_flat=round(c_flat, 1),
                       carbon_flex=round(c_flex, 1), price_label=grid.get("price_label"),
                       carbon_label=grid.get("carbon_label"), price_source=grid.get("price_source"),
                       carbon_source=grid.get("carbon_source"), notes=grid.get("notes", [])),
        site=dict(home_distance_m=home_m, substation_km=sub_km, gates=site.get("gates") or [], name=site.get("name")),
        assumptions=[dict(key=a.key, value=A.value(a.key, ov), unit=a.unit, basis=a.basis, label=a.label, verify=a.verify)
                     for a in STUDIO_ASSUMPTIONS],
        labels=dict(geometry="Estimated", money="Estimated", people="Estimated", planet="Estimated", resources="Estimated",
                    interconnect="Simulated"),
        note="Conceptual planning evidence computed from the brief and the listed assumptions. Not engineering design.",
    )


def _score(concepts: list[dict], pr: dict[str, float]) -> None:
    """Rank feasible concepts. Scores compare the three concepts with each other; they are not absolute grades."""
    def rel(vals: list[float], lower: bool = True) -> list[float]:
        best = min(vals) if lower else max(vals)
        if best <= 0:
            return [100.0 for _ in vals]
        return [round(100.0 * (best / x if lower else x / best), 1) if x > 0 else 0.0 for x in vals]

    money = rel([k["money"]["ten_year"] for k in concepts])
    nb = [k["people"]["noise_at_boundary_dba"] for k in concepts]
    people = [round(max(0.0, 100.0 - (x - min(nb)) * 5.0), 1) for x in nb]
    planet = rel([max(1.0, k["planet"]["embodied_t"] - k["planet"]["solar_avoided_t"]) for k in concepts])
    land = rel([k["metrics"]["site_coverage"] for k in concepts])
    spare = rel([float(k["resources"]["spare_positions"]) + 1 for k in concepts], lower=False)
    w = {k: max(0.0, float(pr.get(k, 1.0))) for k in ("money", "people", "planet", "resources")}
    tot = sum(w.values()) or 1.0
    for i, k in enumerate(concepts):
        res = round((land[i] + spare[i]) / 2, 1)
        k["scores"] = dict(money=money[i], people=people[i], planet=planet[i], resources=res)
        k["score"] = round((w["money"] * money[i] + w["people"] * people[i] + w["planet"] * planet[i] + w["resources"] * res) / tot, 1)
    order = sorted(range(len(concepts)), key=lambda i: (not concepts[i]["feasible"], -concepts[i]["score"]))
    for rank, i in enumerate(order):
        concepts[i]["rank"] = rank + 1
    names = {"money": "lowest 10-year cost", "people": "quietest at the boundary", "planet": "lowest net build carbon",
             "resources": "most room to grow on the least land"}
    for k in concepts:
        others = [o for o in concepts if o is not k]
        lead = [f for f in names if k["scores"][f] > max(o["scores"][f] for o in others) + 0.5]
        worst = min(names, key=lambda f: k["scores"][f])
        ties = [f for f in names if f not in lead and k["scores"][f] >= max(o["scores"][f] for o in others) - 0.5]
        k["advantage"] = (names[lead[0]].capitalize() + " of the three.") if lead else \
            (f"Matches the best concept on {', '.join(ties)}; leads on none." if ties else "Does not lead on any factor.")
        weak = {"money": "ten-year cost", "people": "generator noise", "planet": "build carbon", "resources": "land use and room to grow"}[worst]
        k["tradeoff"] = (f"Weakest on {weak}: {k['scores'][worst]:.0f} of 100 against the best concept."
                         if k["scores"][worst] < 99 else "No material weakness against the other two.")
