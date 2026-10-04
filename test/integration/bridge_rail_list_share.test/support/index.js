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

const bridgeRailVenue = require('../../../helpers/bridgeRailVenue');

function loadDriveFactory() {
    const InheritedVenue = bridgeRailVenue.BridgeRailVenue;
    bridgeRailVenue.BridgeRailVenue = class ListShareRailVenue extends InheritedVenue {
        constructor(options) {
            super(Object.assign({}, options, { withLtc: true }));
        }
    };
    try { return require('../../bridge_rail_token.test/support').createRailDrive; }
    finally { bridgeRailVenue.BridgeRailVenue = InheritedVenue; }
}

const createRailDrive = loadDriveFactory();
const chainRail = require('../../../helpers/chainRail');
const { transactionState } = require('../../../helpers/core/transactionHelper/lib/01_create_and_send_transaction');
const { spendableInputCount, freshInputCount } = require('../../../helpers/rail_preflight/policy_at2_at4');
const { withDogeFeeSchedule } = require('../../../helpers/rail_preflight/token_doge_fee');
const { withMiningPaused, verdictOf } = bridgeRailVenue;

const CHAINS = ['BTC', 'LTC', 'DOGE'];
const LIST_GATES = [
    'list_share_activation.LIST_SHARE_ACTIVATION',
    'list_share_producer_activation.LIST_SHARE_PRODUCER_ACTIVATION',
    'list_share_consumer_activation.LIST_SHARE_CONSUMER_ACTIVATION',
    'list_union_activation.LIST_UNION_ACTIVATION',
    'list_transfer_activation.LIST_TRANSFER_ACTIVATION',
    'list_address_ref_activation.LIST_ADDRESS_REF_ACTIVATION',
];
const MIRROR_GATE = 'mirror_admission_activation.MIRROR_ADMISSION_CONSUMER_ACTIVATION';
const DRIVE = {
    label: 'bridgeraillistshare',
    stakerLabel: 'bridge-rail-list-share',
    basePort: 49000,
    outerTitle: 'List sharing acceptance drive on the BTC/DOGE/LTC regtest rail',
    journalSuite: 'bridgeRailListShare',
    logTag: 'LIST SHARE RAIL',
    readoutTitle: 'list share rail drive readouts',
    dropStaleReplay: true,
    confirmations: { BTC: 1, DOGE: 1, LTC: 1 },
    records: () => ({ listShare: { home: {}, mirrors: {}, tokens: {} } }),
};
const baseDrive = createRailDrive(DRIVE);
const drive = withDogeFeeSchedule(baseDrive, baseDrive.state);

function listCreateWire(type, items, memo) {
    drive.assert.ok([1, 2, 3].includes(Number(type)), 'LIST create type must be 1, 2 or 3');
    drive.assert.ok(Array.isArray(items), 'LIST create needs an item array');
    return ['LIST', '0', String(type), String(memo || '')].concat(items.map(String)).join('|');
}

function listEditWire(edit, listIndex, items, memo) {
    drive.assert.ok([1, 2].includes(Number(edit)), 'LIST edit must be 1 or 2');
    drive.assert.ok(Array.isArray(items) && items.length, 'LIST edit needs items');
    return ['LIST', '1', String(edit), String(listIndex), String(memo || '')]
        .concat(items.map(String)).join('|');
}

function listShareWire(listIndex, memo) {
    return ['LIST', '2', String(listIndex), String(memo || '')].join('|');
}

function listTransferWire(listIndex, destination, memo) {
    return ['LIST', '3', String(listIndex), String(destination), String(memo || '')].join('|');
}

function issueListsWire(tick, allowList, blockList, memo) {
    const field = (value) => value === null || value === undefined ? '' : String(value);
    return ['ISSUE', '5', String(tick), field(allowList), field(blockList), String(memo || '')].join('|');
}

function sendWire(tick, amount, destination, memo) {
    return ['SEND', '0', String(tick), String(amount), String(destination), String(memo || '')].join('|');
}

function railFor(chain) {
    if (chain === 'DOGE') return drive.state.dogeRail;
    if (chain === 'LTC') return drive.state.venue.ltcRail;
    return null;
}

async function onChain(chain, work) {
    const rail = railFor(String(chain).toUpperCase());
    return rail ? chainRail.withRail(rail, work) : work();
}

async function chainAction(chain, from, wire, table, opts) {
    const name = String(chain).toUpperCase();
    if (name === 'BTC') return drive.btcAction(from, wire, table, opts);
    if (name === 'DOGE') return drive.dogeAction(from, wire, table, opts);
    drive.assert.strictEqual(name, 'LTC', 'unsupported action chain ' + chain);
    const tx = await onChain(name, () => typeof wire === 'function'
        ? wire() : drive.transactionHelper.createAndSendTransaction(from, wire));
    const got = await verdictOf(drive.state.venue.ltcVenue, table, tx, opts);
    drive.assert.ok(got, 'the venue LTC indexer never graded ' + table + ' tx ' + tx);
    return { tx, status: got.status, actionIndex: got.actionIndex };
}

