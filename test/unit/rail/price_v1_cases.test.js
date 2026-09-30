'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert');
const proxyquire = require('proxyquire');
const { PRICE_V1_CASES } = require('../../rail/flag_days/price_v1_cases');

const RAIL_SUITE = '../../rail/flag_days/price_v1_canonical.rail.test';

function loadRailSuite(resultFor) {
    const tests = [];
    const fundingCalls = [];
    const sendCalls = [];
    const savedDescribe = global.describe;
    const savedIt = global.it;
    const cryptoHelper = {
        getNewFundedAddress: async (...args) => {
            fundingCalls.push(args);
            return { address: 'oracle-' + fundingCalls.length };
        }
    };
    const priceHelper = {
        sendPriceV1: async (...args) => {
            sendCalls.push(args);
            return resultFor(...args);
        }
    };

    global.describe = (title, body) => body.call({ timeout() {} });
    global.it = (title, body) => tests.push({ title, body });
    try {
        proxyquire.noCallThru().noPreserveCache()(RAIL_SUITE, {
            '../../cryptoHelper': cryptoHelper,
            '../../helpers/priceHelper': priceHelper
        });
    } finally {
        global.describe = savedDescribe;
        global.it = savedIt;
    }
    return { tests, fundingCalls, sendCalls };
}

async function runRailTests(tests) {
    const saved = {
        COIN: global.COIN,
        NETWORK: global.NETWORK,
        COIN_CODE: global.COIN_CODE,
        random: Math.random
    };
    let randomIndex = 0;
    global.COIN = 'unit-coin';
    global.NETWORK = 'unit-network';
    global.COIN_CODE = 'UNIT';
    Math.random = () => ((randomIndex++ % 26) + 0.1) / 26;
    try {
        for (const test of tests) await test.body();
    } finally {
        global.COIN = saved.COIN;
        global.NETWORK = saved.NETWORK;
        global.COIN_CODE = saved.COIN_CODE;
        Math.random = saved.random;
    }
}

describe('PRICE v1 canonical-bound rail cases', function () {
    it('pins the ordered case list', function () {
        assert.deepStrictEqual(PRICE_V1_CASES, [
            { name: 'honest control', value: '1.5', fee: '0.01', expect: 'valid' },
            {
                name: 'leading-zero value',
                value: '01.5',
                fee: '0.01',
                expect: 'invalid: VALUE (format)'
            },
            {
                name: 'leading-zero fee',
                value: '1.5',
                fee: '00.01',
                expect: 'invalid: FEE (format)'
            }
        ]);
        assert.strictEqual(Object.isFrozen(PRICE_V1_CASES), true);
        assert.strictEqual(PRICE_V1_CASES.every(Object.isFrozen), true);
    });

    it('changes exactly one input by prepending one zero in each invalid case', function () {
        const control = PRICE_V1_CASES[0];
        for (const testCase of PRICE_V1_CASES.slice(1)) {
            const changed = ['value', 'fee'].filter(field => testCase[field] !== control[field]);
            assert.strictEqual(changed.length, 1, testCase.name + ' must change one input field');
            assert.strictEqual(testCase[changed[0]], '0' + control[changed[0]],
                testCase.name + ' must prepend exactly one zero');
        }
    });

    it('executes every rail case with a fresh oracle and the expected status', async function () {
        const harness = loadRailSuite((address, price, validationStatus) => ({
            price: {
                validation_status: validationStatus,
                status: PRICE_V1_CASES.find(testCase =>
                    testCase.value === price.value && testCase.fee === price.fee).expect
            }
        }));

        assert.deepStrictEqual(harness.tests.map(test => test.title), PRICE_V1_CASES.map(testCase =>
            testCase.name + ' indexes ' + testCase.expect));
        await runRailTests(harness.tests);

        assert.strictEqual(harness.fundingCalls.length, PRICE_V1_CASES.length);
        assert.strictEqual(harness.sendCalls.length, PRICE_V1_CASES.length);
        assert.strictEqual(new Set(harness.sendCalls.map(call => call[0].address)).size,
            PRICE_V1_CASES.length);
        assert.strictEqual(new Set(harness.sendCalls.map(call => call[1].tick)).size,
            PRICE_V1_CASES.length);
        for (let i = 0; i < PRICE_V1_CASES.length; i++) {
            const call = harness.sendCalls[i];
            assert.strictEqual(call[1].value, PRICE_V1_CASES[i].value);
            assert.strictEqual(call[1].fee, PRICE_V1_CASES[i].fee);
            assert.strictEqual(call[2], PRICE_V1_CASES[i].expect === 'valid' ? 'valid' : 'invalid');
        }
    });

    it('fails when the indexed PRICE row is absent', async function () {
        const harness = loadRailSuite(() => ({ price: null }));

        await assert.rejects(() => runRailTests([harness.tests[0]]),
            /PRICE v1 row should exist in the index/);
    });

    it('fails when the indexed validation status differs', async function () {
        const harness = loadRailSuite(() => ({ price: { validation_status: 'wrong status' } }));

        await assert.rejects(() => runRailTests([harness.tests[0]]), error => {
            assert.strictEqual(error.code, 'ERR_ASSERTION');
            assert.strictEqual(error.actual, 'wrong status');
            assert.strictEqual(error.expected, PRICE_V1_CASES[0].expect);
            return true;
        });
    });

    it('fails when the indexed refusal reason differs', async function () {
        const harness = loadRailSuite(() => ({
            price: { validation_status: 'invalid', status: 'invalid: FEE (format)' }
        }));

        await assert.rejects(() => runRailTests([harness.tests[1]]), error => {
            assert.strictEqual(error.code, 'ERR_ASSERTION');
            assert.strictEqual(error.actual, 'invalid: FEE (format)');
            assert.strictEqual(error.expected, PRICE_V1_CASES[1].expect);
            return true;
        });
    });
});
