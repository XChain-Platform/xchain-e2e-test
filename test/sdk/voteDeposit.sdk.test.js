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
 * XChain Platform E2E - VOTE creation deposit (Phase 4, Section 15)
 *
 * A poll creator may escrow a GAS deposit at v0 (anti-spam). VOTE v2 finalize
 * releases it: refunded to the creator on a real outcome ('finalized'), or
 * forfeited to the DONATE1 treasury when the poll dies for lack of participation
 * ('failed_quorum'). No VM is involved, so this runs on the standard regtest
 * indexer. We assert the escrow ledger directly (escrows + balances rows), which
 * is fee-noise-free, plus the polls.deposit_resolved outcome.
 *
 *   1. refund   - a poll that finalizes refunds the deposit; escrow nets to zero
 *                 and deposit_resolved='refunded'
 *   2. forfeit  - a poll that fails quorum forfeits the deposit to DONATE1;
 *                 the treasury balance rises by the deposit, deposit_resolved='forfeited'
 *
 ********************************************************************/

const { expect } = require('chai');
const { makeSdk, submit, fundedGasAddress, mine, uniqueTick, submitOpts } = require('./sdkHelper');

// BTC regtest protocol treasury (src/coins/BTC.js regtest.addresses.DONATE1).
const DONATE1 = 'muYHF9MMnK6Nmd5zx7EBtqEYZdaf2Xy8JX';
const DEPOSIT = '50'; // GAS escrowed per poll (creator holds 100000 from the gas faucet)

function actionIndexOf(res) {
    const actions = res && res.indexed && res.indexed.actions;
    if (!Array.isArray(actions) || actions.length === 0)
        throw new Error('submitAction result carried no indexed actions');
    return actions[0].action_index;
}

async function dbQuery(sql, params) {
    const connection = await global.indexerDatabase.getConnection();
    try { return await connection.query(sql, params); }
    finally { await connection.release(); }
}

async function height() { return await global.nodeConnector.getBlockCount(); }

// Net escrow held against an address for a tick (sum of all escrow rows; the
// release writes a negative row, so a fully-released hold nets to zero).
async function escrowHeld(address, tick) {
    const rows = await dbQuery(
        `SELECT COALESCE(SUM(CAST(e.amount AS DECIMAL(40,8))), 0) AS held
           FROM escrows e
           JOIN index_addresses a ON a.id = e.address_id
           JOIN index_tickers   t ON t.id = e.tick_id
          WHERE a.address = ? AND t.tick = ?`, [address, tick]);
    return Number(rows[0].held);
}

async function balanceOf(address, tick) {
    const rows = await dbQuery(
        `SELECT b.amount FROM balances b
           JOIN index_addresses a ON a.id = b.address_id
           JOIN index_tickers   t ON t.id = b.tick_id
          WHERE a.address = ? AND t.tick = ?`, [address, tick]);
    return rows.length ? Number(rows[0].amount) : 0;
}

async function waitFinalized(pollIndex, timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const rows = await dbQuery('SELECT * FROM polls WHERE action_index = ?', [pollIndex]);
        if (rows.length && rows[0].poll_status !== 'open') return rows[0];
        await mine(1);
        await new Promise(r => setTimeout(r, 1500));
    }
    const rows = await dbQuery('SELECT * FROM polls WHERE action_index = ?', [pollIndex]);
    return rows[0] || null;
}

async function issueGov(sdk, issuer, mintSupply) {
    const tick = uniqueTick('DEP');
    const res = await submit(sdk,
        { action: 'ISSUE', params: { tick, maxSupply: 10000000, maxMint: 100000, decimals: 0, description: 'deposit', mintSupply } },
        { pubkey: issuer.address, change: issuer.address },
        submitOpts({ wif: issuer.wif }));
    expect(res.indexed.status, 'ISSUE status').to.equal('valid');
    return tick;
}

async function sendTick(sdk, issuer, tick, dest, amount) {
    const res = await submit(sdk,
        { action: 'SEND', params: { tick, amount, destination: dest } },
        { pubkey: issuer.address, change: issuer.address },
        submitOpts({ wif: issuer.wif }));
    expect(res.indexed.status, 'SEND status').to.equal('valid');
}

async function createPollWithDeposit(sdk, issuer, params) {
    const res = await submit(sdk,
        { action: 'VOTE', params: Object.assign({ version: 0, deposit: DEPOSIT }, params) },
        { pubkey: issuer.address, change: issuer.address },
        submitOpts({ wif: issuer.wif }));
    expect(res.indexed.status, 'VOTE create status').to.equal('valid');
    return actionIndexOf(res);
}

async function castBallot(sdk, voter, pollIndex, ballot) {
    const res = await submit(sdk,
        { action: 'VOTE', params: { version: 1, pollRef: pollIndex, ballot } },
        { pubkey: voter.address, change: voter.address },
        submitOpts({ wif: voter.wif }));
    expect(res.indexed.status, 'ballot status').to.equal('valid');
}

