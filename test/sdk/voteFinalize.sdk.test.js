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
 * XChain Platform E2E - VOTE v2 finalization (Phase 2)
 *
 * Exercises the system-injected VOTE v2 finalize on the live regtest stack:
 * the per-block sweep freezes a poll's tally on-chain when it reaches its
 * effective close. No user submits v2; the indexer synthesizes it. We assert
 * the frozen result in the indexer DB (polls summary + poll_results rows).
 *
 *   1. time-finalize - a poll past END_BLOCK -> finalized, winning_option set,
 *      one poll_results row per option
 *   2. early-decide  - a majority ballot crosses DECIDE_THRESHOLD before
 *      END_BLOCK -> finalized with decided_early=1, effective_close < END_BLOCK
 *   3. failed_quorum - a poll that misses MIN_VOTERS closes failed_quorum with
 *      no winner
 *
 ********************************************************************/

const { expect } = require('chai');
const { makeSdk, submit, fundedSdkAddress, fundedGasAddress, mine, uniqueTick, submitOpts } = require('./sdkHelper');

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

// Poll the indexer DB until the poll leaves 'open' (the per-block sweep has
// finalized it), nudging the miner so the finalization block gets produced.
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

// Issue a fresh governance token and distribute stakes. `stakes` is
// [[addr, amount], ...]; the issuer keeps the remainder of mintSupply.
async function issueGov(sdk, issuer, mintSupply) {
    const tick = uniqueTick('FIN');
    const res = await submit(sdk,
        { action: 'ISSUE', params: { tick, maxSupply: 10000000, maxMint: 100000, decimals: 0, description: 'finalize', mintSupply } },
        { pubkey: issuer.address, change: issuer.address },
        submitOpts({ wif: issuer.wif })
    );
    expect(res.indexed.status, 'ISSUE status').to.equal('valid');
    return tick;
}

async function sendTick(sdk, issuer, tick, dest, amount) {
    const res = await submit(sdk,
        { action: 'SEND', params: { tick, amount, destination: dest } },
        { pubkey: issuer.address, change: issuer.address },
        submitOpts({ wif: issuer.wif })
    );
    expect(res.indexed.status, 'SEND status').to.equal('valid');
}

async function createPoll(sdk, issuer, params) {
    const res = await submit(sdk,
        { action: 'VOTE', params: Object.assign({ version: 0 }, params) },
        { pubkey: issuer.address, change: issuer.address },
        submitOpts({ wif: issuer.wif })
    );
    expect(res.indexed.status, 'VOTE create status').to.equal('valid');
    return actionIndexOf(res);
}

async function castBallot(sdk, voter, pollIndex, ballot) {
    const res = await submit(sdk,
        { action: 'VOTE', params: { version: 1, pollRef: pollIndex, ballot } },
        { pubkey: voter.address, change: voter.address },
        submitOpts({ wif: voter.wif })
    );
    expect(res.indexed.status, 'ballot status').to.equal('valid');
}

