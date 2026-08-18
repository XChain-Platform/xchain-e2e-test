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
 * Deterministic waits for the in-process MultiValidatorHub PBFT suites.
 *
 * Bracketing a consensus round with fixed sleeps is a bet on how busy the
 * venue is, and it loses intermittently. Both conditions below are directly
 * observable, so this file polls for them instead of guessing an interval:
 *
 *   MESH. PeerManager.peers holds an entry from the moment a dial STARTS
 *   (state 'connecting', ws null), so the peers.size check the suites use is
 *   true well before the socket is usable. Readiness is the count of peers
 *   whose socket is actually OPEN. This matters more in a weighted federation
 *   than a count one: a whale can carry the stake threshold on its own, so a
 *   round can finalize while a small hub is still dialling, and that hub then
 *   never sees the round at all. No later poll can recover it, which is why the
 *   mesh wait has to be a real barrier rather than a longer sleep.
 *
 *   APPLY. Each hub writes the config to its own DB when its own COMMIT tally
 *   meets quorum, so "every hub applied" is a query, not an interval. The
 *   leader's propose() resolves on ITS tally, which is necessarily before the
 *   followers finish, so the wait after it is pure slack.
 *
 * The negative direction (a round that must NOT finalize) still needs a fixed
 * observation window - non-occurrence has no event to wait for - but it is
 * spent polling, so it fails at the first hub that applies instead of only
 * looking once at the end.
 *
 * Every wait here polls inside a loop and returns early, which is also the
 * shape scripts/check-sleep-flake.js exempts from its fixed-settle ratchet.
 ********************************************************************/

'use strict';

// ws.readyState for an open socket. Hard-coded rather than requiring `ws` so a
// helper used by every hub suite pulls in no transport dependency of its own.
const WS_OPEN = 1;

const DEFAULT_INTERVAL_MS = 100;
const DEFAULT_TIMEOUT_MS  = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll `probe` until it reports ok, or the deadline passes.
 *
 * @param probe  () => {ok:boolean, ...} | Promise of same. Extra fields are
 *               carried through to the caller so a failure can describe what it
 *               last saw rather than just that it timed out.
 * @param opts   {timeoutMs, intervalMs, now} (`now` is injectable for tests)
 * @returns {ok, waitedMs, last}
 */
async function waitFor(probe, opts) {
    opts = opts || {};
    const timeoutMs  = opts.timeoutMs  === undefined ? DEFAULT_TIMEOUT_MS  : opts.timeoutMs;
    const intervalMs = opts.intervalMs === undefined ? DEFAULT_INTERVAL_MS : opts.intervalMs;
    const now        = opts.now || Date.now;
    const started    = now();

    for (;;) {
        const last = await probe();
        if (last && last.ok) return { ok: true, waitedMs: now() - started, last: last };
        const elapsed = now() - started;
        if (elapsed >= timeoutMs) return { ok: false, waitedMs: elapsed, last: last };
        await sleep(Math.max(0, Math.min(intervalMs, timeoutMs - elapsed)));
    }
}

// Peers of `hub` whose socket is OPEN. A 'connecting' entry counts for nothing:
// it is exactly the state the old peers.size check mistook for a live mesh.
function openPeerCount(hub) {
    const pm = hub && hub.peerManager;
    if (!pm || !pm.peers) return 0;
    let open = 0;
    for (const [, peer] of pm.peers) {
        if (peer && peer.ws && peer.ws.readyState === WS_OPEN) open++;
    }
    return open;
}

/**
 * Is the in-process mesh fully formed? Every hub must hold an OPEN socket to
 * every other hub and have a consensus engine attached.
 *
 * @returns {ok, expected, counts, missingConsensus}
 */
function meshState(mvh) {
    const hubs     = (mvh && mvh.hubs) || [];
    const expected = Math.max(0, hubs.length - 1);
    const counts   = hubs.map(openPeerCount);
    const missingConsensus = [];
    hubs.forEach((h, i) => { if (!h || !h.consensus) missingConsensus.push(i); });
    return {
        ok: hubs.length > 0 && missingConsensus.length === 0 && counts.every((c) => c >= expected),
        expected: expected,
        counts: counts,
        missingConsensus: missingConsensus
    };
}