describe('[sdk] VOTE creation deposit', function () {
    this.timeout(0);

    let sdk, issuer, voterA, voterB;

    before(async function () {
        // BTC funding is only for tiny regtest tx fees (the deposit is paid in gas,
        // which the gas faucet mints), and the cosigner_test faucet runs lean at this
        // height (subsidy is long since halved to dust). Keep each address small.
        // compactAddresses off: the SDK's ^id destination compaction is ahead of the
        // indexer's wire acceptance (P4 arming / F3 gate open) and can invalidate the
        // setup SENDs; these suites test VOTE semantics, not address compaction.
        sdk = makeSdk({ compactAddresses: false });
        issuer = await fundedGasAddress(sdk, 0.015);
        voterA = await fundedGasAddress(sdk, 0.012);
        voterB = await fundedGasAddress(sdk, 0.012);
    });

    it('refund: a finalized poll returns the deposit to the creator', async function () {
        const tick = await issueGov(sdk, issuer, 1000);
        await sendTick(sdk, issuer, tick, voterA.address, 300);
        await sendTick(sdk, issuer, tick, voterB.address, 100);
        await mine(1);

        const heldBefore = await escrowHeld(issuer.address, 'XCHAIN');

        const endBlock = (await height()) + 8;
        const pollIndex = await createPollWithDeposit(sdk, issuer, {
            tick, endBlock, options: 'YES,NO', maxSelections: 1,
            tallyMode: 'approval', weightMode: 'balance', question: 'Refund deposit?'
        });

        // The deposit is escrowed at creation: the held amount rises by DEPOSIT and
        // the poll row records the amount + creator.
        const heldAfterCreate = await escrowHeld(issuer.address, 'XCHAIN');
        expect(heldAfterCreate - heldBefore, 'escrow rose by deposit at create').to.equal(Number(DEPOSIT));
        const pollRow = (await dbQuery('SELECT * FROM polls WHERE action_index = ?', [pollIndex]))[0];
        expect(String(pollRow.deposit_amount), 'stored deposit_amount').to.equal(DEPOSIT);
        expect(pollRow.deposit_resolved, 'unresolved at create').to.be.null;

        await castBallot(sdk, voterA, pollIndex, '1'); // NO 300
        await castBallot(sdk, voterB, pollIndex, '0'); // YES 100

        const poll = await waitFinalized(pollIndex);
        expect(poll.poll_status, 'poll_status').to.equal('finalized');
        expect(poll.deposit_resolved, 'deposit refunded').to.equal('refunded');

        // The release writes a negative escrow row, so the creator's net held
        // returns to its pre-poll baseline (fee-noise-free check).
        const heldAfter = await escrowHeld(issuer.address, 'XCHAIN');
        expect(heldAfter, 'escrow released back to baseline').to.equal(heldBefore);
        console.log('    [sdk] poll #' + pollIndex + ' finalized: ' + DEPOSIT + ' XCHAIN deposit refunded');
    });

    it('forfeit: a failed_quorum poll sends the deposit to DONATE1', async function () {
        const tick = await issueGov(sdk, issuer, 1000);
        await sendTick(sdk, issuer, tick, voterA.address, 300);
        await mine(1);

        const heldBefore     = await escrowHeld(issuer.address, 'XCHAIN');
        const treasuryBefore = await balanceOf(DONATE1, 'XCHAIN');

        const endBlock = (await height()) + 8;
        const pollIndex = await createPollWithDeposit(sdk, issuer, {
            tick, endBlock, options: 'YES,NO', maxSelections: 1,
            tallyMode: 'approval', weightMode: 'balance',
            minVoters: 5, question: 'Forfeit deposit?'
        });
        await castBallot(sdk, voterA, pollIndex, '0'); // only one voter, MIN_VOTERS 5 unmet

        const poll = await waitFinalized(pollIndex);
        expect(poll.poll_status, 'poll_status').to.equal('failed_quorum');
        expect(poll.deposit_resolved, 'deposit forfeited').to.equal('forfeited');

        // Escrow released off the creator, and the treasury balance rose by exactly
        // the deposit.
        const heldAfter     = await escrowHeld(issuer.address, 'XCHAIN');
        const treasuryAfter = await balanceOf(DONATE1, 'XCHAIN');
        expect(heldAfter, 'escrow released off creator').to.equal(heldBefore);
        expect(treasuryAfter - treasuryBefore, 'DONATE1 received the deposit').to.equal(Number(DEPOSIT));
        console.log('    [sdk] poll #' + pollIndex + ' failed_quorum: ' + DEPOSIT + ' XCHAIN forfeited to DONATE1');
    });
});
