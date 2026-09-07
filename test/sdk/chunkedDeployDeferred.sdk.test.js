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
const cryptoHelper = require('../cryptoHelper');
const { makeSdk, deployContract, fundedGasAddress, mine, submitOpts, uniqueTick } = require('./sdkHelper');
const { snapshotWindow, replayWindowInOrder, unconfirmedAncestors, placeBlockInOrder } = require('./helpers/rawHexBlocks');
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

describe('[sdk] chunked DEPLOY deferred assembly (a group deploys at its LAST piece, in any order)', function () {
    this.timeout(0);

    let sdk, payout, miningPaused = false;
    // A normally-ordered deploy of AT1's source, from a different address: the
    // reference AT1's out-of-order deploy is compared against.
    let refPlan, refContractIndex, refState, refGasUsed, refRun;

    async function pauseMining() {
        await global.regtestMinerConnector.pauseMining();
        miningPaused = true;
    }
    async function resumeMining() {
        if (!miningPaused) return;
        miningPaused = false;
        try { await global.regtestMinerConnector.resumeMining(); } catch (e) { /* best effort */ }
    }

    before(async function () {
        if (!haveConnectors()) this.skip();
        // Raw-hex placement plus an empty competing chain is the BTC/LTC mechanism;
        // DOGE regtest mines on a different model. LTC would exercise the native-fee
        // split, which is AT8's subject in the indexer unit tier, not this file's.
        if (global.COIN_CODE !== 'BTC') this.skip();

        sdk = makeSdk();
        payout = (await cryptoHelper.getNewAddress('chunk-deferred-miner', COIN, NETWORK, null, 'legacy', 0)).address;

        // AT1 asserts the deferred contract's state is byte-identical to the same
        // source deployed the ordinary way. "Inline" is not available to a source
        // that needs chunking at all, so the reference is the SEQUENTIAL path: every
        // carrier confirmed before the assembler, which completes the group from
        // lower carriers and deploys at its own index (R2.1, assembler_action_index
        // NULL). Different address, so it is a different group and cannot interfere.
        refRun = uniqueTick('CDR');
        const refSrc = sourceFor(refRun, PAD_2CHUNK);
        refPlan = chunkHelper.planDeploy(refSrc, { gasLimit: GAS_LIMIT, constructorParams: [String(START)] });
        expect(refPlan.single, 'reference source must NOT fit a single DEPLOY').to.equal(false);
        expect(refPlan.totalChunks, 'reference source plans to 2 chunks').to.equal(2);

        const refDeployer = await fundedGasAddress(sdk, 1);
        const res = await deployContract(sdk,
            { code: refSrc, gasLimit: GAS_LIMIT, constructorParams: [String(START)] },
            { pubkey: refDeployer.address, change: refDeployer.address },
            submitOpts({ wif: refDeployer.wif }));
        expect(res.indexed.status, 'sequential reference deploy indexed').to.equal('valid');
        await mine(1);

        const refSrcId = await addressId(refDeployer.address);
        const rows = await waitFor(async () => {
            const found = (await contractRows(refSrcId, refPlan.codeHash)).filter(r => r.status === 'valid');
            return found.length ? found : null;
        }, 'the sequential reference contract to index valid');
        refContractIndex = rows[0].action_index;

        const refExec = await executionRow(refContractIndex);
        expect(refExec, 'reference constructor execution row').to.not.equal(null);
        expect(refExec.assembler_action_index,
            'a sequential deploy completes from lower carriers at its own index (R2.1), so nothing was consumed')
            .to.equal(null);
        refGasUsed = refExec.gas_used;
        refState   = await stateRows(refContractIndex);
        expect(refState.length, 'reference constructor wrote state').to.be.greaterThan(0);

        console.log('    [deferred] reference contract=' + refContractIndex + ' hash=' + refPlan.codeHash.slice(0, 12) +
                    ' gas_used=' + refGasUsed + ' state_rows=' + refState.length);

        // Auto-mining is held only from HERE, once the reference deploy is on chain.
        // It cannot be held across the reference: that leg goes through submit(),
        // which broadcasts and then waits on the indexer, and the only thing that
        // would confirm it is the auto-miner (submit's quiesce runs BEFORE the
        // broadcast, and deployContract's mine() only after the wait returns). Held
        // from the top, every reference piece timed out at 120s and the hook died.
        // The `it`s below place their own blocks, so the hold starts where the
        // deterministic placement does.
        await pauseMining();
    });

    // Auto-mining is held for the whole suite; never leave it held.
    after(async function () { await resumeMining(); });

    it('AT1 assembler, chunk 1, chunk 0 in ONE block in that order: the contract deploys at the chunk-0 carrier', async function () {
        const node = global.nodeConnector;
        const run  = refRun;                                   // the reference's source, so the state comparison is exact
        const src  = sourceFor(run, PAD_2CHUNK);
        const plan = chunkHelper.planDeploy(src, { gasLimit: GAS_LIMIT, constructorParams: [String(START)] });
        expect(plan.codeHash, 'AT1 deploys the same source as the reference').to.equal(refPlan.codeHash);

        const deployer = await fundIndependentInputs(sdk, 3);
        const srcId    = await addressId(deployer.address);
        const inputs   = await pickInputs(sdk, deployer.address, 3);

        // All three pieces on the wire before any of them is mined: this is the
        // parallel broadcast the rule exists to make safe.
        const asmTx = await broadcastPiece(sdk, deployer, assemblerAction(plan), inputs[0]);
        const c1Tx  = await broadcastPiece(sdk, deployer, carrierAction(plan, 1), inputs[1]);
        const c0Tx  = await broadcastPiece(sdk, deployer, carrierAction(plan, 0), inputs[2]);
        await assertIndependentPieces(node, [asmTx, c1Tx, c0Tx]);

        // The order no client and no miner would choose: the assembler first.
        await placeBlockInOrder(node, payout, [asmTx, c1Tx, c0Tx],
            { log: (m) => console.log('    [deferred] AT1 ' + m) });

        const chunks = await waitFor(async () => {
            const rows = await chunkRows(srcId, plan.codeHash);
            return rows.length === 2 ? rows : null;
        }, 'both DEPLOY v4 carriers to index');
        expect(chunks.every(r => r.status === 'valid'), 'both carriers stored valid').to.equal(true);

        const A = await actionIndexOfTx(asmTx);
        const C = await actionIndexOfTx(c0Tx);
        const c1Index = await actionIndexOfTx(c1Tx);
        expect(A, 'the assembler indexed').to.not.equal(null);
        expect(A, 'the assembler really is FIRST in the block').to.be.lessThan(c1Index);
        expect(c1Index, 'chunk 0 really is LAST in the block').to.be.lessThan(C);
        expect(chunks.find(r => r.chunk_index === 0).action_index, 'C is the chunk-0 carrier').to.equal(C);

        const contracts = await waitFor(async () => {
            const rows = await contractRows(srcId, plan.codeHash);
            return rows.length === 2 ? rows : null;
        }, 'the pending assembler row and the deployed contract row');

        const pending  = contracts.find(r => r.action_index === A);
        const deployed = contracts.find(r => r.action_index === C);
        expect(pending,  'a contracts row at the assembler').to.not.equal(undefined);
        expect(deployed, 'a contracts row at the completing carrier').to.not.equal(undefined);
        expect(pending.status,  'the assembler landed pending, not invalid').to.equal(PENDING_STATUS);
        expect(deployed.status, 'the contract deployed at the completing carrier').to.equal('valid');

        // The constructor row sits at C and names the assembler it consumed.
        const exec = await executionRow(C);
        expect(exec, 'constructor execution row at C').to.not.equal(null);
        expect(exec.contract_index, 'the contract IS the completing action').to.equal(C);
        expect(exec.assembler_action_index, 'the constructor row names the assembler it consumed').to.equal(A);
        expect(exec.status, 'the deferred deploy is valid').to.equal('valid');

        // The assembler paid the BASE fee at its own landing and nothing more: its
        // row carries gas but strictly less than a complete deploy of the same
        // source, whose gas is base + constructor.
        const pendingExec = await executionRow(A);
        expect(pendingExec, 'the pending assembler has its own execution row').to.not.equal(null);
        expect(pendingExec.assembler_action_index, 'the assembler consumed nothing itself').to.equal(null);
        expect(pendingExec.fee_payment_mode, 'the assembler recorded the mode it paid in (XCHAIN on a gas chain)').to.equal(FEE_MODE_XCHAIN);
        expect(pendingExec.gas_used, 'the assembler was charged base gas at A').to.be.greaterThan(0);
        expect(pendingExec.gas_used, 'base gas only: strictly less than base + constructor').to.be.lessThan(refGasUsed);

        // Byte-for-byte the same state as the same source deployed in order.
        expect(await stateRows(C), 'deferred assembly produced identical constructor state').to.deep.equal(refState);
        expect(await readState(sdk, C, 'run'), 'the explorer resolves the contract at the CARRIER index').to.equal(run);

        // Explorer surfaces: a later milestone, asserted only where present. Where the
        // field IS present the whole D48 contract is asserted, not just the index: the
        // clients poll `assembly_status` to know when to stop, and a carrier page that
        // names the contract but carries none of its fields renders no deploy card.
        const asmDetail = await actionDetail(sdk, A);
        if (expectDeployedContractIndex(asmDetail, C, 'assembler page resolves deployed_contract_index = C'))
            expect(String(asmDetail.assembly_status),
                'the assembler page reports the group as assembled').to.equal('valid');
        const carrierDetail = await actionDetail(sdk, C);
        if (carrierDetail && Object.prototype.hasOwnProperty.call(carrierDetail, 'deployed_contract_index')) {
            expect(Number(carrierDetail.deployed_contract_index), 'the carrier page exposes its own contract').to.equal(C);
            expect(Number(carrierDetail.assembler_action_index),
                'the carrier deploy card names the assembler it completed').to.equal(A);
            expect(String(carrierDetail.contract_status),
                'the carrier deploy card carries the contract status').to.equal('valid');
        } else {
            console.log('    [deferred] AT1 carrier deploy-card assertion SKIPPED (explorer milestone not landed)');
        }

        console.log('    [deferred] AT1 A=' + A + ' chunk1=' + c1Index + ' C=' + C +
                    ' pending_gas=' + pendingExec.gas_used + ' (reference ' + refGasUsed + ')');
    });

    it('AT2 three chunks and the assembler across blocks in reverse: nothing deploys until the last piece', async function () {
        const node = global.nodeConnector;
        const run  = uniqueTick('CD2');
        const plan = chunkHelper.planDeploy(sourceFor(run, PAD_3CHUNK), { gasLimit: GAS_LIMIT, constructorParams: [String(START)] });
        expect(plan.totalChunks, 'AT2 needs 3 chunks').to.equal(3);

        const deployer = await fundIndependentInputs(sdk, 4);
        const srcId    = await addressId(deployer.address);
        const inputs   = await pickInputs(sdk, deployer.address, 4);

        const asmTx = await broadcastPiece(sdk, deployer, assemblerAction(plan), inputs[0]);
        const c2Tx  = await broadcastPiece(sdk, deployer, carrierAction(plan, 2), inputs[1]);
        const c1Tx  = await broadcastPiece(sdk, deployer, carrierAction(plan, 1), inputs[2]);
        const c0Tx  = await broadcastPiece(sdk, deployer, carrierAction(plan, 0), inputs[3]);
        await assertIndependentPieces(node, [asmTx, c2Tx, c1Tx, c0Tx]);

        const log = (m) => console.log('    [deferred] AT2 ' + m);
        const noValidYet = async (where) => {
            const valid = (await contractRows(srcId, plan.codeHash)).filter(r => r.status === 'valid');
            expect(valid.length, 'no contract may exist ' + where).to.equal(0);
        };

        // Block 1: the LAST chunk, alone. A group missing every other position.
        await placeBlockInOrder(node, payout, [c2Tx], { log });
        await waitFor(async () => (await chunkRows(srcId, plan.codeHash)).length === 1, 'chunk 2 to index');
        await noValidYet('after the highest chunk alone');

        // Block 2: the assembler, in the middle, with two positions still missing.
        await placeBlockInOrder(node, payout, [asmTx], { log });
        const A = await waitFor(async () => actionIndexOfTx(asmTx), 'the assembler to index');
        await waitFor(async () => {
            const rows = await contractRows(srcId, plan.codeHash);
            return rows.length === 1 ? rows : null;
        }, 'the assembler to land pending');
        expect((await contractRows(srcId, plan.codeHash))[0].status,
            'an assembler with an incomplete group lands pending, not invalid').to.equal(PENDING_STATUS);
        await noValidYet('while the group is still missing chunks 0 and 1');

        // Block 3: chunk 1. Still one position short.
        await placeBlockInOrder(node, payout, [c1Tx], { log });
        await waitFor(async () => (await chunkRows(srcId, plan.codeHash)).length === 2, 'chunk 1 to index');
        await noValidYet('while the group is still missing chunk 0');

        // Block 4: chunk 0 completes the group and deploys it, here.
        await placeBlockInOrder(node, payout, [c0Tx], { log });
        const C = await waitFor(async () => actionIndexOfTx(c0Tx), 'chunk 0 to index');
        const contracts = await waitFor(async () => {
            const rows = await contractRows(srcId, plan.codeHash);
            return rows.length === 2 ? rows : null;
        }, 'the deployed contract row at the completing carrier');

        expect(contracts.find(r => r.action_index === A).status, 'the assembler keeps its pending status').to.equal(PENDING_STATUS);
        const deployed = contracts.find(r => r.action_index === C);
        expect(deployed, 'a contracts row at the last piece').to.not.equal(undefined);
        expect(deployed.status, 'the group deployed at the LAST piece').to.equal('valid');

        const exec = await executionRow(C);
        expect(exec.contract_index, 'the contract is the last piece').to.equal(C);
        expect(exec.assembler_action_index, 'the constructor row names the assembler two blocks back').to.equal(A);
        expect(await readState(sdk, C, 'run'), 'the reassembled source is this run\'s').to.equal(run);
        console.log('    [deferred] AT2 chunk2 < A=' + A + ' < chunk1 < C=' + C + ' across 4 blocks in reverse');
    });

    it('AT4 duplicates: a second pending assembler is rejected, a later assembler deploys again, a duplicate carrier deploys nothing', async function () {
        const node = global.nodeConnector;
        const run  = uniqueTick('CD4');
        const plan = chunkHelper.planDeploy(sourceFor(run, PAD_2CHUNK), { gasLimit: GAS_LIMIT, constructorParams: [String(START)] });
        expect(plan.totalChunks, 'AT4 needs 2 chunks').to.equal(2);

        const deployer = await fundIndependentInputs(sdk, 6);
        const srcId    = await addressId(deployer.address);
        const inputs   = await pickInputs(sdk, deployer.address, 6);
        const log = (m) => console.log('    [deferred] AT4 ' + m);

        // (i) two assemblers for the same group, one block, nothing else landed yet.
        const asm1Tx = await broadcastPiece(sdk, deployer, assemblerAction(plan), inputs[0]);
        const asm2Tx = await broadcastPiece(sdk, deployer, assemblerAction(plan), inputs[1]);
        await assertIndependentPieces(node, [asm1Tx, asm2Tx]);
        await placeBlockInOrder(node, payout, [asm1Tx, asm2Tx], { log });

        const A1 = await waitFor(async () => actionIndexOfTx(asm1Tx), 'the first assembler to index');
        const A2 = await waitFor(async () => actionIndexOfTx(asm2Tx), 'the second assembler to index');
        // The pending row is a group member (declared hash); the rejected one is
        // read by its own index, see contractRowAt. Group counts below exclude it.
        await waitFor(async () => (await contractRows(srcId, plan.codeHash)).length === 1, 'the pending assembler row to index');
        const rejected = await waitFor(async () => contractRowAt(A2), 'the rejected assembler row to index');
        let contracts = await contractRows(srcId, plan.codeHash);
        expect(contracts.find(r => r.action_index === A1).status, 'the first assembler lands pending').to.equal(PENDING_STATUS);
        expect(rejected.status, 'a second assembler while one is pending is rejected').to.equal(DUPLICATE_STATUS);
        expect(rejected.code_hash, 'a rejected assembler stores the empty-code hash like every invalid assembler')
            .to.not.equal(plan.codeHash);

        // (ii) the carriers complete the group; only the FIRST assembler is consumed.
        const c1Tx = await broadcastPiece(sdk, deployer, carrierAction(plan, 1), inputs[2]);
        const c0Tx = await broadcastPiece(sdk, deployer, carrierAction(plan, 0), inputs[3]);
        await assertIndependentPieces(node, [c1Tx, c0Tx]);
        await placeBlockInOrder(node, payout, [c1Tx, c0Tx], { log });

        const C = await waitFor(async () => actionIndexOfTx(c0Tx), 'the completing carrier to index');
        await waitFor(async () => (await contractRows(srcId, plan.codeHash)).length === 2, 'the deployed contract row');
        const firstExec = await executionRow(C);
        expect(firstExec.assembler_action_index, 'the FIRST assembler is the one consumed').to.equal(A1);
        expect((await contractRows(srcId, plan.codeHash)).find(r => r.action_index === C).status,
            'the group deployed at the completing carrier').to.equal('valid');

        // (iii) an assembler AFTER completion finds the group complete from lower
        // carriers and deploys a SECOND contract at its own index, consuming nothing.
        const asm3Tx = await broadcastPiece(sdk, deployer, assemblerAction(plan), inputs[4]);
        await placeBlockInOrder(node, payout, [asm3Tx], { log });
        const A3 = await waitFor(async () => actionIndexOfTx(asm3Tx), 'the post-completion assembler to index');
        await waitFor(async () => (await contractRows(srcId, plan.codeHash)).length === 3, 'the second contract row');
        contracts = await contractRows(srcId, plan.codeHash);
        expect(contracts.find(r => r.action_index === A3).status,
            'an assembler over a complete group deploys immediately').to.equal('valid');
        const secondExec = await executionRow(A3);
        expect(secondExec.contract_index, 'the second contract sits at the assembler\'s own index').to.equal(A3);
        expect(secondExec.assembler_action_index,
            'a self-completed deploy consumed no separate assembler').to.equal(null);

        // (iv) a duplicate carrier after completion is stored and deploys nothing.
        const contractsBefore = contracts.length;
        const dupTx = await broadcastPiece(sdk, deployer, carrierAction(plan, 0), inputs[5]);
        await placeBlockInOrder(node, payout, [dupTx], { log });
        const dupIndex = await waitFor(async () => actionIndexOfTx(dupTx), 'the duplicate carrier to index');
        const chunks = await waitFor(async () => {
            const rows = await chunkRows(srcId, plan.codeHash);
            return rows.length === 3 ? rows : null;
        }, 'the duplicate carrier row to be stored');
        expect(chunks.find(r => r.action_index === dupIndex).status,
            'a duplicate carrier is still stored valid').to.equal('valid');
        expect((await contractRows(srcId, plan.codeHash)).length,
            'a duplicate carrier deploys nothing').to.equal(contractsBefore);
        expect(await executionRow(dupIndex), 'a duplicate carrier writes no constructor row').to.equal(null);

        console.log('    [deferred] AT4 A1=' + A1 + ' (pending, consumed) A2=' + A2 + ' (duplicate) C=' + C +
                    ' A3=' + A3 + ' (second contract) dup=' + dupIndex);
    });

    it('AT5 orphaning the completing carrier rolls the contract back; replaying the window REORDERED re-deploys it at the new last piece', async function () {
        const node = global.nodeConnector;
        const run  = uniqueTick('CD5');
        const plan = chunkHelper.planDeploy(sourceFor(run, PAD_3CHUNK), { gasLimit: GAS_LIMIT, constructorParams: [String(START)] });
        expect(plan.totalChunks, 'AT5 needs 3 chunks').to.equal(3);

        const deployer = await fundIndependentInputs(sdk, 4);
        const srcId    = await addressId(deployer.address);
        const inputs   = await pickInputs(sdk, deployer.address, 4);
        const log = (m) => console.log('    [deferred] AT5 ' + m);

        const asmTx = await broadcastPiece(sdk, deployer, assemblerAction(plan), inputs[0]);
        const c2Tx  = await broadcastPiece(sdk, deployer, carrierAction(plan, 2), inputs[1]);
        const c1Tx  = await broadcastPiece(sdk, deployer, carrierAction(plan, 1), inputs[2]);
        const c0Tx  = await broadcastPiece(sdk, deployer, carrierAction(plan, 0), inputs[3]);
        await assertIndependentPieces(node, [asmTx, c2Tx, c1Tx, c0Tx]);

        // The assembler and one carrier land BELOW the block that will be orphaned,
        // so the rollback assertions can tell what must survive from what must go.
        await placeBlockInOrder(node, payout, [asmTx], { log });
        await placeBlockInOrder(node, payout, [c2Tx], { log });
        const completingBlock = await node.getBlockCount() + 1;
        await placeBlockInOrder(node, payout, [c1Tx, c0Tx], { log });

        const A = await waitFor(async () => actionIndexOfTx(asmTx), 'the assembler to index');
        const C = await waitFor(async () => actionIndexOfTx(c0Tx), 'the completing carrier to index');
        await waitFor(async () => (await contractRows(srcId, plan.codeHash)).length === 2, 'the deployed contract row');
        expect((await contractRows(srcId, plan.codeHash)).find(r => r.action_index === C).status,
            'the group deployed at the completing carrier').to.equal('valid');
        expect((await executionRow(C)).assembler_action_index, 'the constructor row names the assembler').to.equal(A);
        expect((await stateRows(C)).length, 'the constructor wrote state').to.be.greaterThan(0);
        const permsBefore = await permissionCount(C);

        // --- orphan the completing carrier's block, and replay it REORDERED, in ONE
        // `it`: a test boundary here hands the resurrected window to the quiesce hook.
        const tipBefore = await node.getBlockCount();
        const depth     = tipBefore - completingBlock + 1;
        expect(depth, 'orphan depth (blocks to invalidate) - past ORPHAN_DEPTH_LIMIT the ' +
            'utxo-tracker halts fail-closed and the venue needs an operator resync').to.be.at.most(ORPHAN_DEPTH_LIMIT);

        const snapshot = await snapshotWindow(node, completingBlock, tipBefore);
        const window   = snapshot.blocks[0];
        expect(window.txs.some(t => t.txid === c0Tx) && window.txs.some(t => t.txid === c1Tx),
            'both carriers of the completing block snapshotted for replay').to.equal(true);

        const orphanHash = await node.getBlockHash(completingBlock);
        await node.invalidateBlock(orphanHash);
        const need = tipBefore - (completingBlock - 1) + 2;
        for (let i = 0; i < need; i++) await node.generateBlock(payout, []);
        expect(await node.getBlockCount(), 'competing chain overtakes the original tip').to.be.greaterThan(tipBefore);
        expect(await node.getBlockHash(completingBlock), 'the chain actually reorged').to.not.equal(orphanHash);

        const rolledBack = await waitFor(async () => {
            const contracts = await contractRows(srcId, plan.codeHash);
            const chunks    = await chunkRows(srcId, plan.codeHash);
            const state     = await idxCount('SELECT COUNT(*) n FROM contract_state WHERE contract_index = ?', [C]);
            const done = contracts.length === 1 && chunks.length === 1 && state === 0 && (await executionRow(C)) === null;
            return done ? { contracts, chunks } : null;
        }, 'rollback to remove the contract, its execution row and its state', 180000);

        expect(rolledBack.contracts[0].action_index, 'the assembler\'s pending row survives the orphan').to.equal(A);
        expect(rolledBack.contracts[0].status, 'and keeps its pending status').to.equal(PENDING_STATUS);
        expect(rolledBack.chunks[0].chunk_index, 'the carrier below the fork survives').to.equal(2);
        expect(await permissionCount(C), 'the contract\'s permissions row is gone').to.equal(0);
        if (permsBefore === 0)
            console.log('    [deferred] AT5 the deployed contract declared no manifest; the permissions assertion is vacuous');
        expect(await executionRow(A), 'the assembler\'s own execution row survives').to.not.equal(null);

        // Replay the SAME transactions in a DIFFERENT order: chunk 0 first, so the
        // group is now completed by chunk 1 and the contract must rebuild at ITS
        // index. Funding transactions (a two-phase piece's phase 1) keep their
        // relative order ahead of the reveals; only the two actions swap.
        const byTxid    = new Map(window.txs.map(t => [t.txid, t]));
        const actionSet = new Set([c0Tx, c1Tx]);
        const reordered = window.txs.filter(t => !actionSet.has(t.txid))
            .concat([byTxid.get(c0Tx), byTxid.get(c1Tx)]);
        await replayWindowInOrder(node, {
            payout,
            blocks:     [{ height: window.height, txs: reordered }],
            txs:        snapshot.txs,
            depthLimit: ORPHAN_DEPTH_LIMIT,
            attempts:   4,
            log,
        });

        const newC = await waitFor(async () => actionIndexOfTx(c1Tx), 'chunk 1 to re-index on the new branch');
        const newContracts = await waitFor(async () => {
            const rows = await contractRows(srcId, plan.codeHash);
            return rows.length === 2 ? rows : null;
        }, 'the contract to re-deploy on the replayed branch', 240000);

        const rebuilt = newContracts.find(r => r.action_index === newC);
        expect(rebuilt, 'the contract rebuilt at the NEW last piece (chunk 1)').to.not.equal(undefined);
        expect(rebuilt.status, 'and is valid').to.equal('valid');
        expect(rebuilt.code_hash, 'the same source rebuilt: same code_hash').to.equal(plan.codeHash);
        const newExec = await executionRow(newC);
        expect(newExec.contract_index, 'the contract is the new completing action').to.equal(newC);
        expect(newExec.assembler_action_index, 'the SAME surviving assembler was consumed').to.equal(A);
        expect(await readState(sdk, newC, 'run'), 'the reassembled source is this run\'s').to.equal(run);
        expect(await readState(sdk, newC, 'count'), 'the constructor replayed deterministically').to.equal(String(START));

        console.log('    [deferred] AT5 orphaned C=' + C + '; reordered replay re-deployed at ' + newC +
                    ' under the same assembler ' + A);

        // The window is back on chain and the mempool holds nothing of this drill's,
        // so the inter-test quiesce hook has nothing left to shuffle.
        await resumeMining();
    });
});
