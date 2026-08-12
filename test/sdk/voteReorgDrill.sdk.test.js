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
 * XChain Platform E2E - VOTE re-ballot reorg drill
 *
 * Proves the append-only votes design is reorg-safe end to end. The original
 * delete-then-insert createBallot destroyed the voter's prior ballot on a
 * re-vote; a reorg orphaning the replacement could never restore it (the prior
 * ballot's block sits below the rollback point and never reprocesses), so a
 * reorged node's tally forked from a from-genesis replay. This drill:
 *
 *   1. creates a poll, casts ballot A (YES), then re-votes ballot B (NO) in a
 *      later block, and asserts BOTH sets coexist in `votes` with B as the
 *      voter's current (MAX action_index) ballot;
 *   2. orphans ballot B's block onto an empty competing chain (same mechanism
 *      as chunkedDeployReorgDrill) and asserts rollback deletes ONLY B's set,
 *      leaving ballot A restored as the current ballot (pre-fix this left the
 *      voter with NO ballot at all: the consensus divergence);
 *   3. resumes auto-mining so the orphaned re-vote re-confirms from the
 *      mempool, and asserts it becomes the current ballot again under a new
 *      action_index (deterministic re-application).
 *
 *   Run:
 *     COIN=bitcoin NETWORK=regtest npm run test:sdk:vote-reorg
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const cryptoHelper = require('../cryptoHelper');
const { makeSdk, submit, fundedGasAddress, mine, uniqueTick, submitOpts } = require('./sdkHelper');

function haveConnectors() {
    return global.nodeConnector && global.regtestMinerConnector && global.indexerDatabase;
}

async function idxQuery(sql, params) {
    const conn = await global.indexerDatabase.getConnection();
    try { return await conn.query(sql, params); } finally { await conn.release(); }
}

// The voter's CURRENT ballot rows, exactly as db.getPollTally selects them:
// only the (poll, voter) set at MAX(action_index).
async function currentBallot(pollIndex) {
    return idxQuery(
        'SELECT action_index, choice FROM votes v WHERE v.poll_index = ? ' +
        '  AND v.action_index = (SELECT MAX(v2.action_index) FROM votes v2 ' +
        '       WHERE v2.poll_index = v.poll_index AND v2.voter_address_id = v.voter_address_id) ' +
        'ORDER BY choice ASC', [pollIndex]);
}

