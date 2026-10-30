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

mine_loop() { # $1 coin label, $2 miner port, $3 pause file, $4 miner API key (empty when unkeyed)
    local args out rc status body
    args=(-s -m 10 -w '\n%{http_code}' -X POST -H 'Content-Type: application/json'
        -d '{"jsonrpc":"2.0","id":1,"method":"generate_blocks","params":{"count":1}}')
    # Read the key header from stdin so the key never shows in the process list.
    if [ -n "$4" ]; then args+=(-H @-); fi
    while true; do
        if [ ! -e "$3" ]; then
            out=$(curl "${args[@]}" "http://127.0.0.1:$2/" <<< "x-api-key: $4")
            rc=$?
            status=${out##*$'\n'}
            body=${out%$'\n'*}
            # Log every mine that did not land (transport, non-2xx, or an error member) and keep looping.
            if [ "$rc" -ne 0 ]; then
                echo "run-with-ambient-mining: $1 mine failed: curl exit $rc" >&2
            elif [ "${status#2}" = "$status" ] || [ "${#status}" -ne 3 ]; then
                echo "run-with-ambient-mining: $1 mine refused (http $status): ${body:0:300}" >&2
            elif [[ "$body" == *'"error"'* ]]; then
                echo "run-with-ambient-mining: $1 mine refused: ${body:0:300}" >&2
            fi
        fi
        sleep "$INTERVAL_S"
    done
}

# Resolve each miner's key as the repo's other miner clients do: <CODE>_MINER_API_KEY, then MINER_API_KEY.
mine_loop BTC "$REGTEST_MINER_API_PORT" "$BRIDGE_RAIL_MINER_PAUSE_FILE" "${BTC_MINER_API_KEY:-${MINER_API_KEY:-}}" &
btc_loop=$!
mine_loop DOGE "$DOGE_REGTEST_MINER_API_PORT" "$BRIDGE_RAIL_DOGE_MINER_PAUSE_FILE" "${DOGE_MINER_API_KEY:-${MINER_API_KEY:-}}" &
doge_loop=$!
trap 'kill "$btc_loop" "$doge_loop" 2> /dev/null' EXIT

"$@"
