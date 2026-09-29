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
 *********************************************************************/

'use strict';

const assert            = require('assert');
const transactionHelper = require('../../../transactionHelper');
const { transactionState } = require('../../../transactionHelper/lib/01_create_and_send_transaction');
const {
    listCreateWire,
    policyListsWire,
    sendWireV0,
    withMiningPaused,
} = require('../../../helpers/bridgeRailVenue');
const {
    appliedPolicyMatch,
    dogeFeeSchedule,
    expandPolicyTickCandidates,
    freshInputCount,
    joinAppliedPolicyRows,
    policyApplyBudgetMs,
    policyTransferMatches,
    spendableInputCount,
} = require('../../../helpers/rail_preflight/policy_at2_at4');
const {
    feeScheduleBudgetMs,
    policyFinalizationBudgetMs,
} = require('../../../helpers/rail_preflight/policy_at7_at8');

// The policy legs' shared readings, bound to the drive state by `bind`. Three sources, and
// which one a leg reads is the claim it makes:
//   the HUB's policy_snapshots rows: what the federation signed;
//   the DOGE LEDGER (bridge_settlements kind 'policy' joined to the mirrored rows): what the
//     destination materialized, read without any RPC so one read defect cannot hide the
//     ledger from every later leg;
//   the two OPEN READS the spec names (gettokenpolicy, getappliedpolicy): what a client
//     sees, asserted where the spec's acceptance text names them.

function records() {
    return {
        policy: {
            main: {},   // AT1's token: issuer, list, lock destination, the two probe addresses
            lag: {},    // AT5's token, locked while the destination could not see a snapshot
            gap: {},    // AT4's seq-gap token
            cap: {},    // AT8's two cap ticks
            ctl: {},    // AT9's controller-bound token
            ticks: [],  // every tick this drive bridged, the set AT8's invariant covers
        },
    };
}

const policyDogeFeeDestinations = new WeakMap();

async function ensureDogeFeeSchedule(state) {
    if (policyDogeFeeDestinations.has(state)) return policyDogeFeeDestinations.get(state);
    let decision = dogeFeeSchedule(null);
    await state.venue.waitUntil('the policy DOGE fee schedule to name its destination', async () => {
        try { decision = dogeFeeSchedule(await state.venue.indexerRpc('DOGE', 'feeschedule', {})); }
        catch (e) { decision = dogeFeeSchedule(null); }
        return decision.ready;
    }, { timeoutMs: feeScheduleBudgetMs(state.venue.pollMs || 15000), everyMs: 2000 });
    policyDogeFeeDestinations.set(state, decision.destination);
    state.dogeRail.env.FEE_DESTINATION = decision.destination;
    return decision.destination;
}

async function originPolicy(state, tick, originBlock) {
    let block = originBlock;
    if (block === undefined || block === null) {
        block = Number(await nodeConnector.getBlockCount()) - Number(state.venue.confirmations.BTC || 1);
    }
    return state.venue.indexerRpc('BTC', 'gettokenpolicy', { tick: String(tick), origin_block: Number(block) });
}

async function copyPolicy(state, tick) {
    const tip = Number((await state.venue.venueTips()).DOGE);
    return state.venue.indexerRpc('DOGE', 'gettokenpolicy', { tick: 'BTC.' + tick, origin_block: tip });
}

async function appliedPolicyRead(state, tick) {
    try { return await state.venue.indexerRpc('DOGE', 'getappliedpolicy', { tick: 'BTC.' + tick }); }
    catch (e) { return { error: String(e && e.message).slice(0, 240) }; }
}

async function hubPolicyRows(state, tick) {
    return state.venue.queryHubDb(state.venue.hubs[0].dbName,
        "SELECT snapshot_id, snapshot_block, origin_chain, tick, policy_seq, origin_block, policy_hash, " +
        "allow_list, block_list, sleeping, effective_time, network, finalizing_view, validator_signatures, " +
        "status, push_generation, btc_chain_id FROM policy_snapshots " +
        "WHERE origin_chain = 'BTC' AND tick = ? ORDER BY policy_seq ASC", [String(tick)]);
}