async function fundChain(chain, label, coins) {
    const name = String(chain).toUpperCase();
    if (name === 'BTC') return drive.fundBtc(label);
    if (name === 'DOGE') return drive.fundDoge(label, coins);
    return drive.state.venue.funded(label, () => onChain(name, () =>
        drive.cryptoHelper.getNewFundedAddress(label, 'litecoin', NETWORK, null, 'legacy', 0,
            coins || 5, false)));
}

async function newAddress(chain, label, mnemonic) {
    const coins = { BTC: 'bitcoin', LTC: 'litecoin', DOGE: 'dogecoin' };
    const name = String(chain).toUpperCase();
    return onChain(name, () => drive.cryptoHelper.getNewAddress(
        label, coins[name], NETWORK, mnemonic || null, 'legacy', 0));
}

async function sharedBtcLtcAddress(label) {
    const btc = await newAddress('BTC', label + '.BTC');
    const ltc = await newAddress('LTC', label + '.LTC', btc.mnemonic);
    drive.assert.strictEqual(ltc.address, btc.address,
        'BTC and LTC regtest legacy derivations differ for ' + label);
    return { BTC: btc, LTC: ltc, address: btc.address };
}

function tickCandidates(label) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let seed = 0;
    for (const char of String(label)) seed = (seed * 33 + char.charCodeAt(0)) % (26 ** 4);
    return Array.from({ length: 128 }, (_, offset) => {
        let value = (seed + offset * 7919) % (26 ** 4), tick = '';
        for (let i = 0; i < 4; i++) {
            tick = alphabet[value % 26] + tick;
            value = Math.floor(value / 26);
        }
        return tick;
    });
}

async function pickFreeTick(chain, label) {
    for (const tick of tickCandidates(label)) {
        if (!await drive.state.venue.hasTokenRow(chain, tick)) return tick;
    }
    drive.assert.fail('no free ' + chain + ' tick for ' + label);
}

async function hubListRows(rootIndex) {
    let sql = 'SELECT * FROM list_snapshots WHERE network = ?';
    const params = [NETWORK];
    if (rootIndex !== null && rootIndex !== undefined) {
        sql += ' AND home_chain = ? AND home_list_index = ?';
        params.push('DOGE', String(rootIndex));
    }
    sql += ' ORDER BY home_chain ASC, home_list_index ASC, seq ASC';
    const rows = new Map();
    let reads = 0, lastError = null;
    for (const hub of drive.state.venue.hubs) {
        try {
            const found = await drive.state.venue.queryHubDb(hub.dbName, sql, params);
            reads++;
            for (const row of found) rows.set(String(row.snapshot_id), row);
        } catch (error) { lastError = error; }
    }
    if (!reads && lastError) throw lastError;
    return Array.from(rows.values()).sort((a, b) => Number(a.seq) - Number(b.seq));
}

async function mineDogeBlocks(count) {
    const tip = await onChain('DOGE', async () => {
        await regtestMinerConnector.generateBlocks(Number(count));
        return Number(await nodeConnector.getBlockCount());
    });
    await drive.state.venue.waitForVenueTip('DOGE', tip, 'after burying the shared-list edit',
        { timeoutMs: 180000, everyMs: 2000 });
    return tip;
}

async function waitForFinalizedSeq(seq) {
    const home = drive.state.listShare.home;
    await mineDogeBlocks(Number(drive.state.venue.confirmations.DOGE || 1));
    let found = null;
    await drive.state.venue.waitUntil('shared list ' + home.rootIndex + ' seq ' + seq + ' to finalize', async () => {
        const rows = await hubListRows(home.rootIndex);
        found = rows.find((row) => String(row.status) === 'finalized' && Number(row.seq) === Number(seq));
        return !!found;
    }, { timeoutMs: 30 * 60 * 1000, everyMs: 3000 });
    return found;
}

const mirrorRefreshAt = new Map();

function refreshMirror(chain) {
    if (Date.now() - Number(mirrorRefreshAt.get(chain) || 0) < 30000) return;
    mirrorRefreshAt.set(chain, Date.now());
    const venue = chain === 'BTC' ? drive.state.venue.btcVenue : drive.state.venue.ltcVenue;
    for (const indexer of (venue && venue.indexers) || []) {
        if (indexer.mirrorProxy) indexer.mirrorProxy.dropSockets();
    }
}

