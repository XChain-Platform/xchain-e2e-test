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
const { makeSdk, submit, fundedGasAddress, mine, submitOpts, uniqueTick, waitForBalance } = require('./sdkHelper');
const { chunkHelper } = require('xchain-sdk');
const {
    GAS_LIMIT,
    START,
    PAD_2CHUNK,
    sourceFor,
    haveConnectors,
    waitFor,
    seedPrices,
    addressId,
    actionIndexOfTx,
    contractRows,
    executionRow,
    readState,
    contractBalance,
    actionDetail,
    expectResolution,
} = require('./chunkedDeployClients.sdk.test/support/client_drill');

// Deposited by AT9a in the same deployContract call that deploys the contract.
const DEPOSIT_AMOUNT = 1000;

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

async function deployContractWithDeposit(sdk, deployer, run) {
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
    return { plan, res, tick };
}

async function assertDeployRows(deployer, plan, res, A) {
    expect(res.chunks.length, 'one DEPLOY v4 carrier per base64 slice').to.equal(plan.totalChunks);
    for (let i = 0; i < res.chunks.length; i++)
        expect(res.chunks[i].indexed.status, 'carrier ' + i + ' indexed').to.equal('valid');
    expect(res.deploy.indexed.status, 'the assembling DEPLOY indexed').to.equal('valid');
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
    return exec;
}

async function assertStateAndDeposit(sdk, res, A, run, tick) {
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
}

describe('[sdk] chunked DEPLOY clients (the SDK resolves the contract through the explorer)', function () {
    this.timeout(0);

    let sdk, deployer;

    before(async function () {
        if (!haveConnectors()) this.skip();
        // Raw-hex placement plus an empty competing chain is the BTC/LTC mechanism;
        // DOGE regtest mines on a different model. LTC would additionally need a
        // native fee output on every leg, which the SDK workflow does not thread.
        if (global.COIN_CODE !== 'BTC') this.skip();

        sdk = makeSdk();
        deployer = await fundedGasAddress(sdk, 1);
        console.log('    [clients] deployer=' + deployer.address);
    });

    it('AT9a workflows.deployContract returns the contract index the explorer resolved, and its deposit lands on that contract', async function () {
        const run = uniqueTick('C9A');
        const { plan, res, tick } = await deployContractWithDeposit(sdk, deployer, run);

        // The assembling leg's own action_index, read from the transaction this
        // drill broadcast rather than from the value under test.
        const A = await waitFor(async () => actionIndexOfTx(res.deploy.txid), 'the assembling DEPLOY to index');
        const exec = await assertDeployRows(deployer, plan, res, A);
        await assertStateAndDeposit(sdk, res, A, run, tick);

        console.log('    [clients] AT9a A=' + A + ' contractActionIndex=' + res.contractActionIndex +
                    ' deposit=' + DEPOSIT_AMOUNT + ' ' + tick + ' gas_used=' + exec.gas_used);
    });
});
