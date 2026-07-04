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
 **********************************************************************
 *
 * XChain Platform E2E - VOTE Phase 3 (anti-whale weight modes + delegation)
 *
 * Drives the Phase 3 governance features end-to-end and asserts the frozen
 * result the system-injected v2 finalization writes:
 *
 *   1. quadratic weight - sqrt(close balance) flattens a whale (a 100x holder
 *      gets 10x the weight, not 100x)
 *   2. time_weighted weight - average holdings over the window (here balances
 *      are steady, so the average equals the close balance)
 *   3. delegation (VOTE v3) - a delegator's weight flows to the delegate's
 *      ballot when the delegator does not vote directly
 *
 ********************************************************************/

const { expect } = require('chai');
const { makeSdk, submit, fundedGasAddress, mine, uniqueTick, submitOpts } = require('./sdkHelper');

function actionIndexOf(res) {
    const a = res && res.indexed && res.indexed.actions;
    if (!Array.isArray(a) || !a.length) throw new Error('no indexed actions');
    return a[0].action_index;
}
async function dbQuery(sql, params) {
    const c = await global.indexerDatabase.getConnection();
    try { return await c.query(sql, params); } finally { await c.release(); }
}
async function height() { return await global.nodeConnector.getBlockCount(); }
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
async function resultsFor(pollIndex) {
    const rows = await dbQuery('SELECT option_index, total_weight FROM poll_results WHERE poll_index = ? ORDER BY option_index', [pollIndex]);
    const byOpt = {};
    for (const r of rows) byOpt[Number(r.option_index)] = String(r.total_weight);
    return byOpt;
}
async function issueGov(sdk, issuer, mintSupply) {
    const tick = uniqueTick('ADV');
    const res = await submit(sdk,
        { action: 'ISSUE', params: { tick, maxSupply: 100000000, maxMint: 100000000, decimals: 0, description: 'advanced', mintSupply } },
        { pubkey: issuer.address, change: issuer.address }, submitOpts({ wif: issuer.wif }));
    expect(res.indexed.status, 'ISSUE').to.equal('valid');
    return tick;
}
async function sendTick(sdk, issuer, tick, dest, amount) {
    const res = await submit(sdk, { action: 'SEND', params: { tick, amount, destination: dest } },
        { pubkey: issuer.address, change: issuer.address }, submitOpts({ wif: issuer.wif }));
    expect(res.indexed.status, 'SEND').to.equal('valid');
}
async function createPoll(sdk, issuer, params) {
    const res = await submit(sdk, { action: 'VOTE', params: Object.assign({ version: 0 }, params) },
        { pubkey: issuer.address, change: issuer.address }, submitOpts({ wif: issuer.wif }));
    expect(res.indexed.status, 'VOTE create').to.equal('valid');
    return actionIndexOf(res);
}
async function castBallot(sdk, voter, pollIndex, ballot) {
    const res = await submit(sdk, { action: 'VOTE', params: { version: 1, pollRef: pollIndex, ballot } },
        { pubkey: voter.address, change: voter.address }, submitOpts({ wif: voter.wif }));
    expect(res.indexed.status, 'ballot').to.equal('valid');
}
async function setDelegation(sdk, delegator, tick, delegateAddr) {
    const res = await submit(sdk, { action: 'VOTE', params: { version: 3, tick, delegateTo: delegateAddr } },
        { pubkey: delegator.address, change: delegator.address }, submitOpts({ wif: delegator.wif }));
    expect(res.indexed.status, 'delegate').to.equal('valid');
    return actionIndexOf(res);
}

