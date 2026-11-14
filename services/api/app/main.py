"""PlotStar API (FastAPI). Run: uvicorn app.main:app --reload --port 8000"""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import config
from .db import db_ready
from .routers import data, integrations, projects, sites


@asynccontextmanager
async def lifespan(_: FastAPI):
    projects.init()
    integrations.init()
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


for r in (sites.router, data.router, projects.router, integrations.router):
    app.include_router(r)
