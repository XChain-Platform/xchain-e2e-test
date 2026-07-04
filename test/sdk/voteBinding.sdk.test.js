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
 * XChain Platform E2E - VOTE binding polls + contracts as poll actors (Phase 4,
 * Sections 14 + 16)
 *
 * Binding poll: VOTE v2 finalization fires a named contract method with the poll
 * result, turning a decided poll into an on-chain effect (mirrors ATTEST's
 * callback). The callback runs as the target contract and CANNOT read its own
 * poll via xchain.getPollResult yet (resolved_block == block), so the result is
 * delivered as positional params it reads with xchain.getInputParam.
 *
 *   1. CALLBACK_ON=pass fires the callback on a finalized win (contract records it)
 *   2. CALLBACK_ON=always fires the callback on a failed_quorum poll
 *   3. CALLBACK_ON=pass does NOT fire on a failed_quorum poll
 *   4. a contract creates a poll and casts a ballot as ITSELF (xchain.emit.vote)
 *
 ********************************************************************/

const { expect } = require('chai');
const { makeSdk, submit, fundedGasAddress, mine, uniqueTick, submitOpts } = require('./sdkHelper');

// Callback target: records the result the binding poll delivers.
const CALLBACK_TARGET = `
    module.exports = {
        initialize: function() { xchain.state.set('fired', '0'); },
        onPoll: function() {
            xchain.state.set('fired', '1');
            xchain.state.set('poll', xchain.getInputParam(0));
            xchain.state.set('status', xchain.getInputParam(1));
            xchain.state.set('winner', xchain.getInputParam(2));
            xchain.state.set('voters', xchain.getInputParam(4));
            return 'ok';
        }
    };
`;

// Poll actor: creates a poll and casts a ballot as the contract itself.
const ACTOR_CONTRACT = `
    module.exports = {
        initialize: function() {},
        makePoll: function() {
            xchain.emit.vote({ version: 0, tick: xchain.getInputParam(0),
                               endBlock: xchain.getInputParam(1), options: 'YES,NO' });
            return 'made';
        },
        castVote: function() {
            xchain.emit.vote({ version: 1, pollRef: xchain.getInputParam(0), ballot: '0' });
            return 'voted';
        }
    };
`;

function actionIndexOf(res) {
    const a = res && res.indexed && res.indexed.actions;
    if (!Array.isArray(a) || a.length === 0) throw new Error('no indexed actions');
    return a[0].action_index;
}

async function dbQuery(sql, params) {
    const connection = await global.indexerDatabase.getConnection();
    try { return await connection.query(sql, params); }
    finally { await connection.release(); }
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

async function readState(sdk, contractIndex, key) {
    const state = await sdk.getContractState(contractIndex, key);
    const rows = (state && state.data) || [];
    const row = rows.find(r => r.state_key === key);
    return row ? String(JSON.parse(row.state_value)) : null;
}

// After finalization the callback EXECUTE is injected in the same v2 block; give
// the indexer a moment (and nudge blocks) for the state write to land.
async function waitFired(sdk, contractIndex, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if ((await readState(sdk, contractIndex, 'fired')) === '1') return true;
        await mine(1);
        await new Promise(r => setTimeout(r, 1500));
    }
    return (await readState(sdk, contractIndex, 'fired')) === '1';
}

async function issueGov(sdk, issuer, mintSupply) {
    const tick = uniqueTick('BND');
    const res = await submit(sdk,
        { action: 'ISSUE', params: { tick, maxSupply: 10000000, maxMint: 100000, decimals: 0, description: 'binding', mintSupply } },
        { pubkey: issuer.address, change: issuer.address }, submitOpts({ wif: issuer.wif }));
    expect(res.indexed.status, 'ISSUE').to.equal('valid');
    return tick;
}

async function sendTick(sdk, issuer, tick, dest, amount) {
    const res = await submit(sdk,
        { action: 'SEND', params: { tick, amount, destination: dest } },
        { pubkey: issuer.address, change: issuer.address }, submitOpts({ wif: issuer.wif }));
    expect(res.indexed.status, 'SEND').to.equal('valid');
}