function actionIndexOf(res) {
    const actions = res && res.indexed && res.indexed.actions;
    if (!Array.isArray(actions) || actions.length === 0)
        throw new Error('submitAction result carried no indexed actions');
    return actions[0].action_index;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

describe('[sdk] VOTE re-ballot reorg drill (orphaned re-vote restores the prior ballot)', function () {
    this.timeout(0);

    let sdk, issuer, voter, tick, pollIndex, ballotAIndex, ballotBIndex, ballotBBlock;

    before(async function () {
        if (!haveConnectors()) this.skip();
        // Empty-competing-chain reorgs are a BTC/LTC mechanism; DOGE regtest's
        // fast-chain mining model differs. Skip, as the other reorg drills do.
        if (global.COIN_CODE === 'DOGE') this.skip();
        // compactAddresses off: the SDK's ^id destination compaction is ahead of
        // the indexer's wire acceptance on this stack (P4 arming / F3 gate open),
        // and this drill tests VOTE reorg semantics, not address compaction.
        sdk = makeSdk({ compactAddresses: false });
        issuer = await fundedGasAddress(sdk, 0.1);
        voter  = await fundedGasAddress(sdk, 0.1);
        tick   = uniqueTick('RRB');

        let res = await submit(sdk,
            { action: 'ISSUE', params: { tick, maxSupply: 1000, maxMint: 100, decimals: 0, description: 'reorg drill', mintSupply: 500 } },
            { pubkey: issuer.address, change: issuer.address },
            submitOpts({ wif: issuer.wif }));
        expect(res.indexed.status, 'ISSUE status').to.equal('valid');

        res = await submit(sdk,
            { action: 'SEND', params: { tick, amount: 100, destination: voter.address } },
            { pubkey: issuer.address, change: issuer.address },
            submitOpts({ wif: issuer.wif }));
        expect(res.indexed.status, 'SEND status').to.equal('valid');
        await mine(1);
    });

    it('a re-vote appends a second ballot set; the latest set is the current ballot', async function () {
        const endBlock = (await global.nodeConnector.getBlockCount()) + 200;
        let res = await submit(sdk,
            { action: 'VOTE', params: { version: 0, tick, endBlock, options: 'YES,NO', maxSelections: 1, tallyMode: 'approval', weightMode: 'balance', question: 'reorg drill' } },
            { pubkey: issuer.address, change: issuer.address },
            submitOpts({ wif: issuer.wif }));
        expect(res.indexed.status, 'VOTE create status').to.equal('valid');
        pollIndex = actionIndexOf(res);
        await mine(1);

        // Ballot A: YES (option 0), confirmed in its own block.
        res = await submit(sdk,
            { action: 'VOTE', params: { version: 1, pollRef: pollIndex, ballot: '0' } },
            { pubkey: voter.address, change: voter.address },
            submitOpts({ wif: voter.wif }));
        expect(res.indexed.status, 'ballot A status').to.equal('valid');
        ballotAIndex = actionIndexOf(res);
        await mine(1);

        // Ballot B: the re-vote, NO (option 1), in a later block.
        res = await submit(sdk,
            { action: 'VOTE', params: { version: 1, pollRef: pollIndex, ballot: '1' } },
            { pubkey: voter.address, change: voter.address },
            submitOpts({ wif: voter.wif }));
        expect(res.indexed.status, 'ballot B status').to.equal('valid');
        ballotBIndex = actionIndexOf(res);
        await mine(1);

        const blockRows = await idxQuery('SELECT block_index FROM votes WHERE action_index = ?', [ballotBIndex]);
        expect(blockRows.length, 'ballot B rows present').to.equal(1);
        ballotBBlock = Number(blockRows[0].block_index);

        // Append-only: BOTH sets coexist; the tally filter picks only ballot B.
        const all = await idxQuery('SELECT action_index, choice FROM votes WHERE poll_index = ? ORDER BY action_index ASC', [pollIndex]);
        expect(all.length, 'both ballot sets recorded (append-only)').to.equal(2);
        expect(Number(all[0].action_index)).to.equal(Number(ballotAIndex));
        expect(Number(all[1].action_index)).to.equal(Number(ballotBIndex));

        const current = await currentBallot(pollIndex);
        expect(current.length, 'one current ballot row').to.equal(1);
        expect(Number(current[0].choice), 'current ballot is the re-vote (NO)').to.equal(1);
        console.log('    [vote-reorg] poll #' + pollIndex + ' A=' + ballotAIndex + ' B=' + ballotBIndex + ' (block ' + ballotBBlock + ')');
    });

    it('orphaning the re-vote block restores the prior ballot as current', async function () {
        const node  = global.nodeConnector;
        const miner = global.regtestMinerConnector;

        await miner.pauseMining();
        try {
            const tipBefore = await node.getBlockCount();
            const bHash     = await node.getBlockHash(ballotBBlock);
            const payout    = (await cryptoHelper.getNewAddress('vote-reorg-miner', COIN, NETWORK, null, 'legacy', 0)).address;

            await node.invalidateBlock(bHash);
            expect(await node.getBlockCount(), 'node rolled back below ballot B').to.equal(ballotBBlock - 1);
            const need = tipBefore - (ballotBBlock - 1) + 2;
            for (let i = 0; i < need; i++) await node.generateBlock(payout, []);
            expect(await node.getBlockHash(ballotBBlock), 'the chain actually reorged').to.not.equal(bHash);

            // Wait for decoder -> indexer rollback to delete ballot B's set.
            const deadline = Date.now() + 180000;
            let bRows = -1;
            while (Date.now() < deadline) {
                await sleep(3000);
                bRows = (await idxQuery('SELECT COUNT(*) n FROM votes WHERE action_index = ?', [ballotBIndex]))[0].n;
                if (Number(bRows) === 0) break;
            }
            expect(Number(bRows), 'orphaned re-vote set removed by rollback').to.equal(0);

            // THE consensus assertion: ballot A survives and is current again.
            // Pre-fix (delete-then-insert) the table was EMPTY here: the voter's
            // standing ballot was unrecoverable and the reorged node's tally
            // diverged from a from-genesis replay.
            const aRows = await idxQuery('SELECT choice FROM votes WHERE action_index = ?', [ballotAIndex]);
            expect(aRows.length, 'prior ballot set survived the reorg').to.equal(1);
            const current = await currentBallot(pollIndex);
            expect(current.length, 'voter has a current ballot after the reorg').to.equal(1);
            expect(Number(current[0].action_index), 'the prior ballot is current again').to.equal(Number(ballotAIndex));
            expect(Number(current[0].choice), 'tally reverts to YES').to.equal(0);
            console.log('    [vote-reorg] rollback clean: ballot B gone, ballot A restored as current');
        } finally {
            await miner.resumeMining();
        }
    });

    it('the orphaned re-vote re-confirms from the mempool and becomes current again', async function () {
        // Auto-mining resumed; the orphaned re-vote tx is back in the mempool and
        // re-confirms on the new branch. A reorg must not change WHAT the standing
        // ballot is, only WHERE it confirmed. (The action counter rewinds with the
        // rollback, so the re-mined ballot may legitimately reuse the same
        // action_index; only the choice and the set count are semantic.)
        const deadline = Date.now() + 240000;
        let current = [];
        while (Date.now() < deadline) {
            await mine(1);
            await sleep(2000);
            current = await currentBallot(pollIndex);
            if (current.length === 1 && Number(current[0].choice) === 1) break;
        }
        expect(current.length, 'current ballot present after re-mine').to.equal(1);
        expect(Number(current[0].choice), 're-vote re-applied as the current ballot').to.equal(1);
        expect(Number(current[0].action_index), 'the re-vote (not ballot A) is the current set').to.be.greaterThan(Number(ballotAIndex));

        const all = await idxQuery('SELECT COUNT(*) n FROM votes WHERE poll_index = ?', [pollIndex]);
        expect(Number(all[0].n), 'exactly two ballot sets after re-mine (A + re-mined B)').to.equal(2);
        console.log('    [vote-reorg] re-vote re-confirmed as current (action_index ' + current[0].action_index + ')');
    });
});
