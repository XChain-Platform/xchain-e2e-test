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
const chainRail         = require('../../../helpers/chainRail');
const cryptoHelper      = require('../../../cryptoHelper');
const transactionHelper = require('../../../transactionHelper');
const {
    lockWireV3,
    burnWireV4,
    optInWire,
    escrowOf,
    classifyInvariant,
    effectiveLockDepth,
    capOrderReading,
    assertShallowOrphan,
    confirmedHeight,
    orphanWithEmptyBlocks,
} = require('../../../helpers/bridgeRailVenue');

// The standing utxo-tracker's undo window, the same 12 the reorg suite pins.
const TRACKER_UNDO_BLOCKS = 12;

// The token legs' shared helpers, bound to the drive state by `bind`. Everything a leg
// reads is read off the VENUE ledgers (the base support says why: the standing DOGE
// indexer parsed a different history), and every broadcast is graded through
// `venue.verdict` on the table the verdict lives on.

const GAS_TICK = 'XCHAIN';
// AT1 locks 5 at 4 decimals from a mint of 100, AT2 burns 2 of them. Named so the
// invariant arithmetic at AT8 quotes the numbers the legs moved.
const LOCK = 5, BURN = 2, DECIMALS = 4, MINT = 100;
const EXPIRY = () => Math.floor(Date.now() / 1000) + 90 * 24 * 3600;

// The drive's own records: address RECORDS (key material included) and the ticks it
// chose. Never folded into `evidence`, which is printed.
function records() {
    return {
        tick: null,       // the BTC-native tick AT1 issues (FUFU unless the rail holds it)
        bridged: null,    // 'BTC.' + tick, the DOGE copy
        issuer: null,     // the BTC record that owns `tick`
        dest: null,       // the DOGE record AT1 credits
        btcReceiver: null,
        at3: {},          // AT3's own tick, issuer and destination
        at5: {},
        reorg: {},        // the retraction leg's tick and records
        cap: {},          // the cap leg's two ticks and their senders
    };
}

