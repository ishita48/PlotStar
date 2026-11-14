"""Atlas layer: the pure parts (schemas, embedding text, local fallback embedding). Live Atlas is exercised by scripts."""
from __future__ import annotations

import math

from app import atlas


def test_every_schema_is_a_valid_object_validator():
    for name, schema in atlas.SCHEMAS.items():
        assert schema["bsonType"] == "object", name
        assert set(schema["required"]) <= set(schema["properties"]), name
    assert atlas.SCHEMAS["sites"]["properties"]["loc"]["properties"]["type"]["enum"] == ["Point"]


def test_search_index_dimensions_match_the_embedder():
    for coll, name, typ, definition in atlas.SEARCH_INDEXES:
        if typ == "vectorSearch":
            vec = next(f for f in definition["fields"] if f["type"] == "vector")
            assert vec["numDimensions"] == atlas.EMBED_DIMS and vec["similarity"] == "cosine", name
    assert sum(1 for *_, t, _ in atlas.SEARCH_INDEXES if t == "vectorSearch") == 2  # free tier allows three in total


def test_site_and_project_text_carry_the_facts_a_vector_should_encode():
    s = atlas.site_text(dict(name="World Houston 46", address="5142 Greens Rd", market="Houston", property_type="Industrial",
                             property_subtype="Warehouse", lot_acres=26.6, building_sf=120000, land_cost=8.7e6,
                             screen_status="Pass", gates=[{"gate": "Flood exposure", "status": "Pass"}]))
    assert "World Houston 46" in s and "26.6 acres" in s and "Flood exposure Pass" in s
    p = atlas.project_text(dict(name="Houston 20 MW", mw_it=20, market="Houston", status="decided",
                                brief={"cooling": "liquid", "redundancy": "N+1", "storeys": 2},
                                summary={"concept": "Shared service bands", "capex": 2.4e8, "npv": -1.4e8}, site={"name": "Site"}))
    assert "liquid cooling" in p and "2 storeys" in p and "Shared service bands" in p


def test_local_embedding_is_unit_length_deterministic_and_discriminative():
    a, b = atlas._local_embed(["industrial lot near Greens Road Houston", "industrial lot near Greens Road Houston"])
    c = atlas._local_embed(["coastal office tower Los Angeles"])[0]
    assert len(a) == atlas.EMBED_DIMS and a == b
    assert math.isclose(math.sqrt(sum(x * x for x in a)), 1.0, abs_tol=1e-9)
    cos = lambda u, v: sum(x * y for x, y in zip(u, v))  # noqa: E731  (unit vectors)
    assert cos(a, b) > 0.999 and cos(a, c) < 0.3
