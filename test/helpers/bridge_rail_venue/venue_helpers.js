'use strict';

const assert = require('assert');
const { BRIDGE_CHAINS } = require('./constants');

function hubIndexerEnvMap(indexers, chain, overrides) {
    const code = String(chain || '').toUpperCase();
    assert.ok(BRIDGE_CHAINS.includes(code), 'hubIndexerEnvMap: unknown chain ' + chain);
    const out = {};
    for (const ix of indexers || []) {
        const hub = Number(ix && ix.followsHub);
        assert.ok(Number.isInteger(hub) && hub >= 0, 'hubIndexerEnvMap: an indexer record names no followed hub');
        assert.ok(!out[hub], 'hubIndexerEnvMap: two indexers follow hub ' + hub + ', so neither is that hub\'s own');
        out[hub] = { [code + '_INDEXER_URL']: String(ix.apiUrl) };
    }
    for (const key of Object.keys(overrides || {})) {
        out[Number(key)] = { [code + '_INDEXER_URL']: String(overrides[key]) };
    }
    return out;
}

/**
 * How many venue BTC indexers to stand up: one per hub unless the caller opted out or the
 * standing indexer serves the BTC side. PURE; see `hubIndexerEnvMap` for why one per hub.
 */
function venueBtcIndexerCount(hubCount, perHub, standingUrl) {
    const hubs = Number(hubCount);
    assert.ok(Number.isInteger(hubs) && hubs >= 1, 'venueBtcIndexerCount: hubCount must be a positive integer');
    return (perHub === false || standingUrl) ? 1 : hubs;
}

/**
 * The indexer's own per-chain config, for the protocol role addresses.
 *
 * Lazy and cached: `roleAddress` is the only caller, the unit tier never reaches it, and
 * requiring the indexer's config module at load time would make the pure layer
 * unrequirable on a box without the indexer checked out beside this repo.
 */
const internalRoleConfigCache = new Map();
function roleConfigFor(chain, network) {
    const key = String(chain).toUpperCase() + '/' + String(network || 'regtest');
    if (internalRoleConfigCache.has(key)) return internalRoleConfigCache.get(key);
    const configModule = require('./bridgeSettleContext').loadIndexerModule('src/config.js');
    const config = configModule.getConfig(String(chain).toUpperCase(), String(network || 'regtest'));
    internalRoleConfigCache.set(key, config);
    return config;
}

/**
 * Has the bridge settled for one chain: nothing in flight and the two sides equal.
 *
 * PURE, and separate from `classifyInvariant` because the two questions differ. That one
 * asks which DIRECTION a discrepancy points; this asks whether the rail is quiet enough
 * for a drive to take a baseline off it. `in_flight` is the term that distinguishes them:
 * a rail with escrow 35, supply 0 and in_flight 35 is CONSISTENT and merely mid-flight,
 * while the same row with in_flight 0 is a real deficit.
 */
function bridgeSettled(entry) {
    const cls = classifyInvariant(entry);
    const flight = Number((entry || {}).in_flight);
    return cls.verdict === 'equal' && Number.isFinite(flight) && flight === 0;
}

/**
 * One chain's entry from a `getbridgeinvariant` answer, normalised.
 *
 * PURE. `delta` is the signed escrow-minus-(supply+in_flight) the hub computes, and the
 * three states it encodes are NOT symmetric (D65): a deficit is someone else's units
 * being unbacked, a surplus is the sender's own loss. Returning a verdict string here
 * rather than comparing numbers at each call site is what lets the drive assert the
 * DIRECTION rather than the magnitude alone.
 *
 * A null delta means the hub could not read one side's chain state and says so, which
 * is neither equal nor broken: 'unknown', never quietly folded into 'equal'.
 */
function classifyInvariant(entry) {
    const e = entry || {};
    if (e.delta === null || e.delta === undefined || e.delta === '') return { verdict: 'unknown', delta: null };
    const d = Number(e.delta);
    if (!Number.isFinite(d)) return { verdict: 'unknown', delta: null };
    if (d === 0) return { verdict: 'equal', delta: 0 };
    return { verdict: d > 0 ? 'surplus' : 'deficit', delta: d };
}

/**
 * The escrow this chain's role address holds, from a `getbridgebalances` answer.
 *
 * PURE. The indexer keys the map by the ROLE suffix it read (`ADDRESS.BRIDGE_<COIN>`),
 * and the platform spells a chain both as a coin symbol and as a full name across its
 * configuration, so a lookup on one spelling alone silently reads `undefined` as zero.
 * Returns null for absent, never '0': "this chain has no escrow row" and "this chain's
 * escrow is empty" are different readouts and AT1 asserts the transition between them.
 */
function escrowOf(balances, chain) {
    const map = (balances && balances.escrow) || {};
    const want = String(chain || '').toUpperCase();
    for (const key of Object.keys(map)) {
        if (String(key).toUpperCase() === want) return String(map[key]);
    }
    return null;
}

async function firstHubRowsForSourceLeg(hubs, readHub, srcChain, srcActionIndex) {
    let failed = 0;
    let lastError = null;
    for (const hub of hubs) {
        let rows;
        try {
            rows = await readHub(hub.dbName,
                'SELECT transfer_id, status FROM bridge_transfers ' +
                'WHERE src_chain = ? AND src_action_index = ? LIMIT 1',
                [srcChain, Number(srcActionIndex)]);
        } catch (e) {
            failed += 1;
            lastError = e;
            continue;
        }
        if (rows.length) return rows;
    }
    if (failed === hubs.length && lastError) throw lastError;
    return [];
}

