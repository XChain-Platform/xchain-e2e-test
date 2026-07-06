#!/usr/bin/env bash
# DOGE-regtest federation runner for the ANCHOR election+publish suite on test-host
# (isolated soak-e2e clone). Stack secrets + indexer DB creds sourced from the
# dogecoin container env at runtime (never echoed). Hub driver DBs use the
# disposable root MariaDB on 127.0.0.1:13307 (see anchor-dbprov.sh).
set -euo pipefail
export PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH"

CT=xchain-node-dogecoin-regtest-xchain-encoder
geti(){ docker inspect "$CT" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -m1 "^$1=" | cut -d= -f2- || true; }

# --- stack + indexer DB secrets (sourced at runtime, not printed) ---
export NODE_USER="$(geti NODE_USER)"
export NODE_PASSWORD="$(geti NODE_PASSWORD)"
export INDEXER_DB_NAME="$(geti INDEXER_DB_NAME)"
export INDEXER_DB_USER="$(geti INDEXER_DB_USER)"
export INDEXER_DB_PASS="$(geti INDEXER_DB_PASS)"
IK="$(geti INDEXER_API_KEY)"; [ -n "$IK" ] && export INDEXER_API_KEY="$IK"

# --- coin/network ---
export COIN=dogecoin NETWORK=regtest

# --- host-reachable endpoints (published DOGE container ports) ---
export NODE_URL=127.0.0.1 NODE_PORT=3120
export UTXO_TRACKER_URL=127.0.0.1 UTXO_TRACKER_API_PORT=3121
export DECODER_URL=127.0.0.1 DECODER_API_PORT=3122
export ENCODER_URL=127.0.0.1 ENCODER_API_PORT=3123
export INDEXER_URL=127.0.0.1 INDEXER_API_PORT=3124
export REGTEST_MINER_URL=127.0.0.1 REGTEST_MINER_API_PORT=3125
export EXPLORER_URL=127.0.0.1 EXPLORER_API_PORT=18080 EXPLORER_PORT=18080
export HUB_URL=127.0.0.1 HUB_PORT=10000

# --- stack indexer DB (anchor_actions setup) on the docker0 gateway ---
export DATABASE_URL=172.17.0.1 DATABASE_PORT=3306

# --- hub driver DBs: disposable root MariaDB ---
export HUB_DB_HOST=127.0.0.1 HUB_DB_PORT=13307 HUB_DB_USER=root
export HUB_DB_PASS="$(cat "$HOME/.anchor-mvh-db.pass")"

# --- in-process federation knobs ---
export XCHAIN_HUB_PATH="$HOME/xchain-modules-src/soak-e2e/xchain-hub"
export P2P_MAX_CONNECTIONS_PER_IP=64

cd "$HOME/xchain-modules-src/soak-e2e"
exec npx mocha --timeout 0 --exit --require ./test/initialCheck.test.js "$@"
