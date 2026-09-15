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
 * XChain Platform E2E - chunked DEPLOY, order-independent assembly (AT1/AT2/AT4/AT5)
 *
 * A chunked contract is N+1 independent transactions: one DEPLOY v4 carrier per
 * base64 slice plus one assembling DEPLOY v2 carrying the CODE_HASH. Nothing on
 * chain orders them - the pieces are funded from separate inputs, so consensus
 * imposes no order - and before DEPLOY_DEFERRED_ASSEMBLY an assembler that landed
 * ahead of its carriers was permanently invalid, its fee spent and nothing
 * retrying. That happened twice for real: once on Bitcoin testnet4 from a client
 * that broadcast all three pieces at once, and once on regtest to a correctly
 * SEQUENCED deploy that a reorg re-packed assembler-first (chunkedDeployReorgDrill,
 * reorg contract (b)) - which is why no client-side discipline closes it.
 *
 * The rule this drill pins: a group (source, code_hash) deploys exactly once,
 * deterministically, in the block where its LAST piece confirms, whatever order
 * the pieces arrive in. The completing action C owns the contract (its
 * action_index and its derived address C:<CHAIN>:<C>); the assembler A lands
 * `pending: CODE_HASH (awaiting chunks)`, pays its base fee, and is consumed when
 * some later action completes the group (contract_executions.assembler_action_index
 * = A on the constructor row at C).
 *
 * Each `it` is one acceptance test of the spec:
 *   AT1  assembler, chunk 1, chunk 0 in ONE block, in that order
 *   AT2  three chunks and the assembler spread across blocks in reverse
 *   AT4  duplicate assemblers and a duplicate carrier
 *   AT5  orphan the completing carrier's block, then replay the window REORDERED
 *
 * HOW THE ORDER IS OWNED. Every piece is built from its OWN confirmed input (no
 * piece spends another's change, asserted rather than assumed), broadcast without
 * waiting on the indexer, and then placed with generateblock(payout, [rawhex...]),
 * which takes raw hex and ignores the mempool - see test/sdk/helpers/rawHexBlocks.js,
 * shared with the reorg drill. Consequences of that choice, learned there:
 *
 *   - Auto-mining is HELD for the whole suite and every block is placed by hand,
 *     so an ancestor-feerate repack can never decide the order under test.
 *   - A whole acceptance test lives in ONE `it`: initialCheck's root afterEach
 *     quiesce mines the mempool whenever it is non-empty (an explicit
 *     generate_blocks, which pauseMining does NOT hold), so a test boundary
 *     between a broadcast and its block would hand the ordering to the packer.
 *   - Indexer waits never nudge a block while pieces are unconfirmed, for the
 *     same reason; they poll only.
 *   - On a shared venue another suite's quiesce can still swallow a piece.
 *     placeBlockInOrder verifies every named transaction landed in the block it
 *     built, so that failure names itself instead of passing as a reorder.
 *
 * VENUE: BTC regtest (raw-hex generateblock ordering plus an empty-chain reorg;
 * DOGE regtest uses a different mining model and LTC's native-fee mode is AT8's
 * subject, not this file's). Needs the indexer's DEPLOY_DEFERRED_ASSEMBLY gate,
 * which is active from height 0 on regtest. Node 22.
 *
 * Run (host with regtest stack + Node 22). It rides `npm run test:sdk` (whose glob
 * is test/sdk/(**)/*.sdk.test.js); on its own:
 *     COIN=bitcoin NETWORK=regtest npx mocha --timeout 0 --exit \
 *         --require ./test/initialCheck.test.js test/sdk/chunkedDeployDeferred.sdk.test.js
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const cryptoHelper = require('../../cryptoHelper');
const { makeSdk, deployContract, fundedGasAddress, mine, submitOpts, uniqueTick } = require('../sdkHelper');
const { snapshotWindow, replayWindowInOrder, unconfirmedAncestors, placeBlockInOrder } = require('../helpers/rawHexBlocks');
const { chunkHelper } = require('xchain-sdk');

// The consensus status strings this spec adds, spelled out rather than imported:
// a test that reads the string from the code that writes it proves nothing.
const PENDING_STATUS   = 'pending: CODE_HASH (awaiting chunks)';
const DUPLICATE_STATUS = 'invalid: CODE_HASH (duplicate pending)';

// Fee payment mode on a gas chain (BTC): 2 = XCHAIN, 1 = native coin.
const FEE_MODE_XCHAIN = 2;

const GAS_LIMIT = 400000;
const START     = 5;

// Pad sizes measured against chunkHelper.planDeploy (2026-09-07, gasLimit 400000,
// one constructor param): 7000 source bytes plan to 2 chunks and 13000 to 3. Each
// test asserts the count it got, so an SDK change to the per-carrier budget fails
// here instead of quietly reducing the drill to a smaller group.
const PAD_2CHUNK = 7000;
const PAD_3CHUNK = 13000;

// Orphan-depth ceiling, same reasoning as the reorg drill: past the utxo-tracker's
// UNDO_BLOCKS=12 spent-output recovery window a rollback halts the tracker
// fail-closed and wedges the venue for every other suite, so the guard fires
// before any invalidateblock. AT5 orphans exactly one block.
const ORPHAN_DEPTH_LIMIT = 12;

// A contract too large for a single DEPLOY: the string literal survives (it is
// code, not a comment), `padlen` proves byte-exact reassembly and `run` proves the
// rebuilt contract is THIS run's source. A per-run marker makes the code_hash - and
// so the group every query below resolves - unique to one test, which is what keeps
// AT4's "contracts count unchanged" and AT5's rollback counts honest on a stack
// that has run this file before.
function sourceFor(run, padBytes) {
    return [
        'var PAD = "' + 'x'.repeat(padBytes) + '";',
        'var RUN = "' + run + '";',
        'module.exports = {',
        "  meta: { name: 'Chunked Counter Deferred', description: 'Per-run padded counter reassembled by the deferred chunked DEPLOY path.', version: '1.0.0' },",
        '  initialize: function (xchain) {',
        '    var start = xchain.getInputParam(0);',
        '    xchain.state.set("count", String(parseInt(start) || 0));',
        '    xchain.state.set("padlen", String(PAD.length));',
        '    xchain.state.set("run", RUN);',
        '  },',
        '  increment: function() {',
        '    xchain.state.set("count", String(parseInt(xchain.state.get("count")) + 1));',
        '  }',
        '};'
    ].join('\n');
}

function haveConnectors() {
    return global.nodeConnector && global.regtestMinerConnector && global.indexerDatabase;
}

async function idxQuery(sql, params) {
    const conn = await global.indexerDatabase.getConnection();
    try { return await conn.query(sql, params); } finally { await conn.release(); }
}
async function idxCount(sql, params) { return Number((await idxQuery(sql, params))[0].n); }

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Poll until `fn()` is truthy. Deliberately mines NOTHING: pieces of the group
// under test may be sitting unconfirmed while this waits, and a nudge block would
// let the miner pack them in ITS order rather than the one under test. Throws so a
// stall names the step it was waiting on rather than surfacing as a later
// assertion on an empty row set.
async function waitFor(fn, what, timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const got = await fn();
        if (got) return got;
        if (Date.now() >= deadline) throw new Error('timed out after ' + (timeoutMs / 1000) + 's waiting for ' + what);
        await sleep(1000);
    }
}

/* ---------------------------------------------------------------- indexer reads */

// The indexer's dense address id for an address; every group query is scoped by it
// because assembly is source-bound and two addresses may hold the same code_hash.
async function addressId(address) {
    const rows = await idxQuery('SELECT id FROM index_addresses WHERE address = ?', [address]);
    return rows.length ? Number(rows[0].id) : null;
}

// action_index of the action carried by a broadcast transaction. Binds every
// assertion below to a transaction this drill signed, rather than to whichever row
// happened to match a status.
async function actionIndexOfTx(txid) {
    const rows = await idxQuery(
        'SELECT a.action_index FROM actions a ' +
        'INNER JOIN transactions t ON t.tx_index = a.tx_index ' +
        'INNER JOIN index_transactions it ON it.id = t.tx_hash_id ' +
        'WHERE it.hash = ?', [txid]);
    return rows.length ? Number(rows[0].action_index) : null;
}

// Every contracts row of a group, pending and deployed alike, oldest first.
async function contractRows(srcId, codeHash) {
    const rows = await idxQuery(
        'SELECT c.action_index, c.code_hash, s.status FROM contracts c ' +
        'LEFT JOIN index_statuses s ON s.id = c.status_id ' +
        'WHERE c.source_id = ? AND c.code_hash = ? ORDER BY c.action_index ASC', [srcId, codeHash]);
    return rows.map(r => ({ action_index: Number(r.action_index), code_hash: r.code_hash, status: r.status }));
}

// One contracts row by its own action_index. A REJECTED assembler is not a member
// of its group in the table: like every other invalid assembler, its row stores
// sha256('') as code_hash (only a PENDING landing stores the declared hash, R2.3),
// so a group query by declared hash never sees it and it must be read by index.
async function contractRowAt(actionIndex) {
    const rows = await idxQuery(
        'SELECT c.action_index, c.code_hash, s.status FROM contracts c ' +
        'LEFT JOIN index_statuses s ON s.id = c.status_id WHERE c.action_index = ?', [actionIndex]);
    return rows.length ? { action_index: Number(rows[0].action_index), code_hash: rows[0].code_hash, status: rows[0].status } : null;
}

async function executionRow(actionIndex) {
    const rows = await idxQuery(
        'SELECT e.action_index, e.contract_index, e.method_name, e.gas_used, e.gas_limit, ' +
        '       e.assembler_action_index, e.fee_payment_mode, s.status ' +
        'FROM contract_executions e LEFT JOIN index_statuses s ON s.id = e.status_id ' +
        'WHERE e.action_index = ?', [actionIndex]);
    if (!rows.length) return null;
    const r = rows[0];
    return {
        action_index:           Number(r.action_index),
        contract_index:         r.contract_index === null ? null : Number(r.contract_index),
        method_name:            r.method_name,
        gas_used:               Number(r.gas_used),
        gas_limit:              Number(r.gas_limit),
        assembler_action_index: r.assembler_action_index === null ? null : Number(r.assembler_action_index),
        fee_payment_mode:       r.fee_payment_mode === null ? null : Number(r.fee_payment_mode),
        status:                 r.status,
    };
}

async function chunkRows(srcId, codeHash) {
    const rows = await idxQuery(
        'SELECT dc.action_index, dc.chunk_index, s.status FROM deploy_chunks dc ' +
        'LEFT JOIN index_statuses s ON s.id = dc.status_id ' +
        'WHERE dc.source_id = ? AND dc.code_hash = ? ORDER BY dc.action_index ASC', [srcId, codeHash]);
    return rows.map(r => ({ action_index: Number(r.action_index), chunk_index: Number(r.chunk_index), status: r.status }));
}

// The contract's whole state, in write order, as plain values: this is what AT1
// compares byte for byte against a normally-ordered deploy of the same source.
async function stateRows(contractIndex) {
    const rows = await idxQuery(
        'SELECT state_key, state_value FROM contract_state WHERE contract_index = ? ORDER BY id ASC', [contractIndex]);
    return rows.map(r => ({ state_key: r.state_key, state_value: r.state_value }));
}

async function permissionCount(contractIndex) {
    return idxCount('SELECT COUNT(*) n FROM contract_permissions WHERE contract_index = ?', [contractIndex]);
}

async function readState(sdk, contractIndex, key) {
    const state = await sdk.getContractState(contractIndex, key);
    const rows = (state && state.data) || [];
    const row = rows.find(r => r.state_key === key);
    return row ? JSON.parse(row.state_value) : undefined;
}

// The explorer's action detail, unwrapped from whichever envelope it arrives in.
// `deployed_contract_index` is a LATER milestone (the explorer surfaces land before
// the testnet flag day), so the assertions that read it are conditional on the
// field existing and say so when it does not: a missing field is a milestone that
// has not landed, not a consensus failure, and failing on it here would red this
// drill for work it does not own.
async function actionDetail(sdk, actionIndex) {
    let body = null;
    try { body = await sdk.getAction(actionIndex); } catch (e) { return null; }
    if (!body) return null;
    let d = (body.data !== undefined && body.data !== null) ? body.data : body;
    // db.getAction answers a single-element array and some envelopes nest the row
    // under `action`; on this explorer `action` is the NAME string ("DEPLOY"), so
    // only an object carrying action_index is the row, never the string.
    if (Array.isArray(d)) d = d.length ? d[0] : null;
    if (d && typeof d === "object" && d.action && typeof d.action === "object"
        && d.action.action_index !== undefined) d = d.action;
    return (d && typeof d === "object") ? d : null;
}
function expectDeployedContractIndex(detail, expected, label) {
    if (!detail || !Object.prototype.hasOwnProperty.call(detail, 'deployed_contract_index')) {
        console.log('    [deferred] explorer field deployed_contract_index absent; ' + label +
                    ' assertion SKIPPED (explorer milestone not landed)');
        return false;
    }
    expect(detail.deployed_contract_index === null ? null : Number(detail.deployed_contract_index),
        label).to.equal(expected);
    return true;
}

/* ------------------------------------------------------------- piece plumbing */

// One confirmed input per piece. The whole point of the rule under test is that a
// client may fire all N+1 pieces at once, which needs N+1 spendable inputs: pieces
// chained parent-to-child could not be placed out of order at all (a block must
// list a parent first), so a chained funding set would silently turn every
// ordering assertion below into a tautology.
async function fundIndependentInputs(sdk, pieces) {
    // The gas leg (fundedGasAddress -> mintGas) goes through sdkHelper's submit(),
    // which broadcasts and then waits on the indexer for up to 120s; submit's
    // quiesce runs BEFORE the broadcast, so under the suite-wide mining hold
    // nothing confirms that MINT and every caller died at the timeout. Funding
    // runs before this round's first piece is broadcast, so an auto-mined block
    // here cannot disturb the deterministic placement below; the hold is restored
    // before returning, and the suite's miningPaused flag stays true throughout.
    try { await global.regtestMinerConnector.resumeMining(); } catch (e) { /* best effort */ }
    let addr;
    try {
        addr = await fundedGasAddress(sdk, 1);
        for (let i = 0; i < pieces; i++) await global.regtestMinerConnector.sendFunds(addr.address, 1);
    } finally {
        await global.regtestMinerConnector.pauseMining();
    }
    await mine(1);
    await waitFor(async () => (await spendableUtxos(sdk, addr.address)).length >= pieces,
        pieces + ' independent confirmed inputs at ' + addr.address, 180000);
    return addr;
}

// UTXOs in the shape createTx({ utxos }) demands: the encoder's validateUtxoEntry
// rejects an entry without scriptPubKey, so these come from the encoder's own
// get_utxos rather than being rebuilt from a node or tracker read.
async function spendableUtxos(sdk, address) {
    const res = await sdk.encoder.getUTXOs(address);
    const list = (res && res.utxos) || [];
    return list.filter(u => u && u.scriptPubKey && (u.confirmations === undefined || Number(u.confirmations) >= 1));
}

// Hand-select one input per piece, largest first, so a piece never competes with
// its siblings for the same coin and the encoder never falls back to a set that
// includes another piece's change.
async function pickInputs(sdk, address, count) {
    const utxos = await spendableUtxos(sdk, address);
    utxos.sort((a, b) => Number(b.value) - Number(a.value));
    expect(utxos.length, 'confirmed inputs available at ' + address).to.be.at.least(count);
    return utxos.slice(0, count);
}

function assemblerAction(plan) {
    return { action: 'DEPLOY', params: { version: '2', codeHash: plan.codeHash, gasLimit: GAS_LIMIT, constructorParams: [String(START)] } };
}
function carrierAction(plan, i) {
    return { action: 'DEPLOY', params: { version: '4', codeHash: plan.codeHash, chunkIndex: i, totalChunks: plan.totalChunks, codePart: plan.parts[i] } };
}

// Build, sign and broadcast one piece from ONE named input, without waiting on the
// indexer. sdk.submitAction is called directly rather than through sdkHelper's
// submit(): that wrapper quiesces first, and quiesce mines the mempool whenever it
// is non-empty, which would confirm the sibling pieces already broadcast in this
// round before this drill has chosen their block.
async function broadcastPiece(sdk, deployer, actionData, utxo) {
    const res = await sdk.submitAction(actionData,
        { pubkey: deployer.address, change: deployer.address, utxos: [utxo] },
        submitOpts({ wif: deployer.wif, waitForIndexer: false, requireValid: false }));
    return res.txid;
}

// No piece may spend any other piece's output, directly or through its own funding
// transaction: the ordering under test only exists between transactions consensus
// leaves unordered. Measured off the mempool rather than off the intent.
async function assertIndependentPieces(node, txids) {
    const sets = [];
    for (const txid of txids) sets.push(new Set((await unconfirmedAncestors(node, [txid])).concat([txid])));
    for (let i = 0; i < sets.length; i++) {
        for (let j = i + 1; j < sets.length; j++) {
            for (const t of sets[i]) {
                expect(sets[j].has(t), 'pieces must be funded from INDEPENDENT inputs; ' + t.slice(0, 12) +
                    ' is shared between piece ' + i + ' and piece ' + j).to.equal(false);
            }
        }
    }
}

module.exports = {
    expect, cryptoHelper, makeSdk, deployContract, fundedGasAddress, mine, submitOpts, uniqueTick,
    snapshotWindow, replayWindowInOrder, unconfirmedAncestors, placeBlockInOrder, chunkHelper,
    PENDING_STATUS, DUPLICATE_STATUS, FEE_MODE_XCHAIN, GAS_LIMIT, START, PAD_2CHUNK, PAD_3CHUNK,
    ORPHAN_DEPTH_LIMIT, sourceFor, haveConnectors, idxQuery, idxCount, sleep, waitFor, addressId,
    actionIndexOfTx, contractRows, contractRowAt, executionRow, chunkRows, stateRows, permissionCount,
    readState, actionDetail, expectDeployedContractIndex, fundIndependentInputs, spendableUtxos,
    pickInputs, assemblerAction, carrierAction, broadcastPiece, assertIndependentPieces,
};
