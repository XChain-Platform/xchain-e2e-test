'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert       = require('assert');
const cryptoHelper = require('../../helpers/core/cryptoHelper');
const priceHelper  = require('../../helpers/priceHelper');
const { PRICE_V1_CASES } = require('./helpers/price_v1_cases');

function freshTick() {
    let tick = 'PVC';
    for (let i = 0; i < 6; i++) {
        tick += String.fromCharCode(65 + Math.floor(Math.random() * 26));
    }
    return tick;
}

// The indexer keeps the class ('valid' or 'invalid') in prices.validation_status and the
// reason ('invalid: VALUE (format)') in the joined index_statuses row, read back as `status`.
function validationClass(expect) {
    return expect === 'valid' ? 'valid' : 'invalid';
}

describe('PRICE v1 canonical decimal bound', function () {
    this.timeout(0);

    for (const testCase of PRICE_V1_CASES) {
        it(testCase.name + ' indexes ' + testCase.expect, async function () {
            const tick = freshTick();
            const oracle = await cryptoHelper.getNewFundedAddress(
                'price-canonical-' + tick, COIN, NETWORK, null, 'legacy', 0, 1
            );
            const result = await priceHelper.sendPriceV1(oracle, {
                coin: COIN_CODE,
                tick,
                fiat: 'USD',
                value: testCase.value,
                fee: testCase.fee,
                memo: 'canonical decimal bound'
            }, validationClass(testCase.expect));

            assert(result.price, 'PRICE v1 row should exist in the index');
            assert.strictEqual(result.price.validation_status, validationClass(testCase.expect));
            assert.strictEqual(result.price.status, testCase.expect);
        });
    }
});
