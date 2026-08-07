"""
pennyworth - Alfred's backend.

Minimal starting point: reads the proxy's JSON-lines log file and exposes
it over a small HTTP API for the frontend (manor) to consume.

This is intentionally bare - endpoints/filters/pagination/etc. to be
built out once the actual requirements are discussed.
"""

import json
import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

LOG_FILE = Path(os.environ.get("LOG_FILE", "/data/calls.log"))

app = FastAPI(title="pennyworth")

# Permissive CORS for now since the frontend runs on a different port -
# tighten this once we know the real deployment shape.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/calls")
def list_calls(limit: int = 50):
    """
    Returns the most recent `limit` logged calls, newest first.
    """
    if not LOG_FILE.exists():
        return []

    lines = LOG_FILE.read_text(encoding="utf-8", errors="replace").splitlines()
    recent = lines[-limit:]
    recent.reverse()

    calls = []
    for line in recent:
        line = line.strip()
        if not line:
            continue
        try:
            calls.append(json.loads(line))
        except json.JSONDecodeError:
            continue

    return calls
