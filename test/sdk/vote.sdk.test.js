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
 * XChain Platform E2E - SDK-driven VOTE (token-weighted governance)
 *
 * Drives the Phase 1 VOTE action end-to-end through the live regtest
 * stack via sdk.submitAction(): a real tx is encoded, broadcast, mined,
 * decoded, and indexed, and we then assert the indexer wrote the right
 * rows into the polls + votes tables.
 *
 *   v0 create  -> one row in `polls`
 *   v1 ballot  -> one row per selected option in `votes`
 *
 * One token (TICK) is both the electorate and the weight basis. Coverage:
 *   1. approval / balance happy path (create + 3 single-option ballots)
 *   2. split multi-select ballot (exercises OPTION:SHARE parsing)
 *   3. hold-to-vote gate: a non-holder's ballot indexes invalid (no row)
 *
 * The tally MATH (getHolders snapshot, hold-to-count drop, quorum) is
 * proven separately as a unit test against the indexer's getPollTally;
 * here we prove the decode -> index -> store path is live and correct.
 *
 ********************************************************************/

const { expect } = require('chai');
const { makeSdk, submit, fundedSdkAddress, fundedGasAddress, mine, uniqueTick, submitOpts } = require('./sdkHelper');

// Pull the created action's on-chain action_index out of a submitAction
// result. A VOTE tx carries exactly one action, so actions[0] is it; the
// index is the poll's permanent id and becomes POLL_REF for every ballot.
function actionIndexOf(res) {
    const actions = res && res.indexed && res.indexed.actions;
    if (!Array.isArray(actions) || actions.length === 0)
        throw new Error('submitAction result carried no indexed actions');
    return actions[0].action_index;
}

// Run a raw read against the indexer DB through the e2e connector pool.
async function dbQuery(sql, params) {
    const connection = await global.indexerDatabase.getConnection();
    try {
        return await connection.query(sql, params);
    } finally {
        await connection.release();
    }
}

// The poll/ballot rows are written inside the same indexer parse() that
// flips the action status to valid, so they are present the moment
// submitAction resolves. A short retry absorbs any replica/commit lag.
async function rowsFor(table, pollIndex, expectCount) {
    const col = table === 'polls' ? 'action_index' : 'poll_index';
    for (let attempt = 0; attempt < 20; attempt++) {
        const rows = await dbQuery('SELECT * FROM ' + table + ' WHERE ' + col + ' = ?', [pollIndex]);
        if (rows.length >= expectCount) return rows;
        await new Promise(r => setTimeout(r, 500));
    }
    return await dbQuery('SELECT * FROM ' + table + ' WHERE ' + col + ' = ?', [pollIndex]);
}

