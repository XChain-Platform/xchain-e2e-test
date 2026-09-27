'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert');
const proxyquire = require('proxyquire');
const { DETACH_STEPS } = require('../../helpers/bridge_detach_plan');

function fakeVenue(calls, detachedBlock = null) {
    let copyRead = 0;
    return {
        rewireHubs: async () => { calls.push(['rewire']); return { BRIDGE_POLICY_DETACH: '0' }; },
        waitForRailSettled: async () => ({ invariant: 'settled' }),
        duplicateSourceTransfers: async () => [],
        indexerTails: () => '',
        tokenParameters: async () => {
            copyRead += 1;
            if (copyRead === 1) return { params: { allow_list: '81', block_list: '82' } };
            return { params: { allow_list: '81', block_list: detachedBlock } };
        }
    };
}

function fakeSupport(calls, detachedBlock) {
    const state = { policy: { ticks: [] }, evidence: {}, venue: fakeVenue(calls, detachedBlock) };
    let listIndex = 80;
    let policyRead = 0;
    const support = {
        assert,
        GAS_TICK: 'XCHAIN',
        state,
        issueHelper: { sendIssueV0Raw: () => 'ISSUE|0|ABCDE' },
        lockWireV3: () => 'XBRIDGE|3|ABCDE',
        optInWire: () => 'ISSUE|7|ABCDE',
        btcAction: async (owner, wire, table) => {
            calls.push(['btc', table, typeof wire === 'function' ? await wire() : wire]);
            return { status: 'valid' };
        },
        fundBtc: async () => ({ address: 'btc-issuer' }),
        fundDoge: async (label) => ({ address: label.endsWith('.DEST') ? 'doge-dest' : 'doge-blocked' }),
        pickFreeTick: async (candidates) => { calls.push(['candidates', candidates.length]); return 'ABCDE'; },
        settleLeg: async () => ({ transfer: 'transfer-1' }),
        chainHalves: async () => ({ backed: 0, supply: 0 }),
        btcAddressList: async () => ++listIndex,
        copyPolicy: async () => {
            policyRead += 1;
            return policyRead === 1
                ? { allow_list: ['doge-dest', 'doge-blocked'], block_list: ['doge-blocked'] }
                : { allow_list: ['doge-dest', 'doge-blocked'], block_list: null };
        },
        waitForFinalizedSeq: async (tick, seq) => ({ policy_seq: seq, snapshot_id: 'snapshot-' + seq }),
        waitForAppliedSeq: async (tick, seq, opts) => {
            calls.push(['applied', seq, opts.snapshotId]);
            return { snapshotId: opts.snapshotId };
        },
        sendCopy: async (from, tick, amount, destination) => {
            calls.push(['send', tick, amount, destination]);
            return { status: 'valid' };
        },
        needsFederation: () => false,
        bridgeRailSuite: () => {},
    };
    return { state, support };
}

function loadDriver(detachedBlock) {
    const calls = [];
    const fixture = fakeSupport(calls, detachedBlock);
    const wires = {
        policyListsWire: (tick, allow, block) => {
            calls.push(['policy-wire', tick, allow, block]);
            return ['ISSUE', '5', tick, allow || '', block || ''].join('|');
        }
    };
    const driver = proxyquire.noCallThru().noPreserveCache()(
        '../../integration/bridge_rail_policy.test/11_at11_a_null_list_detaches_the_copy.test.js',
        { '../../helpers/bridgeRailVenue': wires, './support': fixture.support }
    );
    return { calls, driver, state: fixture.state };
}

describe('bridged list detach plan', function () {
    it('pins the ordered steps and expected copy states', function () {
        assert.deepStrictEqual(DETACH_STEPS, [
            {
                name: 'issue a BTC tick with allow and block lists',
                action: 'issue_btc_tick_with_lists',
                expect: null
            },
            {
                name: 'bridge the tick to DOGE',
                action: 'bridge_btc_tick_to_doge',
                expect: null
            },
            {
                name: 'settle the first policy snapshot',
                action: 'wait_for_initial_snapshot',
                expect: { ALLOW_LIST: 'nonzero', BLOCK_LIST: 'nonzero' }
            },
            {
                name: 'detach the origin block list',
                action: 'detach_origin_block_list',
                expect: null,
                issueFormat: 5,
                sentinel: '0'
            },
            {
                name: 'settle the block-list-zero snapshot',
                action: 'wait_for_detached_snapshot',
                expect: { ALLOW_LIST: 'unchanged', BLOCK_LIST: 0 }
            },
            {
                name: 'send the copy to the formerly blocked address',
                action: 'send_to_formerly_blocked',
                expect: { status: 'valid' }
            }
        ]);
    });

    it('orders detach before the zero snapshot and the unblocked send', function () {
        const actions = DETACH_STEPS.map(step => step.action);
        const detach = actions.indexOf('detach_origin_block_list');
        const zeroSnapshot = actions.indexOf('wait_for_detached_snapshot');
        const unblockedSend = actions.indexOf('send_to_formerly_blocked');

        assert(detach < zeroSnapshot, 'detach must precede the block-list-zero snapshot');
        assert(zeroSnapshot < unblockedSend,
            'the block-list-zero snapshot must precede the unblocked send');
    });

    it('freezes the list, entries, and non-null expectations', function () {
        assert(Object.isFrozen(DETACH_STEPS));
        assert(DETACH_STEPS.every(Object.isFrozen));
        assert(DETACH_STEPS.filter(step => step.expect !== null)
            .every(step => Object.isFrozen(step.expect)));
    });

    it('executes every planned rail action and checks the detach result', async function () {
        const fixture = loadDriver();
        for (const step of DETACH_STEPS) await fixture.driver.runDetachStep(step);

        assert.deepStrictEqual(fixture.calls.filter(call => call[0] === 'policy-wire'), [
            ['policy-wire', 'ABCDE', 81, 82],
            ['policy-wire', 'ABCDE', null, '0']
        ]);
        assert.deepStrictEqual(fixture.calls.filter(call => call[0] === 'applied'), [
            ['applied', 1, 'snapshot-1'],
            ['applied', 2, 'snapshot-2']
        ]);
        assert.deepStrictEqual(fixture.calls.filter(call => call[0] === 'send'), [
            ['send', 'ABCDE', 1, 'doge-blocked']
        ]);
        assert.deepStrictEqual(fixture.calls.filter(call => call[0] === 'rewire'), [['rewire']]);
        assert.deepStrictEqual(fixture.calls.filter(call => call[0] === 'candidates'), [['candidates', 16]]);
        assert.deepStrictEqual(fixture.state.policy.ticks, ['ABCDE']);
        assert.strictEqual(fixture.state.evidence.at11_detached.ALLOW_LIST, '81');
        assert.strictEqual(fixture.state.evidence.at11_detached.BLOCK_LIST, 0);
        assert.strictEqual(fixture.state.evidence.at11_send.status, 'valid');
    });

    it('fails when the destination keeps the detached block list', async function () {
        const fixture = loadDriver('82');
        for (const step of DETACH_STEPS.slice(0, 4)) await fixture.driver.runDetachStep(step);
        await assert.rejects(
            () => fixture.driver.runDetachStep(DETACH_STEPS[4]),
            /the copy BLOCK_LIST did not detach/
        );
    });
});