async function deploy(sdk, who, code) {
    const res = await submit(sdk,
        { action: 'DEPLOY', params: { code, gasLimit: 200000, constructorParams: 'initialize' } },
        { pubkey: who.address, change: who.address }, submitOpts({ wif: who.wif }));
    expect(res.indexed.status, 'DEPLOY').to.equal('valid');
    return actionIndexOf(res);
}

async function createPoll(sdk, issuer, params) {
    const res = await submit(sdk,
        { action: 'VOTE', params: Object.assign({ version: 0 }, params) },
        { pubkey: issuer.address, change: issuer.address }, submitOpts({ wif: issuer.wif }));
    expect(res.indexed.status, 'VOTE create').to.equal('valid');
    return actionIndexOf(res);
}

async function castBallot(sdk, voter, pollIndex, ballot) {
    const res = await submit(sdk,
        { action: 'VOTE', params: { version: 1, pollRef: pollIndex, ballot } },
        { pubkey: voter.address, change: voter.address }, submitOpts({ wif: voter.wif }));
    expect(res.indexed.status, 'ballot').to.equal('valid');
}

async function execute(sdk, who, contractIndex, method, params) {
    const res = await submit(sdk,
        { action: 'EXECUTE', params: { contractActionIndex: contractIndex, method, params } },
        { pubkey: who.address, change: who.address }, submitOpts({ wif: who.wif }));
    expect(res.indexed.status, 'EXECUTE ' + method).to.equal('valid');
    return res;
}

