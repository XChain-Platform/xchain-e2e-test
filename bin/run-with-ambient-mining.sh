#!/usr/bin/env bash
#
# Run a command against an isolated regtest stack with the ambient mining the shared
# rail has and a fresh stack lacks: one BTC block and one DOGE block every 20 seconds
# from the stack's own miners. The bridge rail drives are written against that cadence,
# and the stack's miners only mine when their mempool holds a transaction.
#
# Each loop skips its block while its pause file exists, the same flag files the drives
# write around spans that must not move a tip (BRIDGE_RAIL_MINER_PAUSE_FILE for BTC,
# BRIDGE_RAIL_DOGE_MINER_PAUSE_FILE for DOGE). Both must name files outside the shared
# rail's flag directory, so a stack run can never pause the shared rail's loops.
#
#   env REGTEST_MINER_API_PORT=<btc miner> DOGE_REGTEST_MINER_API_PORT=<doge miner> \
#       BRIDGE_RAIL_MINER_PAUSE_FILE=<file> BRIDGE_RAIL_DOGE_MINER_PAUSE_FILE=<file> \
#       bin/run-with-ambient-mining.sh <command>...
#
# The loops are this script's own children; it signals them by the pids it recorded
# when the command exits, and returns the command's exit code.
set -u

: "${REGTEST_MINER_API_PORT:?BTC miner port}" "${DOGE_REGTEST_MINER_API_PORT:?DOGE miner port}"
: "${BRIDGE_RAIL_MINER_PAUSE_FILE:?BTC pause file}" "${BRIDGE_RAIL_DOGE_MINER_PAUSE_FILE:?DOGE pause file}"
[ "$#" -gt 0 ] || { echo "run-with-ambient-mining: no command given" >&2; exit 2; }

INTERVAL_S="${AMBIENT_MINING_INTERVAL_S:-20}"

mine_loop() { # $1 miner port, $2 pause file
    while true; do
        if [ ! -e "$2" ]; then
            curl -s -m 10 -X POST -H 'Content-Type: application/json' \
                -d '{"jsonrpc":"2.0","id":1,"method":"generate_blocks","params":{"count":1}}' \
                "http://127.0.0.1:$1/" > /dev/null 2>&1
        fi
        sleep "$INTERVAL_S"
    done
}

mine_loop "$REGTEST_MINER_API_PORT" "$BRIDGE_RAIL_MINER_PAUSE_FILE" &
btc_loop=$!
mine_loop "$DOGE_REGTEST_MINER_API_PORT" "$BRIDGE_RAIL_DOGE_MINER_PAUSE_FILE" &
doge_loop=$!
trap 'kill "$btc_loop" "$doge_loop" 2> /dev/null' EXIT

"$@"
