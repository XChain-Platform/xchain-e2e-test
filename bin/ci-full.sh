#!/usr/bin/env bash
#*********************************************************************
#
# Copyright © 2025-2026 Dankest, LLC
# Based on XChain Platform by Dankest, LLC - https://dankest.llc
#
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# This file is part of XChain Platform. Licensed under the GNU Affero
# General Public License v3.0 or later; see LICENSE.md. A commercial
# license (without AGPL source-disclosure terms) is available -
# contact legal@dankest.llc.
#
#*********************************************************************

#
# bin/ci-full.sh: run every full-sweep tier or the selected fast tiers.
#
# .github/workflows/ci.yml fans this repo out as three parallel jobs (unit,
# live-tier, drift-guards). The pre-push venue gate used to run only
# `npm run ci`, so a push could gate green locally and then go red on GitHub on
# a job the gate never ran (2026-08-15: exactly that, on three repos at once).
# This script IS the local twin of the workflow: every job's run-steps,
# transcribed, in job order. When ci.yml gains or changes a job, change this
# script in the same commit.
#
# Layout: siblings resolve at ../<repo>, which is both the platform monorepo
# layout and the venue gate's work/ layout (.ci-siblings ships them there). A
# sibling a GitHub job checks out is REQUIRED here: missing means fail loud,
# never skip, because GitHub will run the step this gate would be skipping.
# That matters twice over in this repo: several cross-repo guards call
# this.skip() when a sibling is absent, so an undeclared sibling turns a guard
# into a green no-op (see .ci-siblings and test/unit/sibling-coverage.test.js).
#
# Database: none is configured here on purpose. The live tier obtains its own
# throwaway MariaDB through Docker exactly as the workflow does, and the
# workflow unsets HUB_DB_* to force that path, so this script unsets them too.
# A venue without a container runtime is a venue that cannot run the tier, and
# it says so and fails rather than letting every live suite skip itself.
#
# Steps of ci.yml that are NOT transcribed, because they are GitHub
# bookkeeping rather than test work:
#   - actions/checkout of this repo and of xchain-hub / xchain-indexer: the
#     sibling layout below IS that checkout, enforced by need_sib.
#   - actions/setup-node (Node 22): the venue supplies the runtime (.nvmrc
#     pins 22 for a hand run).
#   - "Install dependencies (both/all three trees)": the venue gate installs
#     this repo's deps and, for every .ci-siblings entry, runs `npm ci` into a
#     per-sibling cache it symlinks into the sibling tree, which is the same
#     guarantee the workflow's install loop provides (the hub tree resolving
#     its own `ws` and `mariadb`). A hand run needs node_modules present in
#     ../xchain-hub and ../xchain-indexer for the same reason.
# Full sweeps skip no ci.yml work; fast runs name every deferred tier.
#
# The last two tiers are LOCAL-ONLY additions rather than transcriptions, and
# are marked as such: they are the part of `npm run ci` (the command this gate
# ran before ci:full) that no GitHub job runs, because GitHub would need five
# more sibling deploy keys to run it. Replacing the gate command without them
# would have quietly shrunk the gate. They cost seconds plus the parity
# suites; ci:live is not repeated here, it is the live-tier job above.
#
# All tiers run even after one fails (GitHub reports every red job, so this
# reports every red tier); the exit code is red if any tier was.
#
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
SELF="$(pwd)"
SIB="$(cd .. && pwd)"

FAILED=""
run_tier() {
  local name="$1"; shift
  echo; echo "ci:full ===== $name ====="
  if "$@"; then
    echo "ci:full ----- $name PASS"
  else
    FAILED="$FAILED [$name]"
    echo "ci:full ----- $name FAIL"
  fi
}
fast_defer() {
  local name="$1"
  DEFERRED="${DEFERRED:-} [$name]"
  echo "ci:full ===== $name DEFERRED (CI_TIER=fast, runs in the full sweep) ====="
}
need_sib() {
  local s
  for s in "$@"; do
    if [ ! -d "$SIB/$s" ]; then
      echo "ci:full: MISSING SIBLING $SIB/$s" >&2
      echo "ci:full: GitHub CI checks this sibling out and runs steps against it," >&2
      echo "ci:full: so skipping here would gate green on a subset. Declare it in" >&2
      echo "ci:full: .ci-siblings (venue) or clone it beside this repo (hand run)." >&2
      exit 1
    fi
  done
}

# Checked out by the workflow's jobs.
need_sib xchain-hub xchain-indexer
# Needed by the local-only parity tier at the end (the five vendored-constant
# references `npm run ci` covers and GitHub does not).
need_sib xchain-documentation xchain-explorer xchain-sdk xchain-sync
# The rest of the .ci-siblings roster. The unit and parity tiers below run with
# XCHAIN_REQUIRE_SIBLINGS=1, under which test/unit/sibling-coverage.test.js fails
# on ANY declared sibling that is missing, so name them here and fail up front
# with the reason rather than as a red unit tier.
need_sib xchain-contracts xchain-decoder xchain-encoder xchain-vm \
  xchain-utxo-tracker xchain-regtest-miner xchain-wallet

# The full sweep's live-tier job self-provisions its database through Docker.
# Probe full runs up front so a venue without Docker fails in its own words.
if [ "${CI_TIER:-}" != "fast" ]; then
  docker info >/dev/null 2>&1 || { echo "ci:full: VENUE LACKS DOCKER for live-tier (npm run ci:live); pin a docker venue with CI_VENUES=..."; exit 1; }