async function waitForFinalizedSeq(state, tick, seq, opts) {
    const o = opts || {};
    let found = null;
    await state.venue.waitUntil('a finalized policy_snapshots row for ' + tick + ' at seq >= ' + seq, async () => {
        const rows = (await hubPolicyRows(state, tick)).filter((r) => String(r.status) === 'finalized' &&
            Number(r.policy_seq) >= Number(seq));
        found = rows.length ? rows[rows.length - 1] : null;
        return !!found;
    }, { timeoutMs: o.timeoutMs || policyFinalizationBudgetMs(state.venue.pollMs || 15000), everyMs: 5000 });
    return found;
}

async function appliedLedger(state, tick) {
    const settled = await state.venue.queryIndexerDb('DOGE',
        "SELECT transfer_id, block_index, action_index FROM bridge_settlements WHERE kind = 'policy' AND tick = ?",
        [String(tick)]);
    if (!settled.length) return [];
    const mirrored = await state.venue.queryMirrorDb('DOGE',
        "SELECT snapshot_id, policy_seq, policy_hash, sleeping FROM policy_snapshots WHERE origin_chain = 'BTC' AND tick = ?",
        [String(tick)]);
    return joinAppliedPolicyRows(settled, mirrored);
}

async function waitForAppliedSeq(state, tick, seq, opts) {
    const o = opts || {};
    let found = null;
    await state.venue.waitUntil('the DOGE ledger to apply ' + tick + ' policy seq ' + seq, async () => {
        found = appliedPolicyMatch(await appliedLedger(state, tick), { minSeq: seq, snapshotId: o.snapshotId });
        return !!found;
    }, { timeoutMs: o.timeoutMs || policyApplyBudgetMs('DOGE'), everyMs: 5000 });
    return found;
}

async function listOrigin(state, chain, listIndex) {
    const rows = await state.venue.queryIndexerDb(chain,
        'SELECT l.type AS type, ad.address AS source, it.hash AS tx_hash FROM lists l ' +
        'INNER JOIN actions a ON (a.action_index = l.action_index) ' +
        'LEFT JOIN index_addresses ad ON (ad.id = a.source_id) ' +
        'LEFT JOIN transactions t ON (t.tx_index = a.tx_index) ' +
        'LEFT JOIN index_transactions it ON (it.id = t.tx_hash_id) ' +
        'WHERE l.action_index = ? LIMIT 1', [String(listIndex)]);
    return rows[0] || null;
}

async function btcAddressList(T, owner, members, memo) {
    const list = await T.btcAction(owner, listCreateWire(2, members, memo || 'policy rail'), 'lists');
    assert.strictEqual(list.status, 'valid', 'the BTC address LIST graded ' + list.status);
    return list.actionIndex;
}

async function fundFreshInputs(state, from, count) {
    const before = await utxoTrackerConnector.getUtxosFromAddress(from.address);
    const opening = spendableInputCount(before && before.utxos);
    const needed = freshInputCount(count);
    for (let i = 0; i < needed; i++) {
        const tx = await regtestMinerConnector.sendFunds(from.address, 1);
        await nodeConnector.waitForTx(tx, 60000);
    }
    await state.venue.waitUntil(needed + ' fresh issuer inputs for one BTC block', async () => {
        const snapshot = await utxoTrackerConnector.getUtxosFromAddress(from.address);
        return spendableInputCount(snapshot && snapshot.utxos) >= opening + needed;
    }, { timeoutMs: 180000, everyMs: 1000 });
    transactionState.verifiedUtxos = null;
    transactionState.verifiedUtxosAddress = null;
}

