'use strict'

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { SNAPSHOT_COMPARE_KEYS } = require('./replay_naming')

// ---------------------------------------------------------------------------
// Comparing two nodes
// ---------------------------------------------------------------------------

function snapshotKey(row) {
    return String(row.round_number) + '|' + String(row.coin_pair);
}

/**
 * Compare two `price_snapshots` sets on exactly SNAPSHOT_COMPARE_KEYS.
 *
 * Returns { matched, missing, extra, mismatched }, where `missing` is a row the
 * live node holds and the replaying node does not (the failure AT2 is really
 * about) and `mismatched` names the column that differs rather than dumping two
 * rows for a reader to diff by eye.
 */
function diffSnapshots(live, replay) {
    const liveByKey   = new Map(live.map((r) => [snapshotKey(r), r]));
    const replayByKey = new Map(replay.map((r) => [snapshotKey(r), r]));
    const out = { matched: [], missing: [], extra: [], mismatched: [] };
    for (const [key, l] of liveByKey) {
        const r = replayByKey.get(key);
        if (!r) { out.missing.push(l); continue; }
        const differing = SNAPSHOT_COMPARE_KEYS.filter((c) => String(l[c]) !== String(r[c]));
        if (differing.length > 0) out.mismatched.push({ key: key, columns: differing, live: l, replay: r });
        else out.matched.push(key);
    }
    for (const [key, r] of replayByKey) if (!liveByKey.has(key)) out.extra.push(r);
    return out;
}

// The chain coordinate inside a verdict key ('table@block:tx:vout').
function coordOf(key) { return String(key).slice(String(key).indexOf('@') + 1); }

/**
 * Compare two verdict maps.
 *
 * `feeCoordinates` narrows the comparison to the half AT2 names, the one that
 * proves fee validation is chain-time rather than arrival-time. Pass the set
 * readFeeCoordinates returned from a node with a complete price history;
 * `onlyFeeBearing` is the weaker local form, useful only when both sides are
 * known to have charged their fees.
 */
function diffVerdicts(live, replay, opts) {
    opts = opts || {};
    const keep = (key, v) => {
        if (opts.feeCoordinates) return opts.feeCoordinates.has(coordOf(key));
        if (opts.onlyFeeBearing) return !!v.feeBearing;
        return true;
    };
    const out = { compared: 0, agreed: 0, disagreed: [], missing: [], extra: [] };
    for (const [key, l] of live) {
        if (!keep(key, l)) continue;
        out.compared++;
        const r = replay.get(key);
        if (!r) { out.missing.push({ key: key, live: l }); continue; }
        if (r.status === l.status) out.agreed++;
        else out.disagreed.push({ key: key, action: l.action, blockIndex: l.blockIndex, live: l.status, replay: r.status });
    }
    for (const [key, r] of replay) {
        if (!keep(key, r)) continue;
        if (!live.has(key)) out.extra.push({ key: key, replay: r });
    }
    return out;
}

module.exports = { diffSnapshots, diffVerdicts }