describe('[sdk] VOTE v2 finalization', function () {
    this.timeout(0);

    let sdk, issuer, voterA, voterB;

    before(async function () {
        // compactAddresses off: the SDK's ^id destination compaction is ahead of the
        // indexer's wire acceptance (P4 arming / F3 gate open) and can invalidate the
        // setup SENDs; these suites test VOTE semantics, not address compaction.
        sdk = makeSdk({ compactAddresses: false });
        issuer = await fundedGasAddress(sdk, 0.2);
        voterA = await fundedGasAddress(sdk, 0.2);
        voterB = await fundedGasAddress(sdk, 0.2);
    });

    it('time-finalize: a closed poll freezes a winner + poll_results rows', async function () {
        // GOV supply 1000: A=300, B=100, issuer keeps 600.
        const tick = await issueGov(sdk, issuer, 1000);
        await sendTick(sdk, issuer, tick, voterA.address, 300);
        await sendTick(sdk, issuer, tick, voterB.address, 100);
        await mine(1);

        const endBlock = (await height()) + 8;
        const pollIndex = await createPoll(sdk, issuer, {
            tick, endBlock, options: 'YES,NO', maxSelections: 1,
            tallyMode: 'approval', weightMode: 'balance', question: 'Time finalize?'
        });
        // A -> NO(1) weight 300; B -> YES(0) weight 100. NO leads.
        await castBallot(sdk, voterA, pollIndex, '1');
        await castBallot(sdk, voterB, pollIndex, '0');

        const poll = await waitFinalized(pollIndex);
        expect(poll, 'poll row').to.not.be.null;
        expect(poll.poll_status, 'poll_status').to.equal('finalized');
        expect(Number(poll.winning_option), 'winning_option (NO)').to.equal(1);
        expect(Number(poll.decided_early), 'decided_early').to.equal(0);

        const results = await dbQuery('SELECT option_index, total_weight, voter_count FROM poll_results WHERE poll_index = ? ORDER BY option_index', [pollIndex]);
        expect(results.length, 'poll_results rows').to.equal(2);
        const byOpt = {};
        for (const r of results) byOpt[Number(r.option_index)] = r;
        expect(String(byOpt[0].total_weight), 'YES weight').to.equal('100');
        expect(String(byOpt[1].total_weight), 'NO weight').to.equal('300');
        console.log('    [sdk] poll #' + pollIndex + ' finalized: winner=NO YES=100 NO=300');
    });

    it('early-decide: a majority ballot closes the poll before END_BLOCK', async function () {
        // GOV supply 1000: A=600 (>50%), issuer keeps 400. DECIDE_THRESHOLD 0.5.
        const tick = await issueGov(sdk, issuer, 1000);
        await sendTick(sdk, issuer, tick, voterA.address, 600);
        await mine(1);

        const endBlock = (await height()) + 60; // far close, so early-decide wins
        const pollIndex = await createPoll(sdk, issuer, {
            tick, endBlock, options: 'YES,NO', maxSelections: 1,
            tallyMode: 'approval', weightMode: 'balance',
            decideThreshold: '0.5', question: 'Early decide?'
        });
        // A holds 600/1000 = 0.6 of supply on YES -> crosses 0.5.
        await castBallot(sdk, voterA, pollIndex, '0');

        const poll = await waitFinalized(pollIndex);
        expect(poll, 'poll row').to.not.be.null;
        expect(poll.poll_status, 'poll_status').to.equal('finalized');
        expect(Number(poll.winning_option), 'winning_option (YES)').to.equal(0);
        expect(Number(poll.decided_early), 'decided_early').to.equal(1);
        expect(Number(poll.effective_close_block), 'closed before END_BLOCK').to.be.below(endBlock);
        console.log('    [sdk] poll #' + pollIndex + ' early-decided at block ' + poll.effective_close_block + ' (END_BLOCK ' + endBlock + ')');
    });

    it('failed_quorum: a poll missing MIN_VOTERS closes with no winner', async function () {
        // GOV supply 1000: A=300, issuer keeps 700. MIN_VOTERS 5 (only 1 votes).
        const tick = await issueGov(sdk, issuer, 1000);
        await sendTick(sdk, issuer, tick, voterA.address, 300);
        await mine(1);

        const endBlock = (await height()) + 8;
        const pollIndex = await createPoll(sdk, issuer, {
            tick, endBlock, options: 'YES,NO', maxSelections: 1,
            tallyMode: 'approval', weightMode: 'balance',
            minVoters: 5, question: 'Needs 5 voters'
        });
        await castBallot(sdk, voterA, pollIndex, '0');

        const poll = await waitFinalized(pollIndex);
        expect(poll, 'poll row').to.not.be.null;
        expect(poll.poll_status, 'poll_status').to.equal('failed_quorum');
        expect(poll.fail_reason, 'fail_reason').to.equal('min_voters');
        expect(poll.winning_option, 'winning_option is null').to.be.null;
        console.log('    [sdk] poll #' + pollIndex + ' failed_quorum (min_voters), no winner');
    });
});
