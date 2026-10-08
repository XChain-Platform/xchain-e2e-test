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
 * looking once at the end. assertHoldsThroughout() is the same window for any
 * predicate, for absence claims outside the PBFT suites.
 *
 * waitFor() is the one polling loop; waitUntil() is its throwing general form,
 * and the sweep off fixed settles in other suites converts onto those two
 * rather than growing a second poll engine per suite. waitFor reports a
 * timeout as data (for a caller whose own assertion is the loud one);
 * waitUntil raises it.
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

/**
 * Poll `predicate` until it holds, and THROW when the deadline passes.
 *
 * The general form of the two throwing waits below, for callers outside the
 * PBFT suites that have a condition to wait on but no domain wrapper for it.
 * waitFor() reports a timeout as data, which is right for a caller that then
 * asserts on the observation; a caller with no such assertion needs the
 * timeout to be loud, because a poll that cannot fail converts a flaky test
 * into one that passes unconditionally, which says less than the flake did.
 *
 * The bound is the caller's: convert a fixed settle at the SAME budget the
 * settle spent. A converted site that needs a bigger bound is a finding about
 * that test, not a knob to turn here.
 *
 * @param predicate () => boolean | {ok:boolean, saw?:any} | Promise of either.
 *                  The object form carries what it last saw into the message.
 * @param opts      {timeoutMs, intervalMs, now, what} - `what` names the
 *                  condition in the give-up message and is effectively required
 *                  (a timeout that cannot say what it waited for is a puzzle).
 * @returns {ok, waitedMs, last}
 */
async function waitUntil(predicate, opts) {
    opts = opts || {};
    const what = opts.what || 'an unnamed condition';
    const res  = await waitFor(async () => {
        const seen = await predicate();
        // A bare boolean and a probe object are both accepted; normalising here
        // keeps every call site from having to spell `{ ok: ... }`.
        return (seen && typeof seen === 'object')
            ? { ok: !!seen.ok, saw: seen.saw }
            : { ok: !!seen, saw: undefined };
    }, opts);
    if (!res.ok) {
        const saw = res.last && res.last.saw;
        throw new Error('waitUntil: ' + what + ' was still not true after ' + res.waitedMs + 'ms'
            + (saw === undefined ? '' : '; last saw ' + JSON.stringify(saw)));
    }
    return res;
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
        catch (internal) { cfg = null; }
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

/**
 * Watch `predicate` for `windowMs` and throw the moment it stops holding.
 *
 * The general form of assertNeverApplied() for any absence claim: the window
 * stays fixed, but a violation fails at that instant and says what it saw.
 *
 * @param predicate () => boolean | {ok:boolean, saw?:any} | Promise of either
 * @param opts      {windowMs (required), intervalMs, now, what}
 * @returns {ok, watchedMs, polls, last}
 */
async function assertHoldsThroughout(predicate, opts) {
    opts = opts || {};
    // A missing window would never elapse, so refuse it rather than spin forever.
    if (!Number.isFinite(opts.windowMs)) throw new Error('assertHoldsThroughout: windowMs is required');
    const intervalMs = opts.intervalMs === undefined ? DEFAULT_INTERVAL_MS : opts.intervalMs;
    const now = opts.now || Date.now;
    const started = now();
    let polls = 0;

    for (;;) {
        const seen = await predicate();
        polls++;
        const last = (seen && typeof seen === 'object') ? { ok: !!seen.ok, saw: seen.saw } : { ok: !!seen, saw: undefined };
        const elapsed = now() - started;
        if (!last.ok) throw holdBroke(opts.what, elapsed, last.saw);
        if (elapsed >= opts.windowMs) return { ok: true, watchedMs: elapsed, polls: polls, last: last };
        await sleep(Math.max(0, Math.min(intervalMs, opts.windowMs - elapsed)));
    }
}

// Build the failure for a broken hold, naming the condition and what was seen.
function holdBroke(what, elapsed, saw) {
    return new Error('assertHoldsThroughout: ' + (what || 'an unnamed condition') + ' stopped holding after '
        + elapsed + 'ms' + (saw === undefined ? '' : '; saw ' + JSON.stringify(saw)));
}

// The wire timestamp an oracle leader must carry once the round time gate is
// active: followers drop a PROPOSE whose time differs from the round's nominal
// second, so a suite that drives finalizeRound by hand passes this value.
function nominalOracleRoundTime(oracleConsensus, round) {
    const { epochStart, roundInterval } = oracleConsensus.oracleRound;
    return Math.floor((epochStart + round * roundInterval) / 1000);
}

module.exports = {
    WS_OPEN,
    nominalOracleRoundTime,
    sleep,
    waitFor,
    waitUntil,
    openPeerCount,
    meshState,
    waitForMesh,
    readConfigEverywhere,
    waitForConfigEverywhere,
    assertNeverApplied,
    assertHoldsThroughout
};
