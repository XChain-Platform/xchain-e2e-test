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
const {
    listCreateWire,
    policyListsWire,
    sendWireV0,
    withMiningPaused,
    destinationApplyBudgetMs,
    hubRelayMarginFloorS,
} = require('../../../helpers/bridgeRailVenue');

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

function bind(state, T) {
    const P = state.policy;

    // The origin read, at the confirmed height the hub reads it at unless one is named.
    async function originPolicy(tick, originBlock) {
        let block = originBlock;
        if (block === undefined || block === null) {
            block = Number(await nodeConnector.getBlockCount()) - Number(state.venue.confirmations.BTC || 1);
        }
        return state.venue.indexerRpc('BTC', 'gettokenpolicy', { tick: String(tick), origin_block: Number(block) });
    }

    // The COPY's materialized policy, through the same open read at the DOGE tip: its hash is
    // the indexer's own hash over the lists the injected legs built, so equality with the
    // origin's hash is equality of membership and sleep, computed by neither side of the test.
    async function copyPolicy(tick) {
        const tip = Number((await state.venue.venueTips()).DOGE);
        return state.venue.indexerRpc('DOGE', 'gettokenpolicy', { tick: 'BTC.' + tick, origin_block: tip });
    }

    // getappliedpolicy as a client calls it for a DOGE token: the rooted name the DOGE ledger
    // knows. Never throws, so an assertion names what came back.
    async function appliedPolicyRead(tick) {
        try { return await state.venue.indexerRpc('DOGE', 'getappliedpolicy', { tick: 'BTC.' + tick }); }
        catch (e) { return { error: String(e && e.message).slice(0, 240) }; }
    }

    async function hubPolicyRows(tick) {
        return state.venue.queryHubDb(state.venue.hubs[0].dbName,
            "SELECT snapshot_id, snapshot_block, origin_chain, tick, policy_seq, origin_block, policy_hash, " +
            "allow_list, block_list, sleeping, effective_time, network, finalizing_view, validator_signatures, " +
            "status, push_generation, btc_chain_id FROM policy_snapshots " +
            "WHERE origin_chain = 'BTC' AND tick = ? ORDER BY policy_seq ASC", [String(tick)]);
    }

    // The newest finalized snapshot of `tick` at or above `seq`, once the federation has one.
    async function waitForFinalizedSeq(tick, seq, opts) {
        const o = opts || {};
        let found = null;
        await state.venue.waitUntil('a finalized policy_snapshots row for ' + tick + ' at seq >= ' + seq,
            async () => {
                const rows = (await hubPolicyRows(tick)).filter((r) => String(r.status) === 'finalized' &&
                    Number(r.policy_seq) >= Number(seq));
                found = rows.length ? rows[rows.length - 1] : null;
                return !!found;
            }, { timeoutMs: o.timeoutMs || 20 * 60 * 1000, everyMs: 5000 });
        return found;
    }

    // What the DOGE ledger applied for `tick`, joined to the mirrored rows: every applied
    // snapshot with its block and action index, newest seq last.
    async function appliedLedger(tick) {
        const settled = await state.venue.queryIndexerDb('DOGE',
            "SELECT transfer_id, block_index, action_index FROM bridge_settlements WHERE kind = 'policy' AND tick = ?",
            [String(tick)]);
        if (!settled.length) return [];
        const mirrored = await state.venue.queryMirrorDb('DOGE',
            "SELECT snapshot_id, policy_seq, policy_hash, sleeping FROM policy_snapshots WHERE origin_chain = 'BTC' AND tick = ?",
            [String(tick)]);
        const byId = new Map(mirrored.map((r) => [String(r.snapshot_id), r]));
        return settled.map((s) => {
            const m = byId.get(String(s.transfer_id)) || {};
            return { snapshotId: String(s.transfer_id), block: Number(s.block_index), actionIndex: Number(s.action_index),
                seq: m.policy_seq === undefined ? null : Number(m.policy_seq), hash: m.policy_hash ? String(m.policy_hash) : null,
                sleeping: m.sleeping === undefined ? null : Number(m.sleeping) };
        }).sort((a, b) => Number(a.seq) - Number(b.seq));
    }

    // Hold until the DOGE ledger has applied `tick` at seq >= `seq`, within the relay margin the
    // venue hubs stamp plus the destination's block cadence.
    async function waitForAppliedSeq(tick, seq, opts) {
        const o = opts || {};
        let last = [];
        await state.venue.waitUntil('the DOGE ledger to apply ' + tick + ' policy seq ' + seq,
            async () => {
                last = await appliedLedger(tick);
                return last.some((r) => Number(r.seq) >= Number(seq));
            }, { timeoutMs: o.timeoutMs || destinationApplyBudgetMs(hubRelayMarginFloorS('DOGE')), everyMs: 5000 });
        return last.filter((r) => Number(r.seq) >= Number(seq))[0];
    }

    // Who created a list and in which transaction: the injected pass writes its lists from the
    // bridge role address under an XPOLICY- transaction, a user never can.
    async function listOrigin(chain, listIndex) {
        const rows = await state.venue.queryIndexerDb(chain,
            'SELECT l.type AS type, ad.address AS source, it.hash AS tx_hash FROM lists l ' +
            'INNER JOIN actions a ON (a.action_index = l.action_index) ' +
            'LEFT JOIN index_addresses ad ON (ad.id = a.source_id) ' +
            'LEFT JOIN transactions t ON (t.tx_index = a.tx_index) ' +
            'LEFT JOIN index_transactions it ON (it.id = t.tx_hash_id) ' +
            'WHERE l.action_index = ? LIMIT 1', [String(listIndex)]);
        return rows[0] || null;
    }

    // A type-2 address LIST on BTC from `owner`, answered as its action index.
    async function btcAddressList(owner, members, memo) {
        const list = await T.btcAction(owner, listCreateWire(2, members, memo || 'policy rail'), 'lists');
        assert.strictEqual(list.status, 'valid', 'the BTC address LIST graded ' + list.status);
        return list.actionIndex;
    }

    // Broadcast several actions from one address and mine them into ONE BTC block, so the hub
    // reads their combined effect at one origin height and signs one snapshot for it.
    async function oneBtcBlock(from, wires, table) {
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

    // A policy-bearing token on BTC: issued, given a BLOCK_LIST of `blocked`, opted in to DOGE.
    async function listedToken(label, candidates, blocked) {
        const tick = await T.pickFreeTick(candidates);
        assert.ok(tick, 'no free tick among ' + candidates.join(', '));
        const issuer = await T.fundBtc('POLICY.' + label + '.ISSUER');
        const issue = await T.btcAction(issuer, () => require('../../../helpers/issueHelper').sendIssueV0Raw(
            issuer, tick, 100000, 100000, 0, 'policy ' + label, 1000), 'issues');
        assert.strictEqual(issue.status, 'valid', 'ISSUE ' + tick + ' graded ' + issue.status);
        const listIndex = await btcAddressList(issuer, blocked, 'policy ' + label + ' block list');
        const attach = await T.btcAction(issuer, policyListsWire(tick, null, listIndex, 'policy ' + label), 'issues');
        assert.strictEqual(attach.status, 'valid', 'ISSUE|5 attaching the BLOCK_LIST graded ' + attach.status);
        const flagActive = T.policyInheritanceActive(Number(await nodeConnector.getBlockCount()) + 1);
        const optIn = await T.btcAction(issuer, T.optInWire(tick, 'DOGE', '', '', 'policy ' + label + ' opt-in'), 'issues');
        P.ticks.push(tick);
        return { tick, issuer, listIndex, issue, attach, optIn, flagActive };
    }

    // A SEND of the copy on DOGE, graded on the venue DOGE ledger.
    async function sendCopy(from, tick, amount, destination, memo) {
        return T.dogeAction(from, sendWireV0('BTC.' + tick, amount, destination, memo || ''), 'sends');
    }

    // The venue DOGE indexer's XPOLICY lines naming one snapshot, by its 16-character prefix.
    function policyLines(snapshotId) {
        const prefix = String(snapshotId).slice(0, 16);
        return state.venue.indexerTails(600).split('\n')
            .filter((l) => l.includes('XPOLICY') && l.includes(prefix)).map((l) => l.trim().slice(0, 240));
    }

    return {
        originPolicy, copyPolicy, appliedPolicyRead, hubPolicyRows, waitForFinalizedSeq, appliedLedger,
        waitForAppliedSeq, listOrigin, btcAddressList, oneBtcBlock, listedToken, sendCopy, policyLines,
    };
}

module.exports = { records, bind };
