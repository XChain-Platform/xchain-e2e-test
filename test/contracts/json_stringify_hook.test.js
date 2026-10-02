// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')
const gasHelper = require('../helpers/gasHelper')
const vmHelper = require('../helpers/vmHelper')

const HOOK_EXPECT = process.env.XC_JSON_STRINGIFY_HOOK_EXPECT || 'armed'
if (HOOK_EXPECT !== 'armed' && HOOK_EXPECT !== 'inert') {
    throw new Error('XC_JSON_STRINGIFY_HOOK_EXPECT must be "armed" or "inert"')
}

const JSON_STRINGIFY_HOOK = `module.exports = {
    meta: { name: 'JSON Stringify Hook', description: 'Exercises JSON serialization depth handling.', version: '1.0.0' },
    shallowHook: function (xchain) {
        var value = { toJSON: function () { return { a: 1 }; } };
        xchain.state.set('shallowHook', JSON.stringify(value));
    },
    hookSpine: function () {
        var spine = buildSpine();
        return JSON.stringify({ toJSON: function () { return spine; } });
    },
    replacerSpine: function () {
        var spine = buildSpine();
        var shallow = { x: 1 };
        return JSON.stringify(shallow, function (key, value) {
            return key === 'x' ? spine : value;
        });
    },
    directSpine: function () {
        return JSON.stringify(buildSpine());
    }
};
function buildSpine() {
    var spine = [];
    // 256 is xchain-vm MAX_STACK_DEPTH_MUSL; the loop builds one level past it
    // without recursion.
    for (var i = 0; i < 256; i++) spine = [spine];
    return spine;
}`

let operator = null
let contractIndex = null

async function executeExpectedFailure(method) {
    const result = await vmHelper.sendExecuteV0Invalid(operator, contractIndex, method, [])
    assert(result.execution, method + ' must leave an execution row')
    return result.execution
}

function assertOutOfStack(execution, method) {
    assert.notStrictEqual(execution.status, 'valid', method + ' must not land valid')
    assert.match(String(execution.error_message || ''), /out_of_stack/,
        method + ' must carry the out_of_stack fault')
}

function assertHookExpectation(execution, method) {
    if (HOOK_EXPECT === 'armed') {
        assertOutOfStack(execution, method)
    } else {
        assert.strictEqual(execution.status, 'valid', method + ' must keep the legacy valid outcome')
    }
}

describe('JSON.stringify value-hook depth gate', function () {
    before(async function () {
        operator = await cryptoHelper.getNewFundedAddress(
            'json-stringify-hook', COIN, NETWORK, null, 'legacy', 0, 1
        )
        await gasHelper.ensureGasBalance(operator, '5000')
        const deploy = await vmHelper.sendDeployV0(operator, JSON_STRINGIFY_HOOK, 1000000)
        contractIndex = deploy.contract.action_index
    })

    it('keeps a shallow toJSON hook valid and stores its replacement value', async function () {
        const result = await vmHelper.sendExecuteV0(operator, contractIndex, 'shallowHook', [])
        assert(result.execution, 'shallowHook must leave an execution row')
        assert.strictEqual(result.execution.status, 'valid', 'shallowHook must land valid')

        const state = await indexerDatabase.getContractState(contractIndex, 'shallowHook')
        assert(state, 'shallowHook must store its serialized replacement')
        assert.strictEqual(JSON.parse(state.state_value), '{"a":1}')
    })

    it('keeps the direct spine as the native-depth control', async function () {
        const execution = await executeExpectedFailure('directSpine')
        assertOutOfStack(execution, 'directSpine')
    })

    it('applies the configured expectation to a toJSON-produced spine', async function () {
        const execution = await executeExpectedFailure('hookSpine')
        assertHookExpectation(execution, 'hookSpine')
    })

    it('applies the configured expectation to a replacer-produced spine', async function () {
        const execution = await executeExpectedFailure('replacerSpine')
        assertHookExpectation(execution, 'replacerSpine')
    })
})