/**
 * Block until every hub is peered with every other hub. Throws (rather than
 * returning false) because every caller's next step is a consensus round that
 * cannot be interpreted over a half-formed mesh.
 */
async function waitForMesh(mvh, opts) {
    const res = await waitFor(() => meshState(mvh), opts);
    if (!res.ok) {
        const s = res.last || {};
        throw new Error('MultiValidatorHub mesh never formed within ' + res.waitedMs + 'ms: each hub should hold '
            + s.expected + ' open peer(s), saw [' + (s.counts || []).join(', ') + ']'
            + (s.missingConsensus && s.missingConsensus.length
                ? '; no consensus engine on hub(s) ' + s.missingConsensus.join(', ') : ''));
    }
    return res;
}

// Read one config key from every hub's own DB. Missing rows and read errors
// both read as undefined: the caller only ever asks "does it equal the value
// consensus should have written".
async function readConfigEverywhere(hubs, sel) {
    const seen = [];
    for (const hub of hubs) {
        let cfg = null;
        try { cfg = await hub.db.getConfig(sel.coin, sel.network, sel.module); }
        catch (_) { cfg = null; }
        seen.push(cfg ? cfg[sel.key] : undefined);
    }
    return seen;
}

/**
 * Block until EVERY hub has the expected config value in its own DB.
 *
 * @param hubs  hub instances (mvh.hubs)
 * @param sel   {coin, network, module, key, value}
 * @param opts  {timeoutMs, intervalMs}
 */
async function waitForConfigEverywhere(hubs, sel, opts) {
    const res = await waitFor(async () => {
        const seen = await readConfigEverywhere(hubs, sel);
        return { ok: seen.length > 0 && seen.every((v) => v === sel.value), seen: seen };
    }, opts);
    if (!res.ok) {
        const seen = (res.last && res.last.seen) || [];
        const laggards = seen.map((v, i) => (v === sel.value ? null : i)).filter((i) => i !== null);
        throw new Error('hub(s) ' + laggards.join(', ') + ' did not apply the PBFT config change within '
            + res.waitedMs + 'ms: expected ' + sel.module + '.' + sel.key + ' = ' + JSON.stringify(sel.value)
            + ' on every hub, saw [' + seen.map((v) => JSON.stringify(v)).join(', ') + ']');
    }
    return res;
}

/**
 * Watch for `windowMs` and throw the moment ANY hub applies the config.
 *
 * Non-occurrence is the one thing a poll cannot shorten, so the window is
 * fixed; polling it still buys two things over sleeping through it: a hub that
 * applies at 200ms fails the test at 200ms with the hub named, and the claim
 * becomes "no hub held it at any point in the window" instead of "no hub held
 * it at one instant".
 */
async function assertNeverApplied(hubs, sel, opts) {
    opts = opts || {};
    const windowMs  = opts.windowMs  === undefined ? 6000 : opts.windowMs;
    const intervalMs = opts.intervalMs === undefined ? DEFAULT_INTERVAL_MS : opts.intervalMs;
    const now = opts.now || Date.now;
    const started = now();
    let polls = 0;

    for (;;) {
        const seen = await readConfigEverywhere(hubs, sel);
        polls++;
        const offender = seen.findIndex((v) => v === sel.value);
        if (offender !== -1) {
            throw new Error('hub ' + offender + ' applied a config that should never finalize ('
                + sel.module + '.' + sel.key + ' = ' + JSON.stringify(sel.value) + ') after '
                + (now() - started) + 'ms; saw [' + seen.map((v) => JSON.stringify(v)).join(', ') + ']');
        }
        const elapsed = now() - started;
        if (elapsed >= windowMs) return { ok: true, watchedMs: elapsed, polls: polls, seen: seen };
        await sleep(Math.max(0, Math.min(intervalMs, windowMs - elapsed)));
    }
}

module.exports = {
    WS_OPEN,
    sleep,
    waitFor,
    openPeerCount,
    meshState,
    waitForMesh,
    readConfigEverywhere,
    waitForConfigEverywhere,
    assertNeverApplied
};