function bind(state) {
    const T = state.tokens;

    // Broadcast one action on the CURRENT (BTC) rail and grade it on the venue BTC ledger.
    async function btcAction(from, wire, table, opts) {
        const tx = typeof wire === 'function' ? await wire() : await transactionHelper.createAndSendTransaction(from, wire);
        const got = await state.venue.verdict('BTC', table, tx, opts);
        assert.ok(got, 'the venue BTC indexer never graded the ' + table + ' action in tx ' + tx +
            ' within the budget.\n' + state.venue.indexerTails(40));
        return { tx: tx, status: got.status, actionIndex: got.actionIndex };
    }

    // Broadcast one action on DOGE and read its verdict OFF THE VENUE LEDGER.
    async function dogeAction(from, wire, table, opts) {
        const tx = await chainRail.withRail(state.dogeRail, () => (typeof wire === 'function'
            ? wire()
            : transactionHelper.createAndSendTransaction(from, wire)));
        const got = await state.venue.verdict('DOGE', table, tx, opts);
        assert.ok(got, 'the venue DOGE indexer never graded the ' + table + ' action in tx ' + tx +
            ' within the budget.\n' + state.venue.indexerTails(40));
        return { tx: tx, status: got.status, actionIndex: got.actionIndex };
    }

    async function fundBtc(label) {
        return state.venue.funded(label, () => cryptoHelper.getNewFundedAddress(label, 'bitcoin', NETWORK, null, 'legacy', 0, 1, false));
    }
    async function fundDoge(label, coins) {
        return state.venue.funded(label, () => chainRail.withRail(state.dogeRail,
            () => cryptoHelper.getNewFundedAddress(label, 'dogecoin', NETWORK, null, 'legacy', 0, coins || 5, false)));
    }

    // Every row spelled like `tick` in ANY case: AT1's "no BTC root row on DOGE in any case".
    async function rowsLike(chain, tick) {
        return state.venue.queryIndexerDb(chain,
            'SELECT ti.tick AS tick FROM tokens tk INNER JOIN index_tickers ti ON (ti.id=tk.tick_id) WHERE UPPER(ti.tick)=UPPER(?)',
            [String(tick)]);
    }

    // The first candidate free on BOTH ledgers: the spec's name unless the rail already
    // carries it from an earlier attempt, in which case the next spelling.
    async function pickFreeTick(candidates) {
        for (const cand of candidates) {
            const onBtc = await state.venue.hasTokenRow('BTC', cand);
            const onDoge = await state.venue.hasTokenRow('DOGE', 'BTC.' + cand);
            if (!onBtc && !onDoge) return cand;
            state.evidence['tick_skipped_' + cand] = { onBtc, onDoge };
        }
        return null;
    }

    // The three readings every token assertion is a delta on: the BTC escrow for DOGE, the
    // DOGE copy's supply, and one DOGE address's balance of the copy.
    async function tokenSnapshot(label, tick, destRecord) {
        const native = tick || T.tick;
        const snap = {
            btc: await state.venue.bridgeBalances('BTC', native),
            doge: await state.venue.bridgeBalances('DOGE', 'BTC.' + native),
            destBridged: destRecord ? await state.venue.addressBalance('DOGE', destRecord.address, 'BTC.' + native) : null,
        };
        snap.escrow = Number(escrowOf(snap.btc, 'DOGE') || 0);
        snap.supply = Number((snap.doge && snap.doge.supply) || 0);
        state.evidence['snapshot_' + label] = snap;
        return snap;
    }

    // Finalized by the federation, then applied on `destChain`: the two waits every
    // settling leg needs, with the destination budget the venue sizes per chain.
    async function settleLeg(what, match, destChain, opts) {
        const o = opts || {};
        const row = await state.venue.waitForFinalizedTransfer(match, { timeoutMs: o.finalizeMs || 30 * 60 * 1000 });
        assert.ok(row, what + ' never finalized on any venue hub.\n' + state.venue.hubTails(30));
        const applied = await state.venue.waitForBridgeApplied(destChain, row.transfer_id,
            o.applyMs ? { timeoutMs: o.applyMs } : undefined);
        assert.ok(applied, 'the venue ' + destChain + ' indexer never applied ' + what + ' (' + row.transfer_id +
            ').\n' + state.venue.indexerTails(40));
        return { row: row, applied: applied,
            transfer: { transferId: row.transfer_id, snapshotBlock: String(row.snapshot_block), tick: String(row.tick),
                decimals: String(row.decimals), amount: String(row.amount), appliedBlock: String(applied.block_index) } };
    }

    // The XCHAIN chain halves, AT8's control: the token legs must leave them untouched.
    async function chainHalves() {
        const escrow = escrowOf(await state.venue.bridgeBalances('BTC', GAS_TICK), 'DOGE');
        const supply = (await state.venue.bridgeBalances('DOGE', GAS_TICK)).supply;
        const nonBridge = await state.venue.escrowNonBridgeCredits('BTC', 'BRIDGE_DOGE', GAS_TICK);
        return { escrow: escrow, supply: supply, nonBridge: nonBridge,
                 backed: Number(escrow) - Number(nonBridge.net) };
    }

    // The indexer's own reading of the policy-inheritance flag day at a height, from the
    // same registry the venue indexers grade with. AT6's policy verdicts flip on it.
    function policyInheritanceActive(height) {
        const registry = require('../../../helpers/bridgeSettleContext').loadIndexerModule('src/protocol_changes.js');
        return !!registry.activeAt('token_policy_activation.TOKEN_POLICY_INHERITANCE_ACTIVATION',
            NETWORK, null, Number(height), null);
    }

    function capPerBlock() {
        const constants = require('../../../helpers/bridgeSettleContext').loadIndexerModule('src/protocol/constants.js');
        return Number(constants.XBRIDGE_MAX_PER_BLOCK) || 25;
    }

    // Mine `count` BTC blocks through the standing miner and hold until the venue BTC
    // indexer has parsed them, so a depth reading is of the ledger at that depth.
    async function mineBtcBlocks(count, what) {
        await regtestMinerConnector.generateBlocks(count);
        const tip = Number(await nodeConnector.getBlockCount());
        await state.venue.waitForVenueTip('BTC', tip, what, { timeoutMs: 180000, everyMs: 2000 });
        return tip;
    }

    // The competing chain's coinbase destination, its own address (reorg suite).
    let coinbaseAddress = null;
    async function replacementCoinbase() {
        if (!coinbaseAddress) {
            coinbaseAddress = (await cryptoHelper.getNewAddress('TOKENREORG.COINBASE', 'bitcoin', NETWORK,
                null, 'legacy', 0)).address;
        }
        return coinbaseAddress;
    }

    // The reorg lever, the reorg suite's `reorgBtcFrom` verbatim in its guards: only a
    // height THIS drive mined (above the tip it found at bring-up), inside the tracker's
    // undo window, replaced by EMPTY blocks under a paused miner. The caller holds the
    // pause for as long as its claim depends on the lock staying out of the chain.
    async function reorgBtcFrom(lockTx, replaceWith) {
        const height = await confirmedHeight(nodeConnector, lockTx);
        assert.ok(height > Number(state.evidence.btcTip),
            'refusing to invalidate BTC block ' + height + ', which existed before this drive started');
        const tipBefore = Number(await nodeConnector.getBlockCount());
        assertShallowOrphan(height, tipBefore, TRACKER_UNDO_BLOCKS);
        const orphan = await orphanWithEmptyBlocks(nodeConnector, {
            height: height, coinbase: await replacementCoinbase(), atLeast: replaceWith, lockTx: lockTx,
        });
        return Object.assign({ height: height }, orphan);
    }

    return {
        lockWireV3, burnWireV4, optInWire, escrowOf, classifyInvariant, effectiveLockDepth, capOrderReading,
        GAS_TICK, LOCK, BURN, DECIMALS, MINT, EXPIRY,
        btcAction, dogeAction, fundBtc, fundDoge, rowsLike, pickFreeTick, tokenSnapshot, settleLeg,
        chainHalves, policyInheritanceActive, capPerBlock, mineBtcBlocks, reorgBtcFrom,
    };
}

module.exports = { records, bind };
