/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XCALL drill support: plan a QUORUM DROP over a live relay federation.
 *
 * A drill that needs "the relay cannot dispatch" used to express that as
 * `docker stop <the hub>`. On a single-hub stack that is the same thing; on a
 * federation it is not, and the difference is silent: the surviving hubs still
 * hold quorum, the call dispatches, and the drill either times out or (worse)
 * reports a green it never earned. .
 *
 * This module turns "drop below quorum" into an explicit, checkable plan:
 * given the live cross_chain stake-weight snapshot (the source indexer's
 * getstakeweightsbycapability answer) and the set of federation members this
 * venue can actually stop, it names the smallest set of containers to stop so
 * that the SURVIVING members can satisfy neither the count quorum nor the
 * stake-weighted threshold, and it FAILS LOUD when the venue makes that
 * impossible rather than letting a drill run against a live quorum.
 *
 * Stopping the fewest, heaviest members is deliberate: it leaves the maximum
 * number of hubs running as under-quorum witnesses, so the drill proves the
 * source indexer synthesizes its outcome with a LIVE federation that merely
 * cannot agree, which is a stronger claim than one made against a dead one.
 *
 * Pure functions, no I/O: the drill does the RPC and the docker calls. That
 * keeps the arithmetic testable without a venue (xcallFederationPlan.sdk.test.js).
 *
 ********************************************************************/

'use strict';

// Container names are handed to docker as argv (execFileSync, never a shell),
// but a name is still operator-supplied env, so pin it to the character set
// docker itself allows and reject anything else at parse time.
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const PUBKEY         = /^[0-9a-f]{64}$/;

// Fixed-point scale for stake weights. The snapshot carries decimal strings
// ('5000.00000000'); the 2/3 test is a STRICT inequality that a federation with
// equal stakes sits exactly on (3 * 2S/3 == 2S, which must NOT pass), so the
// comparison runs on BigInt units and never on a JS double.
const SCALE_DECIMALS = 18;
const SCALE          = 10n ** BigInt(SCALE_DECIMALS);

// Decimal string -> BigInt units. Fails closed on anything non-numeric or
// negative, mirroring stake_weighted_quorum's posture: a weight that cannot be
// read must never be quietly treated as zero, because zeroing it shrinks S and
// lowers the very bar the plan is measuring against.
function toUnits(value) {
    const s = (value === null || value === undefined) ? '' : String(value).trim();
    if (!/^[0-9]+(\.[0-9]+)?$/.test(s))
        throw new Error('xcallFederationPlan: unreadable stake weight "' + s + '"');
    const [whole, frac = ''] = s.split('.');
    if (frac.length > SCALE_DECIMALS)
        throw new Error('xcallFederationPlan: stake weight "' + s + '" carries more than ' + SCALE_DECIMALS + ' decimals');
    return BigInt(whole) * SCALE + BigInt((frac + '0'.repeat(SCALE_DECIMALS)).slice(0, SCALE_DECIMALS));
}

// Majority-floored Byzantine quorum, the count half of the threshold.
// MIRRORS xchain-hub/src/lib/bft_quorum.js (max(2f+1, ceil((n+1)/2))). The hub
// copy is the consensus authority; this one only sizes a drill's stop-set, and
// the drill still asserts the real outcome against the live system rather than
// trusting the arithmetic here.
function bftQuorum(n) {
    return Math.max(2 * Math.floor((n - 1) / 3) + 1, Math.ceil((n + 1) / 2));
}

function countQuorumFor(n) {
    return (n <= 1) ? 1 : bftQuorum(n);
}

// The stake half: 3 * signing-source stake > 2 * S, source-deduped.
// MIRRORS stake_weighted_quorum.meetsStakeThreshold for the one shape a drill
// needs (which sources are alive). S <= 0 fails closed, same as there.
function meetsStakeThreshold(surviving, total) {
    if (total <= 0n) return false;
    return 3n * surviving > 2n * total;
}

