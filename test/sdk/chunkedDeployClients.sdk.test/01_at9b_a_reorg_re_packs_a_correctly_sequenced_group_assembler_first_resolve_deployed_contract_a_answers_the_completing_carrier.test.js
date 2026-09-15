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
const cryptoHelper = require('../../cryptoHelper');
const { makeSdk, fundedGasAddress, mine, submitOpts, uniqueTick } = require('../sdkHelper');
const { snapshotWindow, replayWindowInOrder, unconfirmedAncestors, placeBlockInOrder } = require('../helpers/rawHexBlocks');
const { chunkHelper } = require('xchain-sdk');
const {
    PENDING_STATUS,
    GAS_LIMIT,
    START,
    PAD_2CHUNK,
    ORPHAN_DEPTH_LIMIT,
    sourceFor,
    haveConnectors,
    waitFor,
    seedPrices,
    addressId,
    actionIndexOfTx,
    contractRows,
    chunkRows,
    executionRow,
    readState,
    actionDetail,
    hasField,
    expectResolution,
} = require('./support/client_drill');

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

async function placeSequencedGroup(sdk, node, payout, dep, plan, srcId, inputs, log) {
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
    return { c0Tx, c1Tx, asmTx, sequencedBlock, preA };
}

async function orphanSequencedGroup(node, payout, txs, srcId, plan, log) {
    // Phase 2: occurrence 2. Orphan that block and lay the SAME transactions
    // down again with the assembler FIRST, which is what an ancestor-feerate
    // repack of a resurrected mempool did on this venue for real. Reorg and
    // replay live in ONE `it`: a test boundary here hands the resurrected window
    // to initialCheck's quiesce hook, which would mine it in mempool order.
    const tipBefore = await node.getBlockCount();
    const depth = tipBefore - txs.sequencedBlock + 1;
    expect(depth, 'orphan depth (blocks to invalidate) - past ORPHAN_DEPTH_LIMIT the ' +
        'utxo-tracker halts fail-closed and the venue needs an operator resync').to.be.at.most(ORPHAN_DEPTH_LIMIT);

    const snapshot = await snapshotWindow(node, txs.sequencedBlock, tipBefore);
    const window = snapshot.blocks[0];
    expect(window.txs.some(t => t.txid === txs.asmTx) && window.txs.some(t => t.txid === txs.c0Tx) &&
           window.txs.some(t => t.txid === txs.c1Tx),
        'all three pieces snapshotted from the sequenced block for replay').to.equal(true);

    const orphanHash = await node.getBlockHash(txs.sequencedBlock);
    await node.invalidateBlock(orphanHash);
    const need = tipBefore - (txs.sequencedBlock - 1) + 2;
    for (let i = 0; i < need; i++) await node.generateBlock(payout, []);
    expect(await node.getBlockCount(), 'competing chain overtakes the original tip').to.be.greaterThan(tipBefore);
    expect(await node.getBlockHash(txs.sequencedBlock), 'the chain actually reorged').to.not.equal(orphanHash);

    await waitFor(async () => {
        const contracts = await contractRows(srcId, plan.codeHash);
        const chunks = await chunkRows(srcId, plan.codeHash);
        return (contracts.length === 0 && chunks.length === 0) ? true : null;
    }, 'the sequenced deploy to roll back with its block', 180000);
    log('orphaned: contract, execution row and carriers all gone');
    return { snapshot, window };
}

async function replayAssemblerFirst(node, payout, txs, orphaned, log) {
    // The re-pack. Funding transactions (a two-phase piece's phase 1) keep their
    // relative order at the head of the block - a block must list a parent before
    // its child - and only the three ACTION transactions move, assembler first.
    // The pieces were asserted independent above, so this order is block-legal.
    const byTxid = new Map(orphaned.window.txs.map(t => [t.txid, t]));
    const actionSet = new Set([txs.asmTx, txs.c1Tx, txs.c0Tx]);
    const reordered = orphaned.window.txs.filter(t => !actionSet.has(t.txid))
        .concat([byTxid.get(txs.asmTx), byTxid.get(txs.c1Tx), byTxid.get(txs.c0Tx)]);
    await replayWindowInOrder(node, {
        payout,
        blocks:     [{ height: orphaned.window.height, txs: reordered }],
        txs:        orphaned.snapshot.txs,
        depthLimit: ORPHAN_DEPTH_LIMIT,
        attempts:   4,
        log,
    });

    // A reorg renumbers the group: the assembler that was LAST is now FIRST, so
    // both indexes are re-read from the transactions rather than carried over.
    const A  = await waitFor(async () => actionIndexOfTx(txs.asmTx), 'the assembler to re-index on the new branch');
    const C  = await waitFor(async () => actionIndexOfTx(txs.c0Tx), 'the chunk-0 carrier to re-index');
    const c1 = await actionIndexOfTx(txs.c1Tx);
    expect(A, 'the re-pack really put the assembler FIRST').to.be.lessThan(c1);
    expect(c1, 'and the chunk-0 carrier LAST, so it is the piece that completes the group').to.be.lessThan(C);
    return { A, C };
}

async function assertRepackedContract(sdk, srcId, plan, indexes, run, preA, log) {
    const { A, C } = indexes;
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
    log('sequenced at A=' + preA + '; re-packed assembler-first -> A=' + A +
        ' pending, contract at C=' + C + '; the SDK resolved ' + resolved);
}

describe('[sdk] chunked DEPLOY clients (the SDK resolves the contract through the explorer)', function () {
    this.timeout(0);

    let sdk, payout, miningPaused = false;

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
    });

    // AT9b holds auto-mining; never leave it held.
    after(async function () { await resumeMining(); });

    it('AT9b a reorg re-packs a correctly sequenced group assembler-first: resolveDeployedContract(A) answers the completing carrier', async function () {
        const node = global.nodeConnector;
        const run  = uniqueTick('C9B');
        const plan = chunkHelper.planDeploy(sourceFor(run, PAD_2CHUNK), { gasLimit: GAS_LIMIT, constructorParams: [String(START)] });
        expect(plan.totalChunks, 'AT9b plans to 2 chunks').to.equal(2);
        const log = (m) => console.log('    [clients] AT9b ' + m);

        await pauseMining();
        await seedPrices();
        const dep = await fundIndependentInputs(sdk, 3, () => resumeMiningForFunding(), () => pauseMining());
        const srcId = await addressId(dep.address);
        const inputs = await pickInputs(sdk, dep.address, 3);
        const txs = await placeSequencedGroup(sdk, node, payout, dep, plan, srcId, inputs, log);
        const orphaned = await orphanSequencedGroup(node, payout, txs, srcId, plan, log);
        const indexes = await replayAssemblerFirst(node, payout, txs, orphaned, log);
        await assertRepackedContract(sdk, srcId, plan, indexes, run, txs.preA, log);

        // The window is back on chain and the mempool holds nothing of this drill's,
        // so the inter-test quiesce hook has nothing left to shuffle.
        await resumeMining();
    });
});