describe('[sdk] VOTE Phase 3 (weight modes + delegation)', function () {
    this.timeout(0);

    let sdk, issuer, A, B, C;

    before(async function () {
        // compactAddresses off: the SDK's ^id destination compaction is ahead of the
        // indexer's wire acceptance (P4 arming / F3 gate open) and can invalidate the
        // setup SENDs; these suites test VOTE semantics, not address compaction.
        sdk = makeSdk({ compactAddresses: false });
        // Modest per-address funding (change returns to each address, so the
        // issuer's many txs stay covered); keeps the suite within a lean faucet.
        const FUND = 0.08;
        issuer = await fundedGasAddress(sdk, FUND);
        A = await fundedGasAddress(sdk, FUND);
        B = await fundedGasAddress(sdk, FUND);
        C = await fundedGasAddress(sdk, FUND);
    });

    it('quadratic weight flattens a whale (sqrt of close balance)', async function () {
        // issuer (whale) keeps 10000, A=100, B=100. Whale->YES, A,B->NO.
        // quadratic: YES=sqrt(10000)=100, NO=sqrt(100)+sqrt(100)=20. YES wins by 5x, not 100x.
        const tick = await issueGov(sdk, issuer, 10200);
        await sendTick(sdk, issuer, tick, A.address, 100);
        await sendTick(sdk, issuer, tick, B.address, 100);
        await mine(1);
        const endBlock = (await height()) + 8;
        const pollIndex = await createPoll(sdk, issuer, {
            tick, endBlock, options: 'YES,NO', maxSelections: 1, tallyMode: 'approval',
            weightMode: 'quadratic', minVoteBalance: 1, question: 'Quadratic?'
        });
        await castBallot(sdk, issuer, pollIndex, '0'); // whale YES
        await castBallot(sdk, A, pollIndex, '1');      // NO
        await castBallot(sdk, B, pollIndex, '1');      // NO

        const poll = await waitFinalized(pollIndex);
        expect(poll.poll_status, 'status').to.equal('finalized');
        const r = await resultsFor(pollIndex);
        expect(r[0], 'YES = sqrt(10000) = 100').to.equal('100');
        expect(r[1], 'NO = sqrt(100)*2 = 20').to.equal('20');
        expect(Number(poll.winning_option), 'winner YES').to.equal(0);
        console.log('    [sdk] quadratic poll #' + pollIndex + ' YES=100 NO=20 (whale held 10000, weight only 100)');
    });

    it('time_weighted weight (steady balances => average equals close balance)', async function () {
        const tick = await issueGov(sdk, issuer, 1000);
        await sendTick(sdk, issuer, tick, A.address, 300);
        await sendTick(sdk, issuer, tick, B.address, 100);
        await mine(2);
        const endBlock = (await height()) + 8;
        const pollIndex = await createPoll(sdk, issuer, {
            tick, endBlock, options: 'YES,NO', maxSelections: 1, tallyMode: 'approval',
            weightMode: 'time_weighted', question: 'Time-weighted?'
        });
        await castBallot(sdk, A, pollIndex, '0'); // 300 -> YES
        await castBallot(sdk, B, pollIndex, '1'); // 100 -> NO

        const poll = await waitFinalized(pollIndex);
        expect(poll.poll_status, 'status').to.equal('finalized');
        const r = await resultsFor(pollIndex);
        // Balances steady across the window, so avg == balance.
        expect(Number(r[0]), 'YES ~= 300').to.equal(300);
        expect(Number(r[1]), 'NO ~= 100').to.equal(100);
        expect(Number(poll.winning_option), 'winner YES').to.equal(0);
        console.log('    [sdk] time_weighted poll #' + pollIndex + ' YES=' + r[0] + ' NO=' + r[1]);
    });

    it('delegation: a delegator weight flows to the delegate ballot (VOTE v3)', async function () {
        // issuer keeps 100 (to create), A=300, B=100, C=200.
        const tick = await issueGov(sdk, issuer, 700);
        await sendTick(sdk, issuer, tick, A.address, 300);
        await sendTick(sdk, issuer, tick, B.address, 100);
        await sendTick(sdk, issuer, tick, C.address, 200);
        await mine(1);

        // A delegates its weight to B, then does NOT vote.
        const delIndex = await setDelegation(sdk, A, tick, B.address);
        const delRows = await dbQuery('SELECT * FROM vote_delegations WHERE action_index = ?', [delIndex]);
        expect(delRows.length, 'delegation row written').to.equal(1);

        const endBlock = (await height()) + 8;
        const pollIndex = await createPoll(sdk, issuer, {
            tick, endBlock, options: 'YES,NO', maxSelections: 1, tallyMode: 'approval',
            weightMode: 'balance', question: 'Delegation?'
        });
        await castBallot(sdk, B, pollIndex, '0'); // B votes YES (carries A's 300 + own 100)
        await castBallot(sdk, C, pollIndex, '1'); // C votes NO (200)

        const poll = await waitFinalized(pollIndex);
        expect(poll.poll_status, 'status').to.equal('finalized');
        const r = await resultsFor(pollIndex);
        expect(r[0], 'YES = B(100) + A delegated(300) = 400').to.equal('400');
        expect(r[1], 'NO = C(200)').to.equal('200');
        expect(Number(poll.winning_option), 'winner YES').to.equal(0);
        console.log('    [sdk] delegation poll #' + pollIndex + ' YES=400 (B 100 + A delegated 300) NO=200');
    });
});
