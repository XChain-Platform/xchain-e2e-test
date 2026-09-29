'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert');
const proxyquire = require('proxyquire').noCallThru().noPreserveCache();
const { DETACH_STEPS } = require('../../helpers/bridge_detach_plan');

const DRIVER = '../../integration/bridge_rail_policy.test/11_at11_a_null_list_detaches_the_copy.test.js';

function fixtureOptions(overrides = {}) {
    return Object.assign({
        copy1: { params: { allow_list: '81', block_list: '82' } },
        policy1: { allow_list: ['doge-dest', 'doge-blocked'], block_list: ['doge-blocked'] },
        block2: null,
        rejectedWire: null,
    }, overrides);
}

function fakeVenue(options) {
    let parameterRead = 0;
    return {
        rewireHubs: async () => ({}),
        waitForRailSettled: async () => ({ invariant: 'settled' }),
        duplicateSourceTransfers: async () => [],
        indexerTails: () => '',
        tokenParameters: async () => {
            parameterRead += 1;
            if (parameterRead === 1) return options.copy1;
            return { params: { allow_list: options.copy1.params.allow_list, block_list: options.block2 } };
        },
    };
}

function fakeSupport(options, calls) {
    let policyRead = 0;
    const state = { policy: { ticks: [] }, evidence: {}, venue: fakeVenue(options) };
    return {
        assert,
        GAS_TICK: 'XCHAIN',
        state,
        issueHelper: { sendIssueV0Raw: () => 'ISSUE-0' },
        lockWireV3: () => 'LOCK-3',
        optInWire: () => 'ISSUE-7',
        btcAction: async (owner, wire) => {
            const payload = typeof wire === 'function' ? await wire() : wire;
            calls.push(payload);
            return { status: payload === options.rejectedWire ? 'invalid: refused' : 'valid' };
        },
        fundBtc: async () => ({ address: 'btc-issuer' }),
        fundDoge: async (label) => ({ address: label.endsWith('.DEST') ? 'doge-dest' : 'doge-blocked' }),
        pickFreeTick: async () => 'ABCDE',
        settleLeg: async () => ({ transfer: 'transfer-1' }),
        chainHalves: async () => ({ backed: 0, supply: 0 }),
        btcAddressList: async (owner, entries) => entries.length === 2 ? 81 : 82,
        copyPolicy: async () => {
            policyRead += 1;
            if (policyRead === 1) return options.policy1;
            return { allow_list: options.policy1.allow_list, block_list: null };
        },
        waitForFinalizedSeq: async (tick, seq) => ({ policy_seq: seq, snapshot_id: 'snapshot-' + seq }),
        waitForAppliedSeq: async (tick, seq, value) => ({ snapshotId: value.snapshotId }),
        sendCopy: async () => { calls.push('SEND'); return { status: 'valid' }; },
        needsFederation: () => false,
        bridgeRailSuite: () => {},
    };
}

function loadDriver(overrides) {
    const calls = [];
    const options = fixtureOptions(overrides);
    const support = fakeSupport(options, calls);
    const wires = { policyListsWire: (tick, allow, block) => 'ISSUE-5-' + allow + '-' + block };
    const driver = proxyquire(DRIVER, { '../../helpers/bridgeRailVenue': wires, './support': support });
    return { calls, driver, state: support.state };
}

async function expectCascade(fixture, failedIndex, failurePattern) {
    for (let index = 0; index < failedIndex; index += 1) {
        await fixture.driver.runDetachStep(DETACH_STEPS[index]);
    }
    await assert.rejects(
        () => fixture.driver.runDetachStep(DETACH_STEPS[failedIndex]),
        failurePattern
    );
    const callsBeforeDependent = fixture.calls.length;
    await assert.rejects(
        () => fixture.driver.runDetachStep(DETACH_STEPS[failedIndex + 1]),
        /must have run/
    );
    assert.deepStrictEqual(fixture.calls.slice(callsBeforeDependent), []);
}

describe('policy AT11 cascade guards', function () {
    it('does not bridge after the opt-in is refused', async function () {
        await expectCascade(loadDriver({ rejectedWire: 'ISSUE-7' }), 0, /ISSUE\|7.*graded invalid/);
    });

    it('does not detach after the first snapshot materializes no lists', async function () {
        const fixture = loadDriver({
            copy1: { params: { allow_list: null, block_list: null } },
            policy1: { allow_list: null, block_list: null },
        });
        await expectCascade(fixture, 2, /copy ALLOW_LIST is not/);
    });

    it('does not send after the block list remains attached', async function () {
        await expectCascade(loadDriver({ block2: '82' }), 4, /copy BLOCK_LIST did not detach/);
    });

    it('runs all six steps in order for a good fixture', async function () {
        const fixture = loadDriver();
        for (const step of DETACH_STEPS) await fixture.driver.runDetachStep(step);

        assert.strictEqual(fixture.state.evidence.at11_issue.tick, 'ABCDE');
        assert.strictEqual(fixture.state.evidence.at11_initial.snapshot, 'snapshot-1');
        assert.strictEqual(fixture.state.evidence.at11_detached.snapshot, 'snapshot-2');
        assert.strictEqual(fixture.state.evidence.at11_send.status, 'valid');
    });
});
