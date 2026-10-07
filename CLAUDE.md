@AGENTS.md

# Setup

Every checkout needs a `.venv`: the checks in AGENTS.md run `.venv/bin/python`. If it's missing, run `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`. Run the build graph with `.venv/bin/python`.