fi

FAST_SELECTOR_READY=0
FAST_SELECTOR_CONSENSUS=1
if [ "${CI_TIER:-}" = "fast" ]; then
  if [ ! -f bin/ci_fast_select.js ]; then
    FAST_SELECTOR_WHY="helper missing"
  else
    FAST_PLAN_OUTPUT="$(node bin/ci_fast_select.js --plan 2>&1)"
    FAST_PLAN_STATUS=$?
    [ -z "$FAST_PLAN_OUTPUT" ] || printf '%s\n' "$FAST_PLAN_OUTPUT"
    if [ "$FAST_PLAN_STATUS" -ne 0 ]; then
      FAST_SELECTOR_WHY="${FAST_PLAN_OUTPUT##*$'\n'}"
      [ -n "$FAST_SELECTOR_WHY" ] || FAST_SELECTOR_WHY="exit status $FAST_PLAN_STATUS"
    elif [ "${FAST_PLAN_OUTPUT%%$'\n'*}" = "consensus 0" ]; then
      FAST_SELECTOR_READY=1
      FAST_SELECTOR_CONSENSUS=0
    elif [ "${FAST_PLAN_OUTPUT%%$'\n'*}" = "consensus 1" ]; then
      FAST_SELECTOR_READY=1
    else
      FAST_SELECTOR_WHY="invalid plan output"
    fi
  fi
  if [ "$FAST_SELECTOR_READY" -ne 1 ]; then
    echo "ci:full: fast selector unavailable ($FAST_SELECTOR_WHY); running the full unit tier"
  fi
fi

# --- job: unit -------------------------------------------------------------
# Full and consensus runs use the hermetic unit glob; narrow fast runs use the
# selector's mapped unit files. A handful skip for want of CI-only inputs.
# XCHAIN_REQUIRE_SIBLINGS=1 turns every cross-repo guard's "sibling absent, skip"
# into a failure, so a sibling-reading unit suite can never gate green by skip.
# This is stricter than the workflow's unit job, which checks out only hub and
# indexer; the venue lays the full .ci-siblings roster, so it can afford it.
if [ "${CI_TIER:-}" = "fast" ] && [ "$FAST_SELECTOR_READY" -eq 1 ] && [ "$FAST_SELECTOR_CONSENSUS" -eq 0 ]; then
  run_tier "unit (changed tests, siblings required)" \
    env XCHAIN_REQUIRE_SIBLINGS=1 node bin/ci_fast_select.js --run
  fast_defer "unit (test:unit, siblings required)"
else
  run_tier "unit (test:unit, siblings required)" \
    env XCHAIN_REQUIRE_SIBLINGS=1 npm run test:unit
fi

# --- job: live-tier --------------------------------------------------------
# Full runs call scripts/run-live-tier.js over test/integration/live-tier.json.
# HUB_DB_* stays unset so the fixture uses Docker instead of external credentials.
if [ "${CI_TIER:-}" = "fast" ]; then
  fast_defer "live-tier (ci:live)"
else
  run_tier "live-tier (ci:live)" \
    env -u HUB_DB_HOST -u HUB_DB_USER -u HUB_DB_PASS -u HUB_DB_NAME -u HUB_DB_PORT \
    npm run ci:live
fi

# --- job: drift-guards -----------------------------------------------------
# Run FROM the parent so sync-coins.sh sees the canonical + vendored pair the
# way the workflow lays them out (hub checkout beside this repo's checkout).
sync_coins_check() { (cd "$SIB" && "xchain-hub/bin/sync-coins.sh" --check --only "$(basename "$SELF")"); }
run_tier "drift: coin-registry byte-identity" sync_coins_check
run_tier "drift: coin consensus-pin conformance" node -e '
  const coins = require("./src/coins");
  for (const net of ["testnet", "regtest"]) {
    const res = coins.verifyConsensusPin(net);
    if (res && res.skipped) throw new Error("consensus pin unexpectedly unarmed for " + net);
  }
  console.log("consensus pin conformance OK (testnet, regtest)");
'

# --- local-only: the rest of `npm run ci` (no GitHub job runs these) --------
# ci.yml's own header says why: the parity suites read vendored consensus
# constants out of five more siblings, which would be five more deploy-key
# secrets. The venue has all five, so the gate keeps covering them.
run_tier "local: sleep-flake lint (lint:sleep-flake)" npm run lint:sleep-flake
run_tier "local: cross-repo parity suites (siblings required)" \
  env XCHAIN_REQUIRE_SIBLINGS=1 \
  ./node_modules/.bin/mocha --no-config --timeout 30000 --exit 'test/integration/parity/**/*.test.js'

echo
if [ "${CI_TIER:-}" = "fast" ]; then
  echo "ci:full: tier class fast"
  echo "ci:full: DEFERRED to the full sweep:$DEFERRED"
fi
if [ -n "$FAILED" ]; then
  echo "ci:full: RED tiers:$FAILED"
  exit 1
fi
if [ "${CI_TIER:-}" = "fast" ]; then
  echo "ci:full: all FAST tiers green; the DEFERRED tiers above were NOT graded here"
else
  echo "ci:full: all tiers green (same set GitHub CI runs, plus the local-only tail)"
fi
