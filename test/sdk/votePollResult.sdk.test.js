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
 * XChain Platform E2E - contract reads a finalized VOTE poll (xchain.getPollResult)
 *
 * Proves the VM host function end to end on the live regtest stack: a poll is
 * created, voted, and finalized (VOTE v2), then a deployed contract calls
 * xchain.getPollResult(pollIndex) and persists the winner + status into its
 * own state. The indexer feeds the VM only polls finalized strictly before the
 * EXECUTE's block (db.getPollResultsForVM: resolved_block < block_index), so the
 * test mines past the finalization block before executing.
 *
 *   1. a contract reads the frozen winner/status of a finalized poll
 *   2. a poll not yet finalized reads back null (unseen)
 *
 ********************************************************************/

const { expect } = require('chai');
const { makeSdk, submit, fundedGasAddress, mine, uniqueTick, submitOpts } = require('./sdkHelper');

// Reads a finalized poll via the VM host function and stashes the result in
// contract state so the test can assert it through getContractState.
const POLL_READER_CONTRACT = `
    module.exports = {
        initialize: function() {
            xchain.state.set('status', 'none');
            xchain.state.set('winner', 'none');
            xchain.state.set('voters', 'none');
        },
        recordPoll: function() {
            var pollIndex = xchain.getInputParam(0);
            let r = xchain.getPollResult(pollIndex);
            if (r == null) {
                xchain.state.set('status', 'unseen');
                return 'unseen';
            }
            xchain.state.set('status', String(r.status));
            xchain.state.set('winner', r.winning_option == null ? 'none' : String(r.winning_option));
            xchain.state.set('voters', String(r.total_voters));
            return String(r.winning_option);
        }
    };
`;

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

// Poll the contract state until recordPoll has written a terminal status (the
// EXECUTE is indexed asynchronously after submit returns).
async function waitState(sdk, contractIndex, key, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    let v = null;
    while (Date.now() < deadline) {
        v = await readState(sdk, contractIndex, key);
        if (v !== null && v !== 'none') return v;
        await mine(1);
        await new Promise(r => setTimeout(r, 1500));
    }
    return v;
}

async function issueGov(sdk, issuer, mintSupply) {
    const tick = uniqueTick('PRD');
    const res = await submit(sdk,
        { action: 'ISSUE', params: { tick, maxSupply: 10000000, maxMint: 100000, decimals: 0, description: 'pollresult', mintSupply } },
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

async function createPoll(sdk, issuer, params) {
    const res = await submit(sdk,
        { action: 'VOTE', params: Object.assign({ version: 0 }, params) },
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

async function deployReader(sdk, deployer) {
    const res = await submit(sdk,
        { action: 'DEPLOY', params: { code: POLL_READER_CONTRACT, gasLimit: 200000, constructorParams: 'initialize' } },
        { pubkey: deployer.address, change: deployer.address },
        submitOpts({ wif: deployer.wif }));
    expect(res.indexed.status, 'DEPLOY status').to.equal('valid');
    return actionIndexOf(res);
}

async function execRecord(sdk, deployer, contractIndex, pollIndex) {
    const res = await submit(sdk,
        { action: 'EXECUTE', params: { contractActionIndex: contractIndex, method: 'recordPoll', params: [String(pollIndex)] } },
        { pubkey: deployer.address, change: deployer.address },
        submitOpts({ wif: deployer.wif }));
    expect(res.indexed.status, 'EXECUTE status').to.equal('valid');
}

describe('[sdk] contract reads a finalized VOTE poll', function () {
    this.timeout(0);

    let sdk, issuer, voterA, voterB;

    before(async function () {
        sdk = makeSdk();
        issuer = await fundedGasAddress(sdk, 0.05);
        voterA = await fundedGasAddress(sdk, 0.03);
        voterB = await fundedGasAddress(sdk, 0.03);
    });

    it('reads the frozen winner + status of a finalized poll', async function () {
        // GOV supply 1000: A=300, B=100, issuer keeps 600.
        const tick = await issueGov(sdk, issuer, 1000);
        await sendTick(sdk, issuer, tick, voterA.address, 300);
        await sendTick(sdk, issuer, tick, voterB.address, 100);
        await mine(1);

        const endBlock = (await height()) + 8;
        const pollIndex = await createPoll(sdk, issuer, {
            tick, endBlock, options: 'YES,NO', maxSelections: 1,
            tallyMode: 'approval', weightMode: 'balance', question: 'Contract-read winner?'
        });
        // A -> NO(1) weight 300; B -> YES(0) weight 100. NO (option 1) wins.
        await castBallot(sdk, voterA, pollIndex, '1');
        await castBallot(sdk, voterB, pollIndex, '0');

        const poll = await waitFinalized(pollIndex);
        expect(poll, 'poll row').to.not.be.null;
        expect(poll.poll_status, 'poll_status').to.equal('finalized');
        expect(Number(poll.winning_option), 'winning_option (NO)').to.equal(1);

        // Deploy the reader contract, then mine well past the finalization block
        // so the EXECUTE sees the poll (getPollResultsForVM: resolved_block < block).
        const contractIndex = await deployReader(sdk, issuer);
        await mine(3);
        await execRecord(sdk, issuer, contractIndex, pollIndex);

        const status = await waitState(sdk, contractIndex, 'status');
        const winner = await readState(sdk, contractIndex, 'winner');
        const voters = await readState(sdk, contractIndex, 'voters');
        expect(status, 'contract read status').to.equal('finalized');
        expect(winner, 'contract read winner (NO=1)').to.equal('1');
        expect(voters, 'contract read total_voters').to.equal('2');
        console.log('    [sdk] contract #' + contractIndex + ' read poll #' + pollIndex +
                    ': status=' + status + ' winner=' + winner + ' voters=' + voters);
    });

    it('reads null (unseen) for a poll that has not finalized', async function () {
        // A long-running poll that is still open: the contract must see null.
        const tick = await issueGov(sdk, issuer, 1000);
        await sendTick(sdk, issuer, tick, voterA.address, 300);
        await mine(1);

        const endBlock = (await height()) + 200; // far future, stays open
        const pollIndex = await createPoll(sdk, issuer, {
            tick, endBlock, options: 'YES,NO', maxSelections: 1,
            tallyMode: 'approval', weightMode: 'balance', question: 'Still open'
        });
        await castBallot(sdk, voterA, pollIndex, '0');

        const contractIndex = await deployReader(sdk, issuer);
        await mine(2);
        await execRecord(sdk, issuer, contractIndex, pollIndex);

        const status = await waitState(sdk, contractIndex, 'status');
        expect(status, 'open poll reads unseen').to.equal('unseen');
        console.log('    [sdk] contract #' + contractIndex + ' read open poll #' + pollIndex + ': ' + status);
    });
});
