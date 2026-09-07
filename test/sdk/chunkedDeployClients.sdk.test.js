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
 * XChain Platform E2E - chunked DEPLOY, the CLIENT side (AT9a / AT9b)
 *
 * Consensus deploys a chunk group at whichever piece completes it
 * (chunkedDeployDeferred.sdk.test.js pins that rule). This drill pins the half
 * a client owns: after DEPLOY_DEFERRED_ASSEMBLY the contract's action_index is
 * NOT knowable from the assembling DEPLOY's own indexed row any more, so a
 * client that reads it there deposits into the wrong index, or into none. The
 * SDK therefore asks the EXPLORER: `deployed_contract_index` on /api/action/A,
 * polled by `workflows.resolveDeployedContract(A)` until it is non-null, or
 * until `assembly_status` stops matching /^pending/ (a terminal failure).
 *
 *   AT9a  workflows.deployContract deploys a chunked contract sequentially, so
 *         the group is complete from lower carriers and deploys at the
 *         assembler's own index (R2.1). The returned `contractActionIndex`
 *         must be THAT index, read through the explorer field rather than off
 *         the indexed row, and the deposit passed in the same call must land
 *         on that contract.
 *   AT9b  occurrence 2, the case no client-side discipline closes: a correctly
 *         SEQUENCED group is orphaned and re-packed assembler-first by a
 *         reorg. The contract now rebuilds at the completing carrier C, and
 *         `resolveDeployedContract(A)` must answer C (not A, not the pending
 *         status), with the contract's state readable at the index it answered.
 *
 * WHY AT9b DOES NOT SUBMIT THROUGH workflows.deployContract (D55, and measured
 * against the reorg drill's contract (b)). The re-pack is only drivable when
 * the pieces are independent transactions: a block must list a parent before
 * its child, so pieces chained through change have exactly ONE legal order and
 * "re-packed assembler-first" is not a block a node would accept. Consecutive
 * submits from one walletSession spend speculative change, so the workflow's
 * own legs may chain. AT9b therefore funds one confirmed input per piece and
 * broadcasts them by hand (the deferred drill's plumbing, and independence is
 * ASSERTED off the mempool, not assumed), places them in the correct sequential
 * order so the first deploy is exactly what a correct client produces, and only
 * then reorgs. Everything the acceptance test is about - resolveDeployedContract
 * answering C - is driven through the SDK.
 *
 * ORDER OWNERSHIP, inherited from the deferred drill: for AT9b auto-mining is
 * HELD and every block is placed by raw hex (helpers/rawHexBlocks.js), the
 * whole acceptance test lives in ONE `it` (initialCheck's root afterEach
 * quiesce mines the mempool between tests, which would hand the ordering to the
 * packer), and indexer waits poll without nudging a block. AT9a owns no
 * ordering at all, so it runs with the auto-miner live.
 *
 * VENUE: BTC regtest (raw-hex placement plus an empty competing chain is the
 * BTC/LTC mechanism, and BTC is gas mode, so no native fee output is needed on
 * the workflow legs, which do not thread one). Needs the indexer's
 * DEPLOY_DEFERRED_ASSEMBLY gate (active from height 0 on regtest) AND the
 * explorer's `deployed_contract_index` field: without the field the SDK helper
 * cannot answer at all, so these two tests fail rather than self-skip, which is
 * the point of the rung. Node 22.
 *
 * Run (host with regtest stack + Node 22). It rides `npm run test:sdk`; on its own:
 *     COIN=bitcoin NETWORK=regtest npm run test:sdk:chunked-clients
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const cryptoHelper = require('../cryptoHelper');
const { makeSdk, submit, fundedGasAddress, mine, submitOpts, uniqueTick, waitForBalance } = require('./sdkHelper');
const { snapshotWindow, replayWindowInOrder, unconfirmedAncestors, placeBlockInOrder } = require('./helpers/rawHexBlocks');
const { chunkHelper } = require('xchain-sdk');

// Spelled out rather than imported: a test that reads the string from the code
// that writes it proves nothing.
const PENDING_STATUS = 'pending: CODE_HASH (awaiting chunks)';

const GAS_LIMIT = 400000;
const START     = 5;

// Measured against chunkHelper.planDeploy (2026-09-07, gasLimit 400000, one
// constructor param): 7000 source bytes plan to 2 chunks. Each test asserts the
// count it got, so an SDK change to the per-carrier budget fails here instead of
// quietly reducing the drill to a single-action deploy that tests nothing.
const PAD_2CHUNK = 7000;

// Deposited by AT9a in the same deployContract call that deploys the contract.
const DEPOSIT_AMOUNT = 1000;

// Orphan-depth ceiling, same reasoning as the reorg and deferred drills: past
// the utxo-tracker's UNDO_BLOCKS=12 spent-output recovery window a rollback
// halts the tracker fail-closed and wedges the venue for every other suite, so
// the guard fires before any invalidateblock. AT9b orphans exactly one block.
const ORPHAN_DEPTH_LIMIT = 12;

// A contract too large for a single DEPLOY: the string literal survives (it is
// code, not a comment), `padlen` proves byte-exact reassembly and `run` proves
// the rebuilt contract is THIS run's source. The per-run marker makes the
// code_hash - and so the group every query below resolves - unique to one test.
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
    return global.nodeConnector && global.regtestMinerConnector &&
           global.utxoTrackerConnector && global.indexerDatabase;
}

