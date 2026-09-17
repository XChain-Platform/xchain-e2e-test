#!/usr/bin/env bash
set -eu

phase=$1
shift
stack=
slot=
leg=
while [ "$#" -gt 0 ]; do
    case "$1" in
        --stack) stack=$2; shift 2 ;;
        --slot) slot=$2; shift 2 ;;
        --leg) leg=$2; shift 2 ;;
        --require) shift 2 ;;
        *) printf 'unknown driver argument: %s\n' "$1" >&2; exit 2 ;;
    esac
done

: "${ATTEST_MIRROR_STACK_ROOT:?ATTEST_MIRROR_STACK_ROOT is required}"
: "${stack:?--stack is required}"
: "${slot:?--slot is required}"
: "${leg:?--leg is required}"

prefix=${ATTEST_MIRROR_STACK_PREFIX:-xca7}
number=$((slot + 1))
project=${prefix}${number}
base=$(( ${ATTEST_MIRROR_PORT_BASE:-62100} + (slot * 100) ))
venue_base=$(( ${ATTEST_MIRROR_VENUE_PORT_BASE:-63400} + (slot * 100) ))
stack_dir=${ATTEST_MIRROR_STACK_ROOT}/${project}
node_bin=${ATTEST_MIRROR_NODE_BIN:-node}
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

case "$phase" in
    up)
        "${ATTEST_MIRROR_STACK_ROOT}/setup-stack.sh" "$number" "$base"
        ;;
    ready)
        set -a
        . "${stack_dir}/.env"
        set +a
        export BTC_INDEXER_API_PORT=$INDEXER_HOST_PORT
        export BTC_INDEXER_DB_NAME=XChain_BTC_Regtest_Indexer
        export BTC_REGTEST_MINER_API_PORT=$MINER_HOST_PORT
        export LTC_REGTEST_MINER_API_PORT=$LTC_MINER_HOST_PORT
        export DOGE_REGTEST_MINER_API_PORT=$DOGE_MINER_HOST_PORT
        "$node_bin" "${repo_root}/scripts/wait-attest-mirror-stack.js"
        ;;
    run)
        "${ATTEST_MIRROR_STACK_ROOT}/run-leg.sh" "$stack" "$number" "$venue_base" "$leg" \
            EXPLORER_API_PORT="${ATTEST_MIRROR_EXPLORER_PORT:-46599}" E2E_STAKE_TEARDOWN=off
        ;;
    down)
        if [ -f "${stack_dir}/compose.yml" ]; then
            docker compose -p "$project" -f "${stack_dir}/compose.yml" down -v
        fi
        test -z "$(docker ps -aq --filter "label=com.docker.compose.project=${project}")"
        test -z "$(docker volume ls -q --filter "label=com.docker.compose.project=${project}")"
        test -z "$(docker network ls -q --filter "label=com.docker.compose.project=${project}")"
        ;;
    *)
        printf 'unknown driver phase: %s\n' "$phase" >&2
        exit 2
        ;;
esac
