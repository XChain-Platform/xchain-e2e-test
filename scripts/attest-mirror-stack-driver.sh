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
build_hub=${repo_root}/../xchain-hub
mixed_root=${stack_dir}/bf6-mixed/${stack}
bf6_leg=test/attestMirror/barrier_family/bf6_producer_follower_parity.test.js

case "$phase" in
    up)
        "${ATTEST_MIRROR_STACK_ROOT}/setup-stack.sh" "$number" "$base"
        if [ "$leg" = "$bf6_leg" ]; then
            "$node_bin" "${repo_root}/scripts/prepare-bf6-mixed-hub.js" create \
                --workspace "$stack_dir" --stack "$stack" --build-hub "$build_hub"
        fi
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
    seed)
        "${ATTEST_MIRROR_STACK_ROOT}/run-leg.sh" "${stack}-seed" "$number" "$venue_base" \
            test/tools/reseedAttestationRoster.test.js \
            EXPLORER_API_PORT="${ATTEST_MIRROR_EXPLORER_PORT:-46599}" E2E_STAKE_TEARDOWN=off
        ;;
    run)
        if [ "$leg" = "$bf6_leg" ]; then
            "${ATTEST_MIRROR_STACK_ROOT}/run-leg.sh" "$stack" "$number" "$venue_base" "$leg" \
                EXPLORER_API_PORT="${ATTEST_MIRROR_EXPLORER_PORT:-46599}" E2E_STAKE_TEARDOWN=off \
                BF6_MIXED_HUB_ROOT="$mixed_root"
        else
            "${ATTEST_MIRROR_STACK_ROOT}/run-leg.sh" "$stack" "$number" "$venue_base" "$leg" \
                EXPLORER_API_PORT="${ATTEST_MIRROR_EXPLORER_PORT:-46599}" E2E_STAKE_TEARDOWN=off
        fi
        ;;
    down)
        down_status=0
        if [ -f "${stack_dir}/compose.yml" ]; then
            docker compose -p "$project" -f "${stack_dir}/compose.yml" down -v || down_status=$?
        fi
        if [ "$leg" = "$bf6_leg" ]; then
            "$node_bin" "${repo_root}/scripts/prepare-bf6-mixed-hub.js" remove \
                --workspace "$stack_dir" --stack "$stack" || down_status=$?
        fi
        test -z "$(docker ps -aq --filter "label=com.docker.compose.project=${project}")" || down_status=$?
        test -z "$(docker volume ls -q --filter "label=com.docker.compose.project=${project}")" || down_status=$?
        test -z "$(docker network ls -q --filter "label=com.docker.compose.project=${project}")" || down_status=$?
        exit "$down_status"
        ;;
    *)
        printf 'unknown driver phase: %s\n' "$phase" >&2
        exit 2
        ;;
esac