async function oneBtcBlock(state, T, from, wires, table) {
    await fundFreshInputs(state, from, wires.length);
    const txs = await withMiningPaused(regtestMinerConnector, async () => {
        const sent = [];
        for (const wire of wires) sent.push(await transactionHelper.createAndSendTransaction(from, wire));
        await T.mineBtcBlocks(1, 'with ' + wires.length + ' policy edits');
        return sent;
    });
    const graded = [];
    for (const tx of txs) {
        const got = await state.venue.verdict('BTC', table, tx);
        assert.ok(got, 'the venue BTC indexer never graded ' + table + ' tx ' + tx);
        graded.push({ tx: tx, status: got.status, actionIndex: got.actionIndex });
    }
    return graded;
}

async function listedToken(state, T, label, candidates, blocked) {
    const expanded = expandPolicyTickCandidates(candidates);
    const tick = await T.pickFreeTick(expanded);
    assert.ok(tick, 'no free tick among ' + expanded.join(', '));
    const issuer = await T.fundBtc('POLICY.' + label + '.ISSUER');
    const issue = await T.btcAction(issuer, () => require('../../../helpers/issueHelper').sendIssueV0Raw(
        issuer, tick, 100000, 100000, 0, 'policy ' + label, 1000), 'issues');
    assert.strictEqual(issue.status, 'valid', 'ISSUE ' + tick + ' graded ' + issue.status);
    const listIndex = await btcAddressList(T, issuer, blocked, 'policy ' + label + ' block list');
    const attach = await T.btcAction(issuer, policyListsWire(tick, null, listIndex, 'policy ' + label), 'issues');
    assert.strictEqual(attach.status, 'valid', 'ISSUE|5 attaching the BLOCK_LIST graded ' + attach.status);
    const flagActive = T.policyInheritanceActive(Number(await nodeConnector.getBlockCount()) + 1);
    const optIn = await T.btcAction(issuer, T.optInWire(tick, 'DOGE', '', '', 'policy ' + label + ' opt-in'), 'issues');
    state.policy.ticks.push(tick);
    return { tick, issuer, listIndex, issue, attach, optIn, flagActive };
}

async function sendCopy(state, T, from, tick, amount, destination, memo) {
    await ensureDogeFeeSchedule(state);
    return T.dogeAction(from, sendWireV0('BTC.' + tick, amount, destination, memo || ''), 'sends');
}

function policyLines(state, snapshotId) {
    const prefix = String(snapshotId).slice(0, 16);
    return state.venue.indexerTails(600).split('\n')
        .filter((line) => line.includes('XPOLICY') && line.includes(prefix)).map((line) => line.trim().slice(0, 240));
}

function bind(state, T) {
    return {
        originPolicy: (...args) => originPolicy(state, ...args),
        copyPolicy: (...args) => copyPolicy(state, ...args),
        appliedPolicyRead: (...args) => appliedPolicyRead(state, ...args),
        hubPolicyRows: (...args) => hubPolicyRows(state, ...args),
        waitForFinalizedSeq: (...args) => waitForFinalizedSeq(state, ...args),
        appliedLedger: (...args) => appliedLedger(state, ...args),
        waitForAppliedSeq: (...args) => waitForAppliedSeq(state, ...args),
        listOrigin: (...args) => listOrigin(state, ...args),
        btcAddressList: (...args) => btcAddressList(T, ...args),
        oneBtcBlock: (...args) => oneBtcBlock(state, T, ...args),
        listedToken: (...args) => listedToken(state, T, ...args),
        sendCopy: (...args) => sendCopy(state, T, ...args),
        policyLines: (...args) => policyLines(state, ...args),
        fundDoge: async (...args) => { await ensureDogeFeeSchedule(state); return T.fundDoge(...args); },
        settleLeg: (what, match, chain, opts) => T.settleLeg(what, match, chain,
            Object.assign({ applyMs: policyApplyBudgetMs(chain) }, opts || {})),
        policyTransferMatches,
    };
}

module.exports = { records, bind };