describe('[sdk] VOTE token-weighted governance', function () {
    this.timeout(0);

    let sdk, issuer, voterA, voterB, voterC, outsider, tick;

    before(async function () {
        // compactAddresses off: the SDK's ^id destination compaction is ahead of the
        // indexer's wire acceptance (P4 arming / F3 gate open) and can invalidate the
        // setup SENDs; these suites test VOTE semantics, not address compaction.
        sdk = makeSdk({ compactAddresses: false });

        // Issuer holds gas + mints the governance token; each voter is funded,
        // gets gas to pay their own ballot fees, and is sent a TICK stake. The
        // outsider is funded + gassed but deliberately holds zero TICK.
        // Each address needs only a little coin for tx fees/dust; gas is the
        // separate XCHAIN token minted by fundedGasAddress. Keep the per-address
        // funding modest so the suite fits a depleted regtest faucet wallet.
        const FUND = 0.1;
        issuer   = await fundedGasAddress(sdk, FUND);
        voterA   = await fundedGasAddress(sdk, FUND);
        voterB   = await fundedGasAddress(sdk, FUND);
        voterC   = await fundedGasAddress(sdk, FUND);
        outsider = await fundedGasAddress(sdk, FUND);
        tick = uniqueTick('GOV');

        let res = await submit(sdk,
            { action: 'ISSUE', params: { tick, maxSupply: 1000000, maxMint: 100000, decimals: 0, description: 'governance', mintSupply: 1000 } },
            { pubkey: issuer.address, change: issuer.address },
            submitOpts({ wif: issuer.wif })
        );
        expect(res.indexed.status, 'ISSUE status').to.equal('valid');

        // Distribute the electorate's stake: A=100, B=200, C=50.
        for (const [voter, amount] of [[voterA, 100], [voterB, 200], [voterC, 50]]) {
            res = await submit(sdk,
                { action: 'SEND', params: { tick, amount, destination: voter.address } },
                { pubkey: issuer.address, change: issuer.address },
                submitOpts({ wif: issuer.wif })
            );
            expect(res.indexed.status, 'SEND ' + amount + ' status').to.equal('valid');
        }
        await mine(1);
        console.log('    [sdk] tick=' + tick + ' issuer=' + issuer.address);
    });

    describe('approval / balance poll', function () {
        let pollIndex;

        it('VOTE v0 create writes a polls row', async function () {
            const endBlock = (await global.nodeConnector.getBlockCount()) + 100;
            const res = await submit(sdk,
                { action: 'VOTE', params: {
                    version: 0,
                    tick,
                    endBlock,
                    options: 'YES,NO',
                    maxSelections: 1,
                    tallyMode: 'approval',
                    weightMode: 'balance',
                    question: 'Adopt proposal A?'
                } },
                { pubkey: issuer.address, change: issuer.address },
                submitOpts({ wif: issuer.wif })
            );
            expect(res.indexed.status, 'VOTE create status').to.equal('valid');
            pollIndex = actionIndexOf(res);

            const polls = await rowsFor('polls', pollIndex, 1);
            expect(polls.length, 'polls row count').to.equal(1);
            const poll = polls[0];
            expect(poll.tally_mode, 'tally_mode').to.equal('approval');
            expect(poll.weight_mode, 'weight_mode').to.equal('balance');
            expect(Number(poll.max_selections), 'max_selections').to.equal(1);
            expect(poll.poll_status, 'poll_status').to.equal('open');
            expect(JSON.parse(poll.options), 'options').to.deep.equal(['YES', 'NO']);
            console.log('    [sdk] poll #' + pollIndex + ' open, options=' + poll.options);
        });

        it('three single-option ballots each write a votes row', async function () {
            // A->YES(0), B->NO(1), C->YES(0). Approval+balance tally (proven in
            // unit test): YES=100+50=150, NO=200 -> NO wins. Here we assert the
            // ballots persisted with the right choice; the tally is computed lazily.
            for (const [voter, choice] of [[voterA, 0], [voterB, 1], [voterC, 0]]) {
                const res = await submit(sdk,
                    { action: 'VOTE', params: { version: 1, pollRef: pollIndex, ballot: String(choice) } },
                    { pubkey: voter.address, change: voter.address },
                    submitOpts({ wif: voter.wif })
                );
                expect(res.indexed.status, 'ballot status').to.equal('valid');
            }

            const votes = await rowsFor('votes', pollIndex, 3);
            expect(votes.length, 'votes row count').to.equal(3);
            const choices = votes.map(v => Number(v.choice)).sort();
            expect(choices, 'recorded choices').to.deep.equal([0, 0, 1]);
            console.log('    [sdk] poll #' + pollIndex + ' recorded ' + votes.length + ' ballots');
        });

        it('hold-to-vote gate: a non-holder ballot writes no votes row', async function () {
            // The outsider holds gas (XCHAIN) but not the poll's TICK, so the
            // protocol-level hold-to-vote gate must reject the ballot. The
            // authoritative proof is that NO votes row is written for it; the
            // explorer-derived SDK status is only logged (it can lag/route to a
            // different indexer on a multi-indexer host).
            const res = await submit(sdk,
                { action: 'VOTE', params: { version: 1, pollRef: pollIndex, ballot: '0' } },
                { pubkey: outsider.address, change: outsider.address },
                submitOpts({ wif: outsider.wif, requireValid: false })
            );
            console.log('    [sdk] non-holder ballot SDK status=' + (res.indexed && res.indexed.status));
            // Give the indexer a beat to process, then confirm the gate held:
            // still exactly the three valid ballots, the rejected one a no-op.
            await mine(1);
            await new Promise(r => setTimeout(r, 1500));
            const votes = await dbQuery('SELECT * FROM votes WHERE poll_index = ?', [pollIndex]);
            expect(votes.length, 'votes row count unchanged (non-holder rejected)').to.equal(3);
        });
    });

    describe('split multi-select poll', function () {
        let pollIndex;

        it('VOTE v0 create (split, max 3) then a split ballot writes one row per option', async function () {
            const endBlock = (await global.nodeConnector.getBlockCount()) + 100;
            let res = await submit(sdk,
                { action: 'VOTE', params: {
                    version: 0,
                    tick,
                    endBlock,
                    options: 'ALPHA,BETA,GAMMA',
                    maxSelections: 3,
                    tallyMode: 'split',
                    weightMode: 'balance',
                    question: 'Allocate across A/B/C'
                } },
                { pubkey: issuer.address, change: issuer.address },
                submitOpts({ wif: issuer.wif })
            );
            expect(res.indexed.status, 'split VOTE create status').to.equal('valid');
            pollIndex = actionIndexOf(res);

            // Voter A splits weight across two options: 0:60 / 1:40 (relative shares).
            res = await submit(sdk,
                { action: 'VOTE', params: { version: 1, pollRef: pollIndex, ballot: '0:60,1:40' } },
                { pubkey: voterA.address, change: voterA.address },
                submitOpts({ wif: voterA.wif })
            );
            expect(res.indexed.status, 'split ballot status').to.equal('valid');

            const votes = await rowsFor('votes', pollIndex, 2);
            expect(votes.length, 'split votes row count').to.equal(2);
            const byChoice = {};
            for (const v of votes) byChoice[Number(v.choice)] = String(v.share);
            expect(byChoice[0], 'share for option 0').to.equal('60');
            expect(byChoice[1], 'share for option 1').to.equal('40');
            console.log('    [sdk] split poll #' + pollIndex + ' shares 0=' + byChoice[0] + ' 1=' + byChoice[1]);
        });
    });
});
