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
        # Clear the slot before filling it. setup-stack.sh mints a fresh random root
        # password into the stack's .env on every boot, but MariaDB honours
        # MARIADB_ROOT_PASSWORD only while the datadir is empty. So a db-data volume that
        # outlives its stack leaves the datadir on the OLD password, db-init's one client
        # call is refused with ERROR 1045, and the whole `up` dies. Two things leave one
        # behind: a lane killed before it reaches the down phase (a machine reboot did
        # exactly this on 2026-09-18), and a `down -v` that skips a volume another
        # container still holds ("Resource is still in use"). Booting over a survivor is
        # not recoverable downstream, so `up` owns the cleanup rather than trusting the
        # previous `down` to have finished.
        if [ -f "${stack_dir}/compose.yml" ]; then
            docker compose -p "$project" -f "${stack_dir}/compose.yml" down -v --remove-orphans >&2 || true
        fi
        # `down -v` is best effort, so sweep by project label and retry: a volume is
        # released only once the last container holding it is actually gone.
        attempt=0
        while [ "$attempt" -lt 10 ]; do
            leftover_containers=$(docker ps -aq --filter "label=com.docker.compose.project=${project}")
            if [ -n "$leftover_containers" ]; then
                # Unquoted on purpose: this is a whitespace-separated id list, and the
                # -n guard above is what keeps the command from running with no argument.
                docker rm -f $leftover_containers >&2 || true
            fi
            leftover_volumes=$(docker volume ls -q --filter "label=com.docker.compose.project=${project}")
            if [ -z "$leftover_volumes" ]; then
                break
            fi
            docker volume rm $leftover_volumes >&2 || true
            attempt=$((attempt + 1))
            sleep 2
        done
        # Fail loudly rather than boot onto a stale datadir: a silent pass here becomes an
        # ERROR 1045 forty seconds later that reads like a rail capacity problem.
        leftover_volumes=$(docker volume ls -q --filter "label=com.docker.compose.project=${project}")
        if [ -n "$leftover_volumes" ]; then
            printf 'stack slot %s still holds volumes after cleanup; refusing to boot over them\n' "$project" >&2
            exit 1
        fi
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