describe('[sdk] VOTE binding polls + contract actors', function () {
    this.timeout(0);

    let sdk, issuer, voterA, voterB;

    before(async function () {
        // compactAddresses off: the SDK's ^id destination compaction is ahead of the
        // indexer's wire acceptance (P4 arming / F3 gate open) and can invalidate the
        // setup SENDs; these suites test VOTE semantics, not address compaction.
        sdk = makeSdk({ compactAddresses: false });
        issuer = await fundedGasAddress(sdk, 0.05);
        voterA = await fundedGasAddress(sdk, 0.03);
        voterB = await fundedGasAddress(sdk, 0.03);
    });

    it('CALLBACK_ON=pass fires the callback on a finalized win', async function () {
        const target = await deploy(sdk, issuer, CALLBACK_TARGET);
        const tick = await issueGov(sdk, issuer, 1000);
        await sendTick(sdk, issuer, tick, voterA.address, 300);
        await sendTick(sdk, issuer, tick, voterB.address, 100);
        await mine(1);

        const endBlock = (await height()) + 8;
        const pollIndex = await createPoll(sdk, issuer, {
            tick, endBlock, options: 'YES,NO', maxSelections: 1, tallyMode: 'approval',
            weightMode: 'balance', question: 'Binding pass?',
            callbackContract: target, callbackMethod: 'onPoll', callbackOn: 'pass'
        });
        await castBallot(sdk, voterA, pollIndex, '1'); // NO 300
        await castBallot(sdk, voterB, pollIndex, '0'); // YES 100

        const poll = await waitFinalized(pollIndex);
        expect(poll.poll_status).to.equal('finalized');
        expect(await waitFired(sdk, target), 'callback fired').to.equal(true);
        expect(await readState(sdk, target, 'status'), 'cb status').to.equal('finalized');
        expect(await readState(sdk, target, 'winner'), 'cb winner (NO=1)').to.equal('1');
        expect(await readState(sdk, target, 'voters'), 'cb voters').to.equal('2');
        expect(String(poll.callback_execute_action_index), 'callback execute recorded').to.not.equal('null');
        console.log('    [sdk] binding poll #' + pollIndex + ' fired onPoll: winner=1 status=finalized');
    });

    it('CALLBACK_ON=always fires the callback on a failed_quorum poll', async function () {
        const target = await deploy(sdk, issuer, CALLBACK_TARGET);
        const tick = await issueGov(sdk, issuer, 1000);
        await sendTick(sdk, issuer, tick, voterA.address, 300);
        await mine(1);

        const endBlock = (await height()) + 8;
        const pollIndex = await createPoll(sdk, issuer, {
            tick, endBlock, options: 'YES,NO', maxSelections: 1, tallyMode: 'approval',
            weightMode: 'balance', minVoters: 5, question: 'Binding always',
            callbackContract: target, callbackMethod: 'onPoll', callbackOn: 'always'
        });
        await castBallot(sdk, voterA, pollIndex, '0');

        const poll = await waitFinalized(pollIndex);
        expect(poll.poll_status).to.equal('failed_quorum');
        expect(await waitFired(sdk, target), 'callback fired on fail').to.equal(true);
        expect(await readState(sdk, target, 'status'), 'cb status').to.equal('failed_quorum');
        expect(await readState(sdk, target, 'winner'), 'no winner').to.equal('');
        console.log('    [sdk] binding poll #' + pollIndex + ' (always) fired onPoll: status=failed_quorum');
    });

    it('CALLBACK_ON=pass does NOT fire on a failed_quorum poll', async function () {
        const target = await deploy(sdk, issuer, CALLBACK_TARGET);
        const tick = await issueGov(sdk, issuer, 1000);
        await sendTick(sdk, issuer, tick, voterA.address, 300);
        await mine(1);

        const endBlock = (await height()) + 8;
        const pollIndex = await createPoll(sdk, issuer, {
            tick, endBlock, options: 'YES,NO', maxSelections: 1, tallyMode: 'approval',
            weightMode: 'balance', minVoters: 5, question: 'Binding pass-fail',
            callbackContract: target, callbackMethod: 'onPoll', callbackOn: 'pass'
        });
        await castBallot(sdk, voterA, pollIndex, '0');

        const poll = await waitFinalized(pollIndex);
        expect(poll.poll_status).to.equal('failed_quorum');
        // Give the v2 block + a couple more time to confirm no callback fired.
        await mine(3);
        await new Promise(r => setTimeout(r, 3000));
        expect(await readState(sdk, target, 'fired'), 'callback did NOT fire').to.equal('0');
        expect(poll.callback_execute_action_index, 'no callback execute').to.be.null;
        console.log('    [sdk] binding poll #' + pollIndex + ' (pass) did not fire on failed_quorum');
    });

    it('a contract creates a poll and casts a ballot as itself (xchain.emit.vote)', async function () {
        const tick = await issueGov(sdk, issuer, 1000);
        const actor = await deploy(sdk, issuer, ACTOR_CONTRACT);
        // Fund the contract's custody so its hold-to-create / hold-to-vote gates pass.
        const dep = await submit(sdk,
            { action: 'DEPOSIT', params: { contractActionIndex: actor, tick, quantity: 500 } },
            { pubkey: issuer.address, change: issuer.address }, submitOpts({ wif: issuer.wif }));
        expect(dep.indexed.status, 'DEPOSIT').to.equal('valid');
        await mine(1);

        const endBlock = (await height()) + 30;
        await execute(sdk, issuer, actor, 'makePoll', [String(tick), String(endBlock)]);

        // The contract-created poll is the newest poll whose tick is this gov tick.
        const polls = await dbQuery(
            `SELECT p.action_index, a.source_id FROM polls p JOIN actions a ON a.action_index = p.action_index
               JOIN index_tickers t ON t.id = p.tick_id WHERE t.tick = ? ORDER BY p.action_index DESC LIMIT 1`, [tick]);
        expect(polls.length, 'contract poll row').to.equal(1);
        const pollIndex = Number(polls[0].action_index);

        // The poll's source address is the contract (C:<chain>:<actor>).
        const src = await dbQuery('SELECT address FROM index_addresses WHERE id = ?', [polls[0].source_id]);
        expect(String(src[0].address), 'poll source is the contract').to.match(new RegExp('^C:.*:' + actor + '$'));

        // The contract casts a ballot as itself.
        await execute(sdk, issuer, actor, 'castVote', [String(pollIndex)]);
        const votes = await dbQuery(
            `SELECT v.choice, ia.address FROM votes v JOIN index_addresses ia ON ia.id = v.voter_address_id
              WHERE v.poll_index = ?`, [pollIndex]);
        expect(votes.length, 'contract ballot row').to.be.greaterThan(0);
        expect(String(votes[0].address), 'ballot source is the contract').to.match(new RegExp('^C:.*:' + actor + '$'));
        console.log('    [sdk] contract ' + actor + ' created poll #' + pollIndex + ' and voted as itself');
    });
});