async function idxQuery(sql, params) {
    const conn = await global.indexerDatabase.getConnection();
    try { return await conn.query(sql, params); } finally { await conn.release(); }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Poll until `fn()` is truthy. Deliberately mines NOTHING: in AT9b pieces of the
// group under test may be sitting unconfirmed while this waits, and a nudge block
// would let the miner pack them in ITS order rather than the one under test.
// Throws so a stall names the step it was waiting on rather than surfacing as a
// later assertion on an empty row set.
async function waitFor(fn, what, timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const got = await fn();
        if (got) return got;
        if (Date.now() >= deadline) throw new Error('timed out after ' + (timeoutMs / 1000) + 's waiting for ' + what);
        await sleep(1000);
    }
}

// The e2e fee helper seeds the oracle prices the indexer's fee block reads, and
// sdkHelper.submit() refreshes them on every call. The workflow legs and the
// hand-broadcast pieces below bypass submit(), so the seed is refreshed here
// instead (throttled inside the helper; a no-op while the last one is fresh).
async function seedPrices() {
    try { await require('../helpers/nativeFeeHelper').seedGlobalPrices(false); } catch (e) { /* best effort */ }
}

/* ---------------------------------------------------------------- indexer reads */

// The indexer's dense address id; every group query is scoped by it because
// assembly is source-bound and two addresses may hold the same code_hash.
async function addressId(address) {
    const rows = await idxQuery('SELECT id FROM index_addresses WHERE address = ?', [address]);
    return rows.length ? Number(rows[0].id) : null;
}

// action_index of the action carried by a broadcast transaction. Binds every
// assertion below to a transaction this drill signed rather than to whichever
// row happened to match a status - and after a reorg the group's indexes are
// renumbered, so this is the only honest way to name A and C twice.
async function actionIndexOfTx(txid) {
    const rows = await idxQuery(
        'SELECT a.action_index FROM actions a ' +
        'INNER JOIN transactions t ON t.tx_index = a.tx_index ' +
        'INNER JOIN index_transactions it ON it.id = t.tx_hash_id ' +
        'WHERE it.hash = ?', [txid]);
    return rows.length ? Number(rows[0].action_index) : null;
}

async function contractRows(srcId, codeHash) {
    const rows = await idxQuery(
        'SELECT c.action_index, c.code_hash, s.status FROM contracts c ' +
        'LEFT JOIN index_statuses s ON s.id = c.status_id ' +
        'WHERE c.source_id = ? AND c.code_hash = ? ORDER BY c.action_index ASC', [srcId, codeHash]);
    return rows.map(r => ({ action_index: Number(r.action_index), code_hash: r.code_hash, status: r.status }));
}

