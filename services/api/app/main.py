"""PlotStar API (FastAPI). Run: uvicorn app.main:app --reload --port 8000"""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import config, external
from .db import db_ready
from .routers import voice
from .routers import agent, data, integrations, livegrid, optimize, projects, screen, sites, vexcel
from . import livegrid as livegrid_state
from . import optimizer as optimizer_mod


@asynccontextmanager
async def lifespan(_: FastAPI):
    projects.init()
    integrations.init()
    external.init()
    screen.init()
    optimizer_mod.init()
    livegrid_state.init()
    yield


app = FastAPI(title=f"{config.PRODUCT_NAME} API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health", tags=["meta"])
def health() -> dict:
    return {"status": "ok", "product": config.PRODUCT_NAME, "parcel_store_ready": db_ready()}


# screen.router first so /sites/candidates is not captured by /sites/{parcel_id}
for r in (screen.router, sites.router, data.router, projects.router, integrations.router, vexcel.router,
          optimize.router, livegrid.router, agent.router, voice.router):
    app.include_router(r)