async function mirrorIndex(chain) {
    const home = drive.state.listShare.home;
    const rows = await drive.state.venue.queryIndexerDb(chain,
        'SELECT action_index, block_index FROM list_share_mirrors ' +
        'WHERE home_chain = ? AND home_list_index = ? LIMIT 1',
        ['DOGE', String(home.rootIndex)]);
    return rows[0] || null;
}

async function waitForMirrorSeq(chain, seq) {
    const home = drive.state.listShare.home;
    const snapshot = home['seq' + seq];
    let applied = null, mapping = null;
    await drive.state.venue.waitUntil(chain + ' to apply shared list seq ' + seq, async () => {
        refreshMirror(chain);
        mapping = await mirrorIndex(chain);
        const rows = await drive.state.venue.queryIndexerDb(chain,
            "SELECT transfer_id, block_index FROM bridge_settlements WHERE kind = 'list' " +
            'AND src_chain = ? AND src_action_index = ? AND transfer_id = ? LIMIT 1',
            ['DOGE', String(home.rootIndex), String(snapshot.snapshot_id)]);
        applied = rows[0] || null;
        return !!mapping && !!applied;
    }, { timeoutMs: 35 * 60 * 1000, everyMs: 3000 });
    const tip = Number((await drive.state.venue.venueTips())[chain]);
    const list = await drive.state.venue.indexerRpc(chain, 'getlistat',
        { list_index: Number(mapping.action_index), block: tip });
    return { snapshot, mapping, applied, list };
}

async function listOrigin(chain, listIndex) {
    const rows = await drive.state.venue.queryIndexerDb(chain,
        'SELECT l.type AS type, ad.address AS source FROM lists l ' +
        'INNER JOIN actions a ON (a.action_index = l.action_index) ' +
        'LEFT JOIN index_addresses ad ON (ad.id = a.source_id) WHERE l.action_index = ? LIMIT 1',
        [String(listIndex)]);
    return rows[0] || null;
}

async function freshInputs(from, count) {
    await onChain('DOGE', async () => {
        const before = await utxoTrackerConnector.getUtxosFromAddress(from.address);
        const opening = spendableInputCount(before && before.utxos);
        const needed = freshInputCount(count);
        for (let i = 0; i < needed; i++) {
            const tx = await regtestMinerConnector.sendFunds(from.address, 1);
            await nodeConnector.waitForTx(tx, 60000);
        }
        await drive.state.venue.waitUntil(needed + ' fresh DOGE list-owner inputs', async () => {
            const now = await utxoTrackerConnector.getUtxosFromAddress(from.address);
            return spendableInputCount(now && now.utxos) >= opening + needed;
        }, { timeoutMs: 180000, everyMs: 1000 });
        transactionState.verifiedUtxos = null;
        transactionState.verifiedUtxosAddress = null;
    });
}

async function oneDogeBlock(from, wires) {
    await freshInputs(from, wires.length);
    const txs = await onChain('DOGE', () => withMiningPaused(regtestMinerConnector, async () => {
        const sent = [];
        for (const wire of wires) sent.push(await drive.transactionHelper.createAndSendTransaction(from, wire));
        await regtestMinerConnector.generateBlocks(1);
        return sent;
    }, { pauseFile: process.env.BRIDGE_RAIL_DOGE_MINER_PAUSE_FILE || '' }));
    const results = [];
    for (const tx of txs) {
        const got = await verdictOf(drive.state.venue.dogeVenue, 'lists', tx);
        drive.assert.ok(got, 'the venue DOGE indexer never graded LIST tx ' + tx);
        results.push({ tx, status: got.status, actionIndex: got.actionIndex });
    }
    return results;
}

function gateReadings() {
    const registry = require('../../../helpers/bridgeSettleContext').loadIndexerModule('src/protocol_changes.js');
    const venues = () => ({
        BTC: drive.state.venue.btcVenue,
        LTC: drive.state.venue.ltcVenue,
        DOGE: drive.state.venue.dogeVenue,
    });
    return drive.state.venue.venueTips().then((tips) => CHAINS.flatMap((chain) =>
        venues()[chain].indexers.flatMap((indexer) => LIST_GATES.concat(MIRROR_GATE).map((key) => ({
            chain, indexer: indexer.index, key, height: tips[chain],
            armed: registry.activeAt(key, NETWORK, chain, Number(tips[chain]), null),
        })))));
}

module.exports = Object.assign({ DRIVE, CHAINS, LIST_GATES, MIRROR_GATE }, drive, {
    listCreateWire, listEditWire, listShareWire, listTransferWire, issueListsWire, sendWire,
    chainAction, fundChain, newAddress, sharedBtcLtcAddress, pickFreeTick, hubListRows, waitForFinalizedSeq,
    mirrorIndex, waitForMirrorSeq, listOrigin, oneDogeBlock, gateReadings,
});
