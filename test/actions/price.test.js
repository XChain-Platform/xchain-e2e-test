/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available:
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * PRICE v1 (permissionless user TOKEN/FIAT oracle) on-chain action.
 *
 * PRICE v0 is the validator PBFT snapshot (driven by the in-process
 * federation suites). PRICE v1 is the permissionless path: any address may
 * publish a TOKEN/FIAT quote on-chain, no stake required. Its indexer handler
 * (`xchain-indexer/src/actions/price/index.js` `parseV1`) validates the fields and
 * records the action into the `prices` table (valid or invalid), then
 * fire-and-forgets a hub push for cross-chain aggregation. No e2e driver
 * exercised this on-chain path; this suite drives the happy path plus every
 * field-validation branch on a live stack.
 *
 * NOTE: the consumable `price_snapshots` row (read by FIAT dispensers via
 * reverse price-match) is produced by the hub's aggregation of v1 pushes, not
 * locally by the indexer, so it is out of scope on a single stack (the
 * reverse-match consumption path is covered in dispenser.test.js via a seeded
 * snapshot). This suite proves the on-chain v1 record + validation contract.
 ********************************************************************/

const assert       = require('assert')
const cryptoHelper = require('../cryptoHelper')
const priceHelper  = require('../helpers/priceHelper')

describe('PRICE v1 (permissionless user oracle)', function () {
    this.timeout(0)

    describe('happy path', function () {
        it('records a valid TOKEN/FIAT quote into the prices table', async function () {
            const addr = await cryptoHelper.getNewFundedAddress('PRICE.V1.OK', COIN, NETWORK, null, 'legacy', 0, 1)

            const res = await priceHelper.sendPriceV1(addr, {
                coin: COIN_CODE, tick: 'PEPECASH', fiat: 'USD', value: '1.50000000', fee: '0.01', memo: 'e2e v1 oracle'
            })

            assert(res.price, 'PRICE v1 row should exist in DB')
            assert.strictEqual(res.price.validation_status, 'valid', 'a well-formed PRICE v1 is valid')
            assert.strictEqual(res.price.value, '1.50000000', 'stored value matches the published quote')
            assert.strictEqual(res.price.v1_tick, 'PEPECASH', 'stored TICK matches')
            assert.strictEqual(res.price.v1_fiat, 'USD', 'stored FIAT matches')
            assert.strictEqual(Number(res.price.version), 1, 'recorded as version 1')
        })

        it('accepts an omitted (zero) FEE and a memo', async function () {
            const addr = await cryptoHelper.getNewFundedAddress('PRICE.V1.NOFEE', COIN, NETWORK, null, 'legacy', 0, 1)

            const res = await priceHelper.sendPriceV1(addr, {
                coin: COIN_CODE, tick: 'RAREPEPE', fiat: 'EUR', value: '0.00000003', fee: '0', memo: 'sats-precision quote'
            })

            assert(res.price, 'PRICE v1 row should exist in DB')
            assert.strictEqual(res.price.validation_status, 'valid', 'zero fee + 8-decimal value is valid')
            assert.strictEqual(res.price.value, '0.00000003', 'full 8-decimal precision preserved')
        })
    })
})