async function chunkRows(srcId, codeHash) {
    const rows = await idxQuery(
        'SELECT dc.action_index, dc.chunk_index, s.status FROM deploy_chunks dc ' +
        'LEFT JOIN index_statuses s ON s.id = dc.status_id ' +
        'WHERE dc.source_id = ? AND dc.code_hash = ? ORDER BY dc.action_index ASC', [srcId, codeHash]);
    return rows.map(r => ({ action_index: Number(r.action_index), chunk_index: Number(r.chunk_index), status: r.status }));
}

async function executionRow(actionIndex) {
    const rows = await idxQuery(
        'SELECT e.action_index, e.contract_index, e.gas_used, e.assembler_action_index, s.status ' +
        'FROM contract_executions e LEFT JOIN index_statuses s ON s.id = e.status_id ' +
        'WHERE e.action_index = ?', [actionIndex]);
    if (!rows.length) return null;
    const r = rows[0];
    return {
        action_index:           Number(r.action_index),
        contract_index:         r.contract_index === null ? null : Number(r.contract_index),
        gas_used:               Number(r.gas_used),
        assembler_action_index: r.assembler_action_index === null ? null : Number(r.assembler_action_index),
        status:                 r.status,
    };
}

/* ------------------------------------------------------------- explorer reads */

async function readState(sdk, contractIndex, key) {
    const state = await sdk.getContractState(contractIndex, key);
    const rows = (state && state.data) || [];
    const row = rows.find(r => r.state_key === key);
    return row ? JSON.parse(row.state_value) : undefined;
}

// Whatever shape getContractBalance answers in, as a number (same normalisation
// escrowTemplate uses).
async function contractBalance(sdk, contractIndex, tick) {
    const res = await sdk.getContractBalance(contractIndex, tick);
    if (res == null) return 0;
    if (typeof res === 'number' || typeof res === 'string') return Number(res);
    const list = Array.isArray(res) ? res : (Array.isArray(res.data) ? res.data : null);
    if (list) {
        const row = list.find(b => (b.tick || b.TICK) === tick);
        return row ? Number(row.amount ?? row.quantity ?? row.balance) : 0;
    }
    return Number(res.amount ?? res.quantity ?? res.balance ?? 0);
}

// The explorer's action detail, unwrapped from whichever envelope it arrives in
// (D52: the route wraps db.getAction's single-element array).
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

function hasField(detail, name) {
    return !!detail && Object.prototype.hasOwnProperty.call(detail, name);
}

// The D48 field contract, asserted rather than probed: this rung exists to make
// the field answer, so a missing field is a failure here (unlike the deferred
// drill, whose subject is consensus and which self-skips for an older explorer).
function expectResolution(detail, expectedIndex, expectedStatus, label) {
    expect(detail, label + ': explorer action detail').to.not.equal(null);
    expect(hasField(detail, 'deployed_contract_index'),
        label + ': /api/action carries deployed_contract_index (D48)').to.equal(true);
    expect(Number(detail.deployed_contract_index), label + ': deployed_contract_index').to.equal(expectedIndex);
    expect(hasField(detail, 'assembly_status'),
        label + ': /api/action carries assembly_status (D48)').to.equal(true);
    expect(String(detail.assembly_status), label + ': assembly_status').to.equal(expectedStatus);
}

/* ------------------------------------------------------------- piece plumbing */

