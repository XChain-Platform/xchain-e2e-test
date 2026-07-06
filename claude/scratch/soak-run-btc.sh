#!/usr/bin/env bash
# BTC-regtest SDK e2e runner for test-host (isolated soak-e2e clone).
# Sources stack secrets from the running container env at runtime; never echoes
# them. Maps internal service URLs/ports to the host-published 302x ports.
set -euo pipefail
export PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH"

CT=xchain-node-bitcoin-regtest-xchain-encoder
geti() { docker inspect "$CT" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -m1 "^$1=" | cut -d= -f2- || true; }

# --- secrets, sourced at runtime (not printed) ---
export NODE_USER="$(geti NODE_USER)"
export NODE_PASSWORD="$(geti NODE_PASSWORD)"
export INDEXER_DB_NAME="$(geti INDEXER_DB_NAME)"
export INDEXER_DB_USER="$(geti INDEXER_DB_USER)"
export INDEXER_DB_PASS="$(geti INDEXER_DB_PASS)"
IK="$(geti INDEXER_API_KEY)"; [ -n "$IK" ] && export INDEXER_API_KEY="$IK"

# --- coin/network ---
export COIN=bitcoin NETWORK=regtest

# --- host-reachable endpoints (published container ports) ---
export NODE_URL=127.0.0.1 NODE_PORT=3020
export UTXO_TRACKER_URL=127.0.0.1 UTXO_TRACKER_API_PORT=3021
export DECODER_URL=127.0.0.1 DECODER_API_PORT=3022
export ENCODER_URL=127.0.0.1 ENCODER_API_PORT=3023
export INDEXER_URL=127.0.0.1 INDEXER_API_PORT=3024
export REGTEST_MINER_URL=127.0.0.1 REGTEST_MINER_API_PORT=3025
export EXPLORER_URL=127.0.0.1 EXPLORER_API_PORT=18080 EXPLORER_PORT=18080
export HUB_URL=127.0.0.1 HUB_PORT=10000

# --- DB (native MariaDB on the docker0 gateway) ---
export DATABASE_URL=172.17.0.1 DATABASE_PORT=3306

cd "$HOME/xchain-modules-src/soak-e2e"
exec npx mocha --timeout 0 --exit --require ./test/initialCheck.test.js "$@"