/**
 * Parse the federation's STOPPABLE members out of the environment.
 *
 * Grammar (XCALL_HUB_CONTAINERS): comma-separated `container` or
 * `container=<64-hex pubkey>`. The pubkey is what lets the planner attribute
 * stake to a container; a member declared without one can still be stopped but
 * contributes nothing the plan can reason about, so it is reported as
 * unattributed rather than silently counted.
 *
 * Members that CANNOT be stopped (test-host runs relay hub 1 as a host process,
 * not a container) are simply absent from this list: the planner learns they
 * exist from the snapshot and treats their stake as permanently surviving.
 *
 * Legacy fallback, so existing venue wrappers keep working: XCALL_HUB_CONTAINER
 * plus XCALL_HUB2_CONTAINER / XCALL_HUB3_CONTAINER (the names the quorum drill
 * already uses). XCALL_HUB_PUBKEY is paired with XCALL_HUB_CONTAINER only on a
 * genuine single-hub stack, where the two are the same hub; on a federation the
 * staked pubkey in that var is frequently hub 1, which is not that container.
 *
 * @param {object} env process.env (or a stand-in)
 * @returns {{members: Array<{container: string, pubkey: (string|null)}>, source: string}}
 */
function parseFederationSpec(env) {
    const e = env || {};
    const raw = String(e.XCALL_HUB_CONTAINERS || '').trim();
    let entries = [];
    let source  = 'XCALL_HUB_CONTAINERS';

    if (raw) {
        entries = raw.split(',').map(s => s.trim()).filter(Boolean).map(part => {
            const [container, pubkey] = part.split('=').map(s => (s || '').trim());
            return { container, pubkey: pubkey ? pubkey.toLowerCase() : null };
        });
    } else {
        source = 'XCALL_HUB_CONTAINER (legacy)';
        const hub1 = String(e.XCALL_HUB_CONTAINER || 'xchain-node-xchain-hub').trim();
        const hub2 = String(e.XCALL_HUB2_CONTAINER || '').trim();
        const hub3 = String(e.XCALL_HUB3_CONTAINER || '').trim();
        const solo = !hub2 && !hub3;
        const pk   = String(e.XCALL_HUB_PUBKEY || '').trim().toLowerCase();
        entries.push({ container: hub1, pubkey: (solo && PUBKEY.test(pk)) ? pk : null });
        if (hub2) entries.push({ container: hub2, pubkey: null });
        if (hub3) entries.push({ container: hub3, pubkey: null });
    }

    const seen = new Set();
    for (const m of entries) {
        if (!CONTAINER_NAME.test(m.container))
            throw new Error('xcallFederationPlan: "' + m.container + '" is not a usable container name (' + source + ')');
        if (m.pubkey !== null && !PUBKEY.test(m.pubkey))
            throw new Error('xcallFederationPlan: "' + m.pubkey + '" is not a 64-hex validator pubkey (' + source + ')');
        if (seen.has(m.container))
            throw new Error('xcallFederationPlan: container "' + m.container + '" is listed twice (' + source + ')');
        seen.add(m.container);
    }
    if (!entries.length)
        throw new Error('xcallFederationPlan: no federation members declared (' + source + ')');
    return { members: entries, source };
}

/**
 * Reduce a stake-weight snapshot to its source-deduped federation view.
 *
 * @param {Array<{pubkey: string, source: string, weight: string}>} snapshot
 * @returns {{n: number, total: bigint, weightBySource: Map<string, bigint>, sourceByPubkey: Map<string, string>}}
 */
function summarizeSnapshot(snapshot) {
    const rows = snapshot || [];
    if (rows.truncated === true)
        throw new Error('xcallFederationPlan: the stake snapshot is TRUNCATED, so no quorum drop can be planned from it');
    const weightBySource  = new Map();
    const sourceByPubkey  = new Map();
    for (const row of rows) {
        if (!row || row.source === null || row.source === undefined || String(row.source).trim() === '')
            throw new Error('xcallFederationPlan: a snapshot row has no staking source');
        const src = String(row.source);
        sourceByPubkey.set(String(row.pubkey).toLowerCase(), src);
        if (!weightBySource.has(src)) weightBySource.set(src, toUnits(row.weight));
    }
    let total = 0n;
    for (const w of weightBySource.values()) total += w;
    return { n: weightBySource.size, total, weightBySource, sourceByPubkey };
}