/**
 * The finalized legs a drained rail still owes, from the hubs' own records.
 *
 * PURE, and the second half of the drain wait. The source indexers'
 * `getpendingbridgetransfers` EXCLUDES any leg whose transfer already sits in the indexer's
 * mirrored `bridge_transfers` (src/db/bridges/index.js), so the moment the venue federation
 * finalizes the backlog the pending list goes EMPTY while the destination may have applied
 * nothing yet: a drain wait that reads only the pending list declares quiet with a baseline
 * of escrow 162 against a supply of 0, and the supply then jumps inside AT1's window. So
 * the legs that have LEFT the pending list are read back off the hubs' `bridge_transfers`
 * and each one is held against the destination's `bridge_settlements` until it is there.
 *
 * @param {Array}  hubRows      `bridge_transfers` rows gathered across every venue hub,
 *                              {transferId, srcChain, srcActionIndex, destChain, amount,
 *                              status, tick}; duplicates by transferId are folded here
 * @param {Set}    covered      `src:actionIndex` keys the per-leg pass already classified,
 *                              so a leg is never reported twice
 * @param {function(string): boolean} isSettled  whether the destination holds a settlement
 *                              for the transfer id (answered by the caller's reads)
 * @param {object} [opts]       {tick, observable: ['BTC', 'DOGE']}
 * @returns {{applied: Array, pending: Array, unobservable: Array}}
 */
function outstandingFinalizedLegs(hubRows, covered, isSettled, opts) {
    const o = opts || {};
    const observable = (o.observable || ['BTC', 'DOGE']).map((c) => String(c).toUpperCase());
    const applied = [], pending = [], unobservable = [];
    const seen = new Set();
    for (const row of hubRows || []) {
        const transferId = String(row.transferId);
        if (seen.has(transferId)) continue;
        seen.add(transferId);
        // A retracted row is a leg the federation withdrew (its source was reorged out);
        // nothing on the destination is owed for it and it must not hold the drain.
        if (String(row.status) === 'retracted') continue;
        if (o.tick && row.tick !== undefined && row.tick !== null && String(row.tick) !== String(o.tick)) continue;
        const src  = String(row.srcChain).toUpperCase();
        const dest = String(row.destChain).toUpperCase();
        const where = { chain: src, dest: dest, actionIndex: String(row.srcActionIndex),
                        amount: String(row.amount), transferId: transferId };
        if (covered && covered.has(src + ':' + where.actionIndex)) continue;
        // A leg bound for a chain this venue has no indexer for can never be observed
        // applying, and a row with no readable destination is the same case.
        if (!observable.includes(dest)) { unobservable.push(where); continue; }
        if (isSettled(transferId)) applied.push(where);
        else pending.push(Object.assign({ stage: 'unapplied' }, where));
    }
    return { applied: applied, pending: pending, unobservable: unobservable };
}

/**
 * What the hub's own `getbridgeinvariant` must read on a rail whose escrow carries
 * non-bridge credits.
 *
 * PURE. The hub computes `delta = escrow - (supply + in_flight)`, and on a rail that has
 * ever taken a plain SEND into the escrow address the escrow is permanently above the
 * supply by exactly those units: they minted nothing and the escrow key is nobody's (D65).
 * So "the invariant reads equal" is only the literal verdict on a virgin rail; on this one
 * the same claim is that the hub's delta equals the MEASURED non-bridge term and nothing
 * else, with nothing in flight. A double mint or an unbacked mint lowers the delta below
 * that term, a lost credit raises it above, and both read as a break here.
 *
 * @param {object} entry     one chain's `getbridgeinvariant` entry
 * @param {number} nonBridge the measured net non-bridge credits to that chain's escrow
 * @returns {{ok: boolean, expectedVerdict: string, expectedDelta: number, verdict: string,
 *   delta: (number|null), inFlight: (number|null), reason: (string|null)}}
 */
function expectedInvariantReading(entry, nonBridge) {
    const cls = classifyInvariant(entry);
    const want = Number(nonBridge || 0);
    const expectedVerdict = want === 0 ? 'equal' : (want > 0 ? 'surplus' : 'deficit');
    const flight = (entry && entry.in_flight !== undefined && entry.in_flight !== null)
        ? Number(entry.in_flight) : null;
    let reason = null;
    if (cls.verdict === 'unknown') reason = 'the hub could not read one side of the chain state';
    else if (flight !== 0) reason = 'in_flight reads ' + flight + ' rather than 0';
    else if (cls.delta !== want) reason = 'delta reads ' + cls.delta + ' where the measured non-bridge ' +
        'credits are ' + want + ', so ' + (cls.delta < want ? 'the destination holds more than the ' +
        'locks paid for (a double or unbacked mint)' : 'a lock paid for a credit that never landed');
    return { ok: reason === null, expectedVerdict: expectedVerdict, expectedDelta: want,
             verdict: cls.verdict, delta: cls.delta, inFlight: flight, reason: reason };
}

module.exports = { hubIndexerEnvMap, venueBtcIndexerCount, roleConfigFor, bridgeSettled, classifyInvariant, escrowOf, firstHubRowsForSourceLeg, outstandingFinalizedLegs, expectedInvariantReading };
