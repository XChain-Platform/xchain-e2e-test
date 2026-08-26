#!/usr/bin/env bash
#
# Copyright (c) 2025-2026 Dankest, LLC
# Based on XChain Platform by Dankest, LLC - https://dankest.llc
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# ---------------------------------------------------------------------------
# Provision the SECOND indexer node the BET two-node parity drill needs
# (xchain-e2e-test/test/sdk/betParity.sdk.test.js, spec sec.12 E8).
#
# Runs ON the venue host, not the development machine: it drives docker and the
# stack's own MariaDB container.
#
#   bash scripts/bet-parity-node.sh up      # clone-forward + launch node B
#   bash scripts/bet-parity-node.sh status  # both tips, side by side
#   bash scripts/bet-parity-node.sh logs
#   bash scripts/bet-parity-node.sh down    # stop node B, keep its database
#
# WHY CLONE-FORWARD RATHER THAN GENESIS REPLAY: regtest runs every gate
# genesis-active, so this chain's history was CREATED gates-on and re-indexing
# it from block 0 mis-decodes it (proven 2026-07-07; see the
# drill-clone-forward-venue-recipe memory). Node B therefore inherits a
# consistent snapshot of node A's database at whatever tip it has and indexes
# only NEW blocks - which is all the parity drill needs, since it compares the
# blocks the bet lifecycle lands in.
#
# WHY THE DATABASE NAME IS A "Drill" ONE: the per-coin indexer account has
# USAGE on *.* plus ALL PRIVILEGES on a fixed set of schemas (the standing
# indexer DB and the three drill DBs left behind by the flag-day drill).
# Creating a brand-new schema name would need an admin grant, so this reuses
# the already-granted XChain_BTC_DrillB_Indexer rather than asking for root.
#
# SAFETY, AND THE ONE THING THAT MUST NOT BE "HARDENED": node B only ever
# writes its OWN indexer database, and publishes no host port. But it keeps the
# FULL environment of node A, HUB_API_URL included, and that is load-bearing
# rather than lax. The hub is the config oracle: the indexer resolves its hub DB
# handle (and therefore the fee oracle prices) plus its consensus config through
# `getallconfigs`. A node B launched without HUB_API_URL silently falls back to
# its LOCAL database for price_snapshots, finds none, and rejects every
# native-fee-priced action the source accepted - which is a genuine state
# divergence caused purely by misconfiguring the follower. That happened on the
# first build of this script and cost a re-clone: node B rejected an ISSUE with
# "no current oracle price for BTC/USD" at the exact block the two nodes first
# disagreed on. A second node is only a parity test if it is configured like the
# first one.
#
# The cost of that is that node B behaves as a full peer: it pushes chain tips
# and PRICE rounds to the hub the way any indexer does. On a regtest venue that
# is tolerable (the hub dedupes rounds, and the tip push is skipped while a node
# is catching up), but it is the reason node B is meant to be torn down with
# `down` once the drill has run rather than left resident.
#
# Secrets never reach the terminal: credentials are read straight out of the
# source container's environment into a 0600 client file inside the database
# container and a 0600 env-file on the venue host, and are never echoed.
# ---------------------------------------------------------------------------

set -euo pipefail

SRC_CONTAINER=${SRC_CONTAINER:-xchain-node-bitcoin-regtest-xchain-indexer}
DB_CONTAINER=${DB_CONTAINER:-xchain-node-database}
NETWORK=${NETWORK:-xchain-node-bitcoin-regtest}
PARITY_CONTAINER=${PARITY_CONTAINER:-xchain-bet-parity-indexer}
PARITY_DB=${PARITY_DB:-XChain_BTC_DrillB_Indexer}
WORK=${WORK:-$HOME/bet-parity}
CNF=/tmp/bet-parity-client.cnf

SRC_DB=$(docker exec "$SRC_CONTAINER" printenv INDEXER_DB_NAME)

# Write a 0600 client options file inside the database container, sourced from
# the live indexer's own environment. Nothing is printed.
write_client_cnf() {
    local u p
    u=$(docker exec "$SRC_CONTAINER" printenv INDEXER_DB_USER)
    p=$(docker exec "$SRC_CONTAINER" printenv INDEXER_DB_PASS)
    printf '[client]\nuser=%s\npassword=%s\n' "$u" "$p" \
        | docker exec -i "$DB_CONTAINER" sh -c "umask 077; cat > $CNF"
}

sql() {
    docker exec "$DB_CONTAINER" sh -c \
        "mariadb --defaults-extra-file=$CNF -h 127.0.0.1 -N -e \"$1\""
}

tip_of() {
    sql "SELECT COALESCE(MAX(block_index), -1) FROM \\\`$1\\\`.blocks" 2>/dev/null || echo "?"
}