// One confirmed input per piece. The re-pack under test only exists between
// transactions consensus leaves unordered: pieces chained parent-to-child could
// not be placed assembler-first at all (a block must list a parent first), so a
// chained funding set would turn AT9b's ordering into a tautology or an
// unplaceable block.
async function fundIndependentInputs(sdk, pieces, resumeFn, pauseFn) {
    // The gas leg (fundedGasAddress -> mintGas) goes through sdkHelper's submit(),
    // which broadcasts and then waits on the indexer; under a mining hold nothing
    // confirms that MINT and the caller dies at the timeout. Funding runs before
    // the first piece is broadcast, so an auto-mined block here cannot disturb the
    // deterministic placement that follows.
    await resumeFn();
    let addr;
    try {
        addr = await fundedGasAddress(sdk, 1);
        for (let i = 0; i < pieces; i++) await global.regtestMinerConnector.sendFunds(addr.address, 1);
    } finally {
        await pauseFn();
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

// Build, sign and broadcast one piece from ONE named input, without waiting on
// the indexer. sdk.submitAction is called directly rather than through
// sdkHelper's submit(): that wrapper quiesces first, and quiesce mines the
// mempool whenever it is non-empty, which would confirm the sibling pieces
// already broadcast before this drill has chosen their block.
async function broadcastPiece(sdk, deployer, actionData, utxo) {
    const res = await sdk.submitAction(actionData,
        { pubkey: deployer.address, change: deployer.address, utxos: [utxo] },
        submitOpts({ wif: deployer.wif, waitForIndexer: false, requireValid: false }));
    return res.txid;
}

// No piece may spend any other piece's output, directly or through its own
// funding transaction. Measured off the mempool rather than off the intent,
// because the whole legality of AT9b's re-pack rests on it.
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

// workflows.deployContract waits on the indexer for every leg, and only a BLOCK
// settles a leg. The venue's auto-miner does produce them, but its interval is
// venue configuration while the waiter's budget is not, so a nudge keeps AT9a's
// four sequential legs inside it. Safe here and only here: AT9a owns no
// transaction order, while AT9b (which does) holds the miner and places every
// block by hand.
async function withMiningNudge(fn) {
    const timer = setInterval(() => { mine(1); }, 5000);
    try { return await fn(); } finally { clearInterval(timer); }
}

describe('[sdk] chunked DEPLOY clients (the SDK resolves the contract through the explorer)', function () {
    this.timeout(0);

    let sdk, payout, deployer, miningPaused = false;

    async function pauseMining() {
        await global.regtestMinerConnector.pauseMining();
        miningPaused = true;
    }
    async function resumeMining() {
        if (!miningPaused) return;
        miningPaused = false;
        try { await global.regtestMinerConnector.resumeMining(); } catch (e) { /* best effort */ }
    }
    // fundIndependentInputs needs the miner running for its funding legs and the
    // hold restored afterwards, WITHOUT clearing the suite's own paused flag: the
    // hold is conceptually still on for the whole of AT9b.
    async function resumeMiningForFunding() {
        try { await global.regtestMinerConnector.resumeMining(); } catch (e) { /* best effort */ }
    }

    before(async function () {
        if (!haveConnectors()) this.skip();
        // Raw-hex placement plus an empty competing chain is the BTC/LTC mechanism;
        // DOGE regtest mines on a different model. LTC would additionally need a
        // native fee output on every leg, which the SDK workflow does not thread.
        if (global.COIN_CODE !== 'BTC') this.skip();

        sdk = makeSdk();
        payout = (await cryptoHelper.getNewAddress('chunk-clients-miner', COIN, NETWORK, null, 'legacy', 0)).address;
        deployer = await fundedGasAddress(sdk, 1);
        console.log('    [clients] deployer=' + deployer.address);
    });

    // AT9b holds auto-mining; never leave it held.
    after(async function () { await resumeMining(); });

    it('AT9a workflows.deployContract returns the contract index the explorer resolved, and its deposit lands on that contract', async function () {
        const run  = uniqueTick('C9A');
        const src  = sourceFor(run, PAD_2CHUNK);
        const plan = chunkHelper.planDeploy(src, { gasLimit: GAS_LIMIT, constructorParams: [String(START)] });
        expect(plan.single, 'AT9a source must NOT fit a single DEPLOY (else the group is not chunked)').to.equal(false);
        expect(plan.totalChunks, 'AT9a plans to 2 chunks').to.equal(2);

        // A token for the deposit leg: the deployer issues it to itself, so the
        // DEPOSIT moves a balance it holds and the contract's custody is checkable.
        const tick = uniqueTick('C9D');
        const issue = await submit(sdk,
            { action: 'ISSUE', params: { tick, maxSupply: 1000000, maxMint: 100000, decimals: 0, description: 'deploy deposit', mintSupply: DEPOSIT_AMOUNT } },
            { pubkey: deployer.address, change: deployer.address },
            submitOpts({ wif: deployer.wif }));
        expect(issue.indexed.status, 'ISSUE of the deposit tick').to.equal('valid');
        await mine(1);
        expect(await waitForBalance(sdk, deployer.address, tick, DEPOSIT_AMOUNT),
            'the deployer holds the tick it is about to deposit').to.equal(DEPOSIT_AMOUNT);

        await seedPrices();
        const res = await withMiningNudge(() => sdk.workflows.deployContract(
            deployer.wif,
            { code: src, gasLimit: GAS_LIMIT, constructorParams: [String(START)] },
            [{ tick, quantity: DEPOSIT_AMOUNT }],
            submitOpts()));

        expect(res.chunks.length, 'one DEPLOY v4 carrier per base64 slice').to.equal(plan.totalChunks);
        for (let i = 0; i < res.chunks.length; i++)
            expect(res.chunks[i].indexed.status, 'carrier ' + i + ' indexed').to.equal('valid');
        expect(res.deploy.indexed.status, 'the assembling DEPLOY indexed').to.equal('valid');

        // The assembling leg's own action_index, read from the transaction this
        // drill broadcast rather than from the value under test.
        const A = await waitFor(async () => actionIndexOfTx(res.deploy.txid), 'the assembling DEPLOY to index');

        expect(res.contractActionIndex,
            'workflows.deployContract answers a contractActionIndex').to.not.equal(undefined);
        expect(res.contractActionIndex,
            'workflows.deployContract answers a contractActionIndex').to.not.equal(null);
        expect(Number(res.contractActionIndex),
            'R2.1: a sequential group is complete from lower carriers, so the contract is the assembling leg')
            .to.equal(A);

        // ... and the indexer agrees it is an R2.1 deploy, not a deferred one.
        const srcId = await addressId(deployer.address);
        const contracts = await waitFor(async () => {
            const rows = await contractRows(srcId, plan.codeHash);
            return rows.length ? rows : null;
        }, 'the deployed contract row');
        expect(contracts.length, 'a sequential deploy writes exactly one contracts row for the group').to.equal(1);
        expect(contracts[0].action_index, 'the contract sits at the assembling leg').to.equal(A);
        expect(contracts[0].status, 'the contract deployed valid').to.equal('valid');

        const exec = await executionRow(A);
        expect(exec, 'constructor execution row at A').to.not.equal(null);
        expect(exec.contract_index, 'the contract IS the assembling action').to.equal(A);
        expect(exec.assembler_action_index,
            'a self-completed deploy consumed no separate assembler (R2.1)').to.equal(null);

        // The reassembled source really is this run's, at the index the SDK answered.
        expect(await readState(sdk, Number(res.contractActionIndex), 'padlen'),
            'padlen matches the reassembled source, read at the answered index').to.equal(String(PAD_2CHUNK));
        expect(await readState(sdk, Number(res.contractActionIndex), 'run'),
            'the constructor ran on THIS run\'s source').to.equal(run);
        expect(await readState(sdk, Number(res.contractActionIndex), 'count'),
            'count seeded to START').to.equal(String(START));

        // The deposit rode the same call and landed on the contract, which is the
        // whole reason deployContract has to resolve the index at all.
        expect(res.deposits.length, 'one DEPOSIT per requested deposit').to.equal(1);
        expect(res.deposits[0].indexed.status, 'the DEPOSIT indexed').to.equal('valid');
        await mine(1);
        const held = await waitFor(async () => {
            const bal = await contractBalance(sdk, A, tick);
            return bal === DEPOSIT_AMOUNT ? bal : null;
        }, 'the contract to hold the deposit');
        expect(held, 'the deposit landed on the deployed contract').to.equal(DEPOSIT_AMOUNT);

        // The explorer field the client polled, asserted directly (D48).
        expectResolution(await actionDetail(sdk, A), A, 'valid', 'AT9a assembler page');

        // And the public helper answers the same index on its own.
        const resolved = await sdk.workflows.resolveDeployedContract(A, submitOpts());
        expect(Number(resolved), 'resolveDeployedContract(A) answers A in the R2.1 case').to.equal(A);

        console.log('    [clients] AT9a A=' + A + ' contractActionIndex=' + res.contractActionIndex +
                    ' deposit=' + DEPOSIT_AMOUNT + ' ' + tick + ' gas_used=' + exec.gas_used);
    });

    it('AT9b a reorg re-packs a correctly sequenced group assembler-first: resolveDeployedContract(A) answers the completing carrier', async function () {
        const node = global.nodeConnector;
        const run  = uniqueTick('C9B');
        const plan = chunkHelper.planDeploy(sourceFor(run, PAD_2CHUNK), { gasLimit: GAS_LIMIT, constructorParams: [String(START)] });
        expect(plan.totalChunks, 'AT9b plans to 2 chunks').to.equal(2);
        const log = (m) => console.log('    [clients] AT9b ' + m);

        await pauseMining();
        await seedPrices();
        const dep    = await fundIndependentInputs(sdk, 3, () => resumeMiningForFunding(), () => pauseMining());
        const srcId  = await addressId(dep.address);
        const inputs = await pickInputs(sdk, dep.address, 3);

        // Phase 1: exactly what a correct client produces. Carriers first, the
        // assembler last, so the group is complete from lower carriers and the
        // contract deploys at the assembler (R2.1).
        const c0Tx  = await broadcastPiece(sdk, dep, carrierAction(plan, 0), inputs[0]);
        const c1Tx  = await broadcastPiece(sdk, dep, carrierAction(plan, 1), inputs[1]);
        const asmTx = await broadcastPiece(sdk, dep, assemblerAction(plan), inputs[2]);
        await assertIndependentPieces(node, [c0Tx, c1Tx, asmTx]);

        const sequencedBlock = (await node.getBlockCount()) + 1;
        await placeBlockInOrder(node, payout, [c0Tx, c1Tx, asmTx], { log });

        const preA = await waitFor(async () => actionIndexOfTx(asmTx), 'the assembler to index');
        const sequenced = await waitFor(async () => {
            const rows = await contractRows(srcId, plan.codeHash);
            return rows.length === 1 ? rows : null;
        }, 'the correctly sequenced deploy to index');
        expect(sequenced[0].action_index, 'the sequenced group deployed at the assembler (R2.1)').to.equal(preA);
        expect(sequenced[0].status, 'and is valid').to.equal('valid');
        expect((await executionRow(preA)).assembler_action_index,
            'nothing was consumed: the sequenced deploy completed from its own lower carriers').to.equal(null);
        log('sequenced deploy at A=' + preA + ' in block ' + sequencedBlock);

        // --- Phase 2: occurrence 2. Orphan that block and lay the SAME transactions
        // down again with the assembler FIRST, which is what an ancestor-feerate
        // repack of a resurrected mempool did on this venue for real. Reorg and
        // replay live in ONE `it`: a test boundary here hands the resurrected window
        // to initialCheck's quiesce hook, which would mine it in mempool order.
        const tipBefore = await node.getBlockCount();
        const depth     = tipBefore - sequencedBlock + 1;
        expect(depth, 'orphan depth (blocks to invalidate) - past ORPHAN_DEPTH_LIMIT the ' +
            'utxo-tracker halts fail-closed and the venue needs an operator resync').to.be.at.most(ORPHAN_DEPTH_LIMIT);

        const snapshot = await snapshotWindow(node, sequencedBlock, tipBefore);
        const window   = snapshot.blocks[0];
        expect(window.txs.some(t => t.txid === asmTx) && window.txs.some(t => t.txid === c0Tx) &&
               window.txs.some(t => t.txid === c1Tx),
            'all three pieces snapshotted from the sequenced block for replay').to.equal(true);

        const orphanHash = await node.getBlockHash(sequencedBlock);
        await node.invalidateBlock(orphanHash);
        const need = tipBefore - (sequencedBlock - 1) + 2;
        for (let i = 0; i < need; i++) await node.generateBlock(payout, []);
        expect(await node.getBlockCount(), 'competing chain overtakes the original tip').to.be.greaterThan(tipBefore);
        expect(await node.getBlockHash(sequencedBlock), 'the chain actually reorged').to.not.equal(orphanHash);

        await waitFor(async () => {
            const contracts = await contractRows(srcId, plan.codeHash);
            const chunks    = await chunkRows(srcId, plan.codeHash);
            return (contracts.length === 0 && chunks.length === 0) ? true : null;
        }, 'the sequenced deploy to roll back with its block', 180000);
        log('orphaned: contract, execution row and carriers all gone');

        // The re-pack. Funding transactions (a two-phase piece's phase 1) keep their
        // relative order at the head of the block - a block must list a parent before
        // its child - and only the three ACTION transactions move, assembler first.
        // The pieces were asserted independent above, so this order is block-legal.
        const byTxid    = new Map(window.txs.map(t => [t.txid, t]));
        const actionSet = new Set([asmTx, c1Tx, c0Tx]);
        const reordered = window.txs.filter(t => !actionSet.has(t.txid))
            .concat([byTxid.get(asmTx), byTxid.get(c1Tx), byTxid.get(c0Tx)]);
        await replayWindowInOrder(node, {
            payout,
            blocks:     [{ height: window.height, txs: reordered }],
            txs:        snapshot.txs,
            depthLimit: ORPHAN_DEPTH_LIMIT,
            attempts:   4,
            log,
        });

        // A reorg renumbers the group: the assembler that was LAST is now FIRST, so
        // both indexes are re-read from the transactions rather than carried over.
        const A  = await waitFor(async () => actionIndexOfTx(asmTx), 'the assembler to re-index on the new branch');
        const C  = await waitFor(async () => actionIndexOfTx(c0Tx), 'the chunk-0 carrier to re-index');
        const c1 = await actionIndexOfTx(c1Tx);
        expect(A, 'the re-pack really put the assembler FIRST').to.be.lessThan(c1);
        expect(c1, 'and the chunk-0 carrier LAST, so it is the piece that completes the group').to.be.lessThan(C);

        const rows = await waitFor(async () => {
            const found = await contractRows(srcId, plan.codeHash);
            return found.length === 2 ? found : null;
        }, 'the pending assembler row and the re-deployed contract', 240000);
        expect(rows.find(r => r.action_index === A).status,
            'the re-packed assembler landed pending, not invalid').to.equal(PENDING_STATUS);
        expect(rows.find(r => r.action_index === C).status,
            'the contract came back at the completing carrier').to.equal('valid');
        expect((await executionRow(C)).assembler_action_index,
            'the constructor row at C names the assembler it consumed').to.equal(A);

        // THE acceptance clause: a client holding only the assembler's index gets
        // the contract's real index back, which pre-activation did not exist at all.
        const resolved = Number(await sdk.workflows.resolveDeployedContract(A, submitOpts()));
        expect(resolved, 'resolveDeployedContract(A) answers C, the completing carrier').to.equal(C);

        // ... and the index it answered is the one the contract's state reads at.
        expect(await readState(sdk, resolved, 'padlen'),
            'padlen matches the reassembled source at the answered index').to.equal(String(PAD_2CHUNK));
        expect(await readState(sdk, resolved, 'run'), 'the rebuilt contract is THIS run\'s source').to.equal(run);
        expect(await readState(sdk, resolved, 'count'), 'the constructor replayed deterministically').to.equal(String(START));

        // Both explorer surfaces the clients read (D48).
        expectResolution(await actionDetail(sdk, A), C, 'valid', 'AT9b assembler page');
        const carrierDetail = await actionDetail(sdk, C);
        expect(hasField(carrierDetail, 'deployed_contract_index'),
            'AT9b carrier page carries deployed_contract_index (D48)').to.equal(true);
        expect(Number(carrierDetail.deployed_contract_index),
            'the completing carrier page names its own contract').to.equal(C);
        expect(Number(carrierDetail.assembler_action_index),
            'the carrier deploy card names the assembler it completed').to.equal(A);

        console.log('    [clients] AT9b sequenced at A=' + preA + '; re-packed assembler-first -> A=' + A +
                    ' pending, contract at C=' + C + '; the SDK resolved ' + resolved);

        // The window is back on chain and the mempool holds nothing of this drill's,
        // so the inter-test quiesce hook has nothing left to shuffle.
        await resumeMining();
    });
});
