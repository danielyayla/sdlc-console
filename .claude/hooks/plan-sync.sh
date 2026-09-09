#!/usr/bin/env sh
# Installed by sdlc init. Thin wrapper: the decision lives in @sdlc/core (check.planSync).
# Exit 2 blocks the action and the message reaches the agent; every decision is logged to the change ledger.
if command -v sdlc >/dev/null 2>&1; then exec sdlc hook plan-sync; fi
exec node "${SDLC_BIN:-/Users/danielkapper/Projects/sdlc-console/packages/cli/dist/bin.js}" hook plan-sync