cmd_up() {
    mkdir -p "$WORK"
    write_client_cnf

    echo "== cloning $SRC_DB -> $PARITY_DB (consistent snapshot, node A keeps running)"
    sql "DROP DATABASE IF EXISTS \\\`$PARITY_DB\\\`; CREATE DATABASE \\\`$PARITY_DB\\\`;"
    docker exec "$DB_CONTAINER" sh -c \
        "mariadb-dump --defaults-extra-file=$CNF -h 127.0.0.1 --single-transaction --quick \
          --skip-lock-tables --routines --events --triggers $SRC_DB" \
        | docker exec -i "$DB_CONTAINER" sh -c \
            "mariadb --defaults-extra-file=$CNF -h 127.0.0.1 $PARITY_DB"
    echo "   node A tip $(tip_of "$SRC_DB") / node B clone tip $(tip_of "$PARITY_DB")"

    echo "== env-file for node B (0600, never printed)"
    # Node A's environment verbatim, with ONLY the database redirected. Dropping
    # anything else here diverges the two nodes by configuration (see the header).
    ( umask 077
      docker exec "$SRC_CONTAINER" printenv \
        | grep -vE '^(HOME|HOSTNAME|PATH|INDEXER_DB_NAME)=' > "$WORK/env.parity"
      echo "INDEXER_DB_NAME=$PARITY_DB" >> "$WORK/env.parity" )

    echo "== creating $PARITY_CONTAINER from node A's image + node A's live src/"
    local image
    image=$(docker inspect -f '{{.Config.Image}}' "$SRC_CONTAINER")
    docker rm -f "$PARITY_CONTAINER" >/dev/null 2>&1 || true
    docker create --name "$PARITY_CONTAINER" --network "$NETWORK" \
        --env-file "$WORK/env.parity" "$image" >/dev/null
    # Copy node A's RUNNING source tree in, not the image's: the P4 BET indexer
    # was hand-deployed into the live container and is not baked into the image.
    # Parity between two nodes only means anything if both run the same bytes.
    docker exec "$SRC_CONTAINER" tar -C /XChainIndexer -cf - src \
        | docker cp - "$PARITY_CONTAINER:/XChainIndexer"
    docker start "$PARITY_CONTAINER" >/dev/null

    echo "== code identity check"
    # Hash the WHOLE src tree, as a sorted per-file manifest of path + content. Two
    # reasons this is not a *.js filter over concatenated bytes any more:
    #   - the filter skipped the 185 files under src/sql/ (per-table DDL) and
    #     src/sql/migrations/ that xchain-indexer's db.js loads at startup, so the
    #     two nodes could be running different table schemas and still pass;
    #   - `xargs cat | sha256sum` hashes contents only, so a rename, a move or a
    #     file split between the trees produced an identical digest.
    # Unfiltered find + per-file manifest is the convention the platform's other
    # tree-identity gates already use (xchain-indexer/bin/vendor-vm.sh:84).
    # Paths are relative to /XChainIndexer so the manifest compares across containers.
    local a b na nb
    local hash_cmd='cd /XChainIndexer && find src -type f | LC_ALL=C sort | xargs sha256sum | sha256sum'
    local count_cmd='cd /XChainIndexer && find src -type f | wc -l'
    # An empty (or missing) tree hashes identically on BOTH sides, so a vacuous gate
    # is indistinguishable from a passing one. Refuse rather than report parity.
    na=$(docker exec "$SRC_CONTAINER" sh -c "$count_cmd" | tr -cd '0-9')
    nb=$(docker exec "$PARITY_CONTAINER" sh -c "$count_cmd" | tr -cd '0-9')
    if [ "${na:-0}" -lt 1 ] || [ "${nb:-0}" -lt 1 ]; then
        echo "   REFUSING: src files node A=${na:-0} node B=${nb:-0}; an empty tree passes any digest comparison" >&2
        exit 1
    fi
    a=$(docker exec "$SRC_CONTAINER" sh -c "$hash_cmd" | cut -d' ' -f1)
    b=$(docker exec "$PARITY_CONTAINER" sh -c "$hash_cmd" | cut -d' ' -f1)
    if [ "$a" != "$b" ]; then
        echo "   MISMATCH: node A src $a ($na files) != node B src $b ($nb files)" >&2
        exit 1
    fi
    echo "   both nodes run src sha256 ${a:0:16}... ($na files, .sql schema included)"

    docker exec "$DB_CONTAINER" rm -f "$CNF" || true
    echo "== node B is up; give it a minute to catch up, then:"
    echo "   BET_PARITY_DB_NAME=$PARITY_DB npm run test:sdk:bet-parity   (from the Mac)"
}

cmd_status() {
    write_client_cnf
    echo "node A ($SRC_DB): tip $(tip_of "$SRC_DB")"
    echo "node B ($PARITY_DB): tip $(tip_of "$PARITY_DB")"
    docker exec "$DB_CONTAINER" rm -f "$CNF" || true
    docker ps --filter "name=$PARITY_CONTAINER" --format '{{.Names}} {{.Status}}'
}

cmd_logs() { docker logs --tail "${2:-40}" "$PARITY_CONTAINER"; }

cmd_down() {
    docker rm -f "$PARITY_CONTAINER" >/dev/null 2>&1 || true
    echo "node B removed; $PARITY_DB left in place (re-run 'up' to re-clone)"
}

case "${1:-}" in
    up)     cmd_up ;;
    status) cmd_status ;;
    logs)   cmd_logs "$@" ;;
    down)   cmd_down ;;
    *) echo "usage: $0 up|status|logs|down" >&2; exit 2 ;;
esac
