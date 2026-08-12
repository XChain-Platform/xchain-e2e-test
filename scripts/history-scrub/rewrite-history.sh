#!/usr/bin/env bash
#
# Copyright © 2025–2026 Dankest, LLC
# Based on XChain Platform by Dankest, LLC - https://dankest.llc
#
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# This file is part of XChain Platform. Licensed under the GNU Affero
# General Public License v3.0 or later; see LICENSE.md. A commercial
# license (without AGPL source-disclosure terms) is available -
# contact legal@dankest.llc.
#
# ---------------------------------------------------------------------------
# : purge leaked developer-machine paths from git history, pre-flip.
#
# This script REHEARSES the rewrite. It never pushes, and it never rewrites a
# repository you already have: it mirror-clones the source into a throwaway
# directory, rewrites THAT, and verifies the result. The force-push that makes
# the rewrite real is a deliberate manual step, printed at the end and spelled
# out in claude/reports/launch/HISTORY-SCRUB-RUNBOOK.md in the platform repo.
#
# The rehearsal is the point of the script, not a limitation of it. A history
# rewrite changes every commit SHA from the earliest rewritten commit forward,
# so the run that matters is the one whose output you have already read.
#
# Usage:
#   scripts/history-scrub/rewrite-history.sh [--source <path|url>] [--out <dir>] [--keep]
#
#   --source  What to mirror-clone. Defaults to the `origin` URL of the repo
#             this script lives in, because origin is what the public actually
#             gets. Pass a local path for an offline rehearsal; the difference
#             is that a local clone drags in refs that were never pushed.
#   --out     Where to put the rewritten mirror. Defaults to a mktemp dir.
#   --keep    Do not delete the work directory on success (implied by --out).
#
# Env:
#   GIT_FILTER_REPO   Path to a git-filter-repo executable, if it is not on
#                     PATH and not installed as a git subcommand.
#
# Exit: 0 rewrite verified clean, 1 verification failed, 2 setup error.
# ---------------------------------------------------------------------------

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

SOURCE=""
OUT=""
KEEP=0

while [ $# -gt 0 ]; do
    case "$1" in
        --source) SOURCE="${2:-}"; shift 2 ;;
        --out)    OUT="${2:-}"; KEEP=1; shift 2 ;;
        --keep)   KEEP=1; shift ;;
        # Print the header comment block rather than a hand-maintained usage
        # string, so the two cannot drift apart.
        -h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "${BASH_SOURCE[0]}"; exit 0 ;;
        *) echo "rewrite-history: unknown argument: $1" >&2; exit 2 ;;
    esac
done

say() { printf '\n=== %s\n' "$*"; }
die() { printf 'rewrite-history: %s\n' "$*" >&2; exit 2; }

# --- locate git-filter-repo -------------------------------------------------
# Three installs are common and none of them is reliably present: the homebrew
# formula, `pip install git-filter-repo`, and the single-file script dropped
# somewhere on disk. Resolve all three rather than assuming one.
FILTER_REPO=""
if [ -n "${GIT_FILTER_REPO:-}" ]; then
    [ -x "${GIT_FILTER_REPO}" ] || die "GIT_FILTER_REPO is not executable: ${GIT_FILTER_REPO}"
    FILTER_REPO="${GIT_FILTER_REPO}"
elif command -v git-filter-repo >/dev/null 2>&1; then
    FILTER_REPO="$(command -v git-filter-repo)"
elif git filter-repo --version >/dev/null 2>&1; then
    FILTER_REPO="git-subcommand"
else
    die "git-filter-repo not found. Install it (brew install git-filter-repo,
    or pip3 install git-filter-repo), or set GIT_FILTER_REPO to the
    single-file script from https://github.com/newren/git-filter-repo."
fi

run_filter_repo() {
    if [ "${FILTER_REPO}" = "git-subcommand" ]; then
        git -C "${MIRROR}" filter-repo "$@"
    else
        # The single-file script needs an explicit interpreter only when it was
        # copied without its exec bit; being executable, it can be run directly,
        # but it must be told which repo to act on via cwd.
        ( cd "${MIRROR}" && "${FILTER_REPO}" "$@" )
    fi
}

# --- spec files -------------------------------------------------------------
PATHS_SPEC="${SCRIPT_DIR}/filter-repo-paths.txt"
TEXT_SPEC="${SCRIPT_DIR}/filter-repo-replace-text.txt"
MSG_SPEC="${SCRIPT_DIR}/filter-repo-replace-message.txt"
SCANNER="${SCRIPT_DIR}/scan-history.js"
for f in "${PATHS_SPEC}" "${TEXT_SPEC}" "${MSG_SPEC}" "${SCANNER}"; do
    [ -f "$f" ] || die "missing spec file: $f"
done

# The two replace specs are generated from leak-patterns.js. Regenerating here
# and diffing catches the case where someone edited a .txt by hand: the rewrite
# would then use patterns the detector does not know about, and the verification
# step at the end would pass while leaving a leak the detector cannot see.
say "checking spec files are in sync with leak-patterns.js"
SPEC_TMP="$(mktemp -d)"
trap 'rm -rf "${SPEC_TMP}"' EXIT
cp "${TEXT_SPEC}" "${MSG_SPEC}" "${SPEC_TMP}/"
node "${SCRIPT_DIR}/leak-patterns.js" --emit >/dev/null
if ! diff -q "${SPEC_TMP}/filter-repo-replace-text.txt" "${TEXT_SPEC}" >/dev/null \
   || ! diff -q "${SPEC_TMP}/filter-repo-replace-message.txt" "${MSG_SPEC}" >/dev/null; then
    die "spec files were stale and have now been regenerated from leak-patterns.js.
    Review the diff and re-run."
