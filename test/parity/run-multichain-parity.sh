#!/usr/bin/env bash
#######################################################################
#
# Copyright © 2025–2026 Dankest, LLC
# Based on XChain Platform by Dankest, LLC – https://dankest.llc
# SPDX-License-Identifier: AGPL-3.0-or-later
#
#######################################################################
# P3(b) — LIVE multi-chain parity sweep orchestrator.
#
# Brings up ONE coin's regtest stack at a time (memory-safe — the VM cannot
# hold three concurrent stacks), drives the parity corpus through the full
# live pipeline, captures a per-chain digest, tears the stack down, and
# repeats for the next coin. Finally compares the three digests with
# compare.js (Tier 1 hash-chain identity + Tier 2 structural parity).
#
# VENUE: the Ubuntu runtime VM (Docker + native ext4 for bitcoind data). The
# Parallels REDACTED-LOCAL-PATH share is DEAD (won't fix), so the code is rsync-staged
# (see the staged-tree recipe in memory vm-parallels-share-dead-2026-06-11).
# Run this from the staged tree's xchain-e2e-test/test/parity directory.
#
# This is a SCAFFOLD calibrated against the documented stack gotchas — expect
# to tune the install/teardown invocations live (the e2e venue recipes vary by
# box). Each command's rationale is the cited memory.
#
# Prereqs on the VM (all documented in memory):
#   - Node 22 exactly (mariadb ESM; isolated-vm).            [platform-unit-suites-need-node22]
#   - bitcoind data on native ext4, NOT the share:           [local-regtest-stack-gotchas #1]
#       export XCHAIN_NODE_DATA_DIR=REDACTED-LOCAL-PATH
#   - the xchain-node DB container started first:            [local-regtest-stack-gotchas #2]
#       docker start xchain-node-database
#   - DOGE regtest needs v1.14 mempool flags:                [dogecoin-v114-regtest-mempool-priority]
#   - install BEFORE the run; rm stale module clones.        [xchain-node-e2e-workflow-gotchas]
#
# Usage:
#   ./run-multichain-parity.sh [BTC LTC DOGE]      # default: all three
#
# Env knobs:
#   PARITY_OUT_DIR   where digests are written (default ~/parity-out)
#   PARITY_BASELINE  pinned baseline height (default 1000; raise if asserted)
#   XCHAIN_NODE_DIR  path to the staged xchain-node checkout
#   E2E_DIR          path to the staged xchain-e2e-test checkout (this repo)
#######################################################################
set -euo pipefail

COINS=("${@:-BTC LTC DOGE}")
# shellcheck disable=SC2206
COINS=(${COINS[@]})

PARITY_OUT_DIR="${PARITY_OUT_DIR:-$HOME/parity-out}"
PARITY_BASELINE="${PARITY_BASELINE:-1000}"
XCHAIN_NODE_DIR="${XCHAIN_NODE_DIR:-$HOME/parity-stage/XChain-Platform/xchain-node}"
E2E_DIR="${E2E_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"

mkdir -p "$PARITY_OUT_DIR"

# xchain-node coin keyword (install takes the long coin name).
coin_pkg() { case "$1" in
  BTC) echo bitcoin ;; LTC) echo litecoin ;; DOGE) echo dogecoin ;;
  *) echo "unknown coin $1" >&2; return 1 ;; esac; }

run_node() { ( cd "$XCHAIN_NODE_DIR" && node src/index.js "$@" ); }

for COIN in "${COINS[@]}"; do
  PKG="$(coin_pkg "$COIN")"
  echo "==================================================================="
  echo "[parity] $COIN  ($PKG-regtest) — bringing up stack"
  echo "==================================================================="

  # Clean any prior stack for this coin so the chain starts at genesis
  # (a fresh chain is REQUIRED: parity needs identical decoder start heights
  # and an empty ledger). 'remove' tears containers + data; tune per box.
  run_node remove master "$PKG" regtest || true

  # Install the stack. --no-explorer: the shared explorer crashes COIN=undefined
  # on a fresh empty hub [local-regtest-stack-gotchas #3]; the parity suite reads
  # the indexer DB directly and drives via the encoder, so no explorer is needed.
  run_node install master "$PKG" regtest --no-explorer --no-bootstrap

  # Give the decoder/indexer a moment to begin following the fresh chain.
  sleep 10

  echo "[parity] $COIN — driving corpus + capturing digest"
  # initialCheck discovers the live service endpoints from the hub config
  # [e2e-host-run-gotchas]; the parity suite needs only miner/tracker/node +
  # the indexer DB pool, all set up there.
  ( cd "$E2E_DIR" && \
    PARITY_OUT_DIR="$PARITY_OUT_DIR" PARITY_BASELINE="$PARITY_BASELINE" \
    COIN="$PKG" NETWORK="regtest" \
    ./node_modules/.bin/mocha --timeout 0 \
      --require ./test/initialCheck.test.js \
      test/parity/multichain-parity.test.js )

  echo "[parity] $COIN — tearing down"
  run_node remove master "$PKG" regtest || true
done

echo "==================================================================="
echo "[parity] comparing digests"
echo "==================================================================="
ARGS=()
for COIN in "${COINS[@]}"; do
  ARGS+=("$COIN=$PARITY_OUT_DIR/digest-$COIN.json")
done
node "$E2E_DIR/test/parity/compare.js" "${ARGS[@]}"