/**
 * Name the containers to stop so the surviving federation can neither reach the
 * count quorum nor clear the stake-weighted threshold.
 *
 * Both halves must fail, not either: a dispatch needs both, so breaking one
 * would be enough for the protocol but not enough for a drill that has to be
 * certain WHY nothing moved.
 *
 * @param {object} args
 * @param {Array} args.snapshot   getstakeweightsbycapability('cross_chain').validators
 * @param {Array} args.stoppable  parseFederationSpec().members
 * @returns {{n: number, countQuorum: number, stop: string[], keepRunning: string[],
 *            survivingSources: number, unattributed: string[], witnesses: number,
 *            unstoppableSources: number}}
 */
function planQuorumDrop({ snapshot, stoppable }) {
    const { n, total, weightBySource, sourceByPubkey } = summarizeSnapshot(snapshot);
    if (n === 0)
        throw new Error('xcallFederationPlan: the source indexer reports no active cross_chain validators; '
            + 'stake the federation first (test/sdk/xcallStakeValidators.js)');
    const countQuorum = countQuorumFor(n);

    // Attribute each stoppable container to a staking source. A container whose
    // pubkey is absent from the snapshot is not a qualifying validator on this
    // venue, so stopping it removes no stake; say so instead of counting it.
    const members      = (stoppable || []).map(m => ({ ...m }));
    const unattributed = [];
    const bySource     = new Map();   // source -> containers that carry it
    for (const m of members) {
        const src = m.pubkey ? sourceByPubkey.get(m.pubkey) : undefined;
        if (!src) { unattributed.push(m.container); continue; }
        m.stakeSource = src;
        if (!bySource.has(src)) bySource.set(src, []);
        bySource.get(src).push(m.container);
    }

    // Heaviest source first (name-ascending tiebreak, so the plan is the same on
    // every run and every host): removing the most stake per stop leaves the most
    // hubs alive to witness that a live-but-split federation still cannot act.
    const candidates = [...bySource.keys()].sort((a, b) => {
        const wa = weightBySource.get(a), wb = weightBySource.get(b);
        if (wa !== wb) return wa > wb ? -1 : 1;
        return a < b ? -1 : 1;
    });

    const stoppedSources = new Set();
    const stop           = [];
    const canStillAct = () => {
        const survivingCount  = n - stoppedSources.size;
        let   survivingWeight = 0n;
        for (const [src, w] of weightBySource) if (!stoppedSources.has(src)) survivingWeight += w;
        return survivingCount >= countQuorum || meetsStakeThreshold(survivingWeight, total);
    };

    for (const src of candidates) {
        if (!canStillAct()) break;
        stoppedSources.add(src);
        for (const c of bySource.get(src)) stop.push(c);
    }

    if (canStillAct()) {
        // Every stoppable member is already down and the rest of the federation
        // still holds quorum. That is a VENUE fact, not a flaky run, so name it
        // with the numbers the operator needs to fix it.
        const unstoppable = n - bySource.size;
        throw new Error('xcallFederationPlan: cannot drop this federation below quorum. '
            + n + ' staked source(s), quorum ' + countQuorum + ', but only ' + bySource.size
            + ' are stoppable from here (' + unstoppable + ' unstoppable'
            + (unattributed.length ? ', ' + unattributed.length + ' container(s) unattributed: ' + unattributed.join(', ') : '')
            + '). Declare the missing members in XCALL_HUB_CONTAINERS as container=pubkey.');
    }

    const keepRunning = members.filter(m => !stop.includes(m.container)).map(m => m.container);
    return {
        n,
        countQuorum,
        stop,
        keepRunning,
        survivingSources:   n - stoppedSources.size,
        unattributed,
        unstoppableSources: n - bySource.size,
        witnesses:          (n - stoppedSources.size),
    };
}

module.exports = {
    bftQuorum,
    countQuorumFor,
    meetsStakeThreshold,
    toUnits,
    parseFederationSpec,
    summarizeSnapshot,
    planQuorumDrop,
};