fi
echo "in sync"

# --- resolve source ---------------------------------------------------------
if [ -z "${SOURCE}" ]; then
    SOURCE="$(git -C "${REPO_ROOT}" remote get-url origin 2>/dev/null || true)"
    [ -n "${SOURCE}" ] || die "no origin remote; pass --source explicitly"
fi

if [ -z "${OUT}" ]; then
    OUT="$(mktemp -d -t xc287-scrub)"
fi
mkdir -p "${OUT}"
MIRROR="${OUT}/scrubbed.git"
if [ -e "${MIRROR}" ]; then die "already exists: ${MIRROR}"; fi

say " history scrub rehearsal"
echo "source:  ${SOURCE}"
echo "workdir: ${OUT}"
echo "filter:  ${FILTER_REPO}"

# --- before -----------------------------------------------------------------
say "mirror-cloning source"
# --mirror keeps every ref verbatim, which is what a rewrite has to cover: a
# leak surviving on one unmerged branch or one annotated tag is still public.
git clone --mirror --quiet "${SOURCE}" "${MIRROR}"

BEFORE_COMMITS="$(git -C "${MIRROR}" rev-list --all --count)"
BEFORE_SIZE="$(du -sk "${MIRROR}" | awk '{print $1}')"

say "scanning BEFORE"
# --all-refs here, unlike the standing gate. The gate scans published history
# because it runs in clones (CI venues) that hold scratch refs the project never
# published. This mirror is the artifact about to be force-pushed over the real
# remote, so every ref it carries IS about to become published history, and the
# right question is the paranoid one.
set +e
node "${SCANNER}" --all-refs "${MIRROR}" | tee "${OUT}/scan-before.txt"
BEFORE_STATUS=$?
set -e
if [ "${BEFORE_STATUS}" -eq 2 ]; then die "scanner errored on the source mirror"; fi
if [ "${BEFORE_STATUS}" -eq 0 ]; then
    say "source is ALREADY CLEAN"
    echo "Nothing to rewrite. If this is the pre-flip check,  is done."
    [ "${KEEP}" -eq 1 ] || rm -rf "${OUT}"
    exit 0
fi

# --- rewrite ----------------------------------------------------------------
say "running git-filter-repo"
# --force: the mirror was created seconds ago by this script, so filter-repo's
# fresh-clone heuristic has nothing to protect. Without it a mirror clone that
# carries packed-refs from the source trips the guard and the run aborts.
#
# --invert-paths turns the paths file into "keep everything EXCEPT these".
#
# Empty-commit pruning is filter-repo's default (--prune-empty=auto) and is
# wanted here: the commit that untracked the purged artifacts has no other
# content, so once those paths are gone it has nothing left to say.
run_filter_repo \
    --force \
    --invert-paths \
    --paths-from-file "${PATHS_SPEC}" \
    --replace-text "${TEXT_SPEC}" \
    --replace-message "${MSG_SPEC}"

AFTER_COMMITS="$(git -C "${MIRROR}" rev-list --all --count)"
AFTER_SIZE="$(du -sk "${MIRROR}" | awk '{print $1}')"

# --- after ------------------------------------------------------------------
say "scanning AFTER"
set +e
node "${SCANNER}" --all-refs "${MIRROR}" | tee "${OUT}/scan-after.txt"
AFTER_STATUS=$?
set -e

say "summary"
printf 'commits:  %s -> %s\n' "${BEFORE_COMMITS}" "${AFTER_COMMITS}"
printf 'size:     %s KB -> %s KB\n' "${BEFORE_SIZE}" "${AFTER_SIZE}"
printf 'commit-map: %s\n' "${MIRROR}/filter-repo/commit-map"
echo
echo "ref tips (old -> new):"
# ref-map is filter-repo's own record of where each ref moved. Reading it beats
# diffing rev-parse output because it also names refs that were deleted.
if [ -f "${MIRROR}/filter-repo/ref-map" ]; then
    awk '{printf "  %-40s %s -> %s\n", $3, substr($1,1,12), substr($2,1,12)}' "${MIRROR}/filter-repo/ref-map"
fi

if [ "${AFTER_STATUS}" -ne 0 ]; then
    say "FAILED"
    echo "The rewrite did not clean every leak. Do NOT push. See ${OUT}/scan-after.txt,"
    echo "add the missed shape to scripts/history-scrub/leak-patterns.js, re-emit, re-run."
    exit 1
fi

say "VERIFIED CLEAN"
cat <<EOF
The rewritten mirror is at:
  ${MIRROR}

Nothing has been pushed and the source repository is untouched. Publishing this
rewrite is a separate, deliberate act with consequences that cannot be undone by
another script: every commit SHA downstream of the earliest rewritten commit
changes, so every clone, every open branch, and every SHA cited in the platform
ledger or in a report stops resolving.

Do not run the following from here. Work through
claude/reports/launch/HISTORY-SCRUB-RUNBOOK.md, which covers the backup ref, the
collaborator freeze, the sibling repos that vendor this one, and the GitHub-side
cleanup that a force-push alone does not do:

  git -C ${MIRROR} push --force --mirror <origin-url>

EOF

if [ "${KEEP}" -eq 0 ]; then
    echo "(--keep not given, but the mirror is kept anyway: it is the artifact you just verified)"
fi
