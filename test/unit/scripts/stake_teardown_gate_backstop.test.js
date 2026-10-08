'use strict'

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
 ********************************************************************/

const assert = require('assert')
const gate = require('../../../scripts/check-stake-teardown')

const scanPayload = (payload) => gate.scanLines([
    `await transactionHelper.createAndSendTransaction(tx, ${payload})`,
], 'test/actions/opaque_payload.test.js')

describe('check-stake-teardown gate: opaque transaction payload backstop', () => {
    const opaquePayloads = [
        'payload',
        'context.payload',
        'payloads[index]',
        'usePrimary ? primaryPayload : fallbackPayload',
        'primaryPayload || fallbackPayload',
    ]

    for (const payload of opaquePayloads){
        it(`flags unresolved payload expression: ${payload}`, () => {
            const hits = scanPayload(payload)
            assert.strictEqual(hits.length, 1)
            assert.strictEqual(hits[0].line, 1)
        })
    }

    it('accepts a payload demonstrably built by stakeHelper', () => {
        assert.strictEqual(scanPayload('stakeHelper.sendStakeV1(tx, amount, pubkey)').length, 0)
    })

    it('accepts a bound payload demonstrably built by stakeHelper', () => {
        const hits = gate.scanLines([
            'const payload = stakeHelper.sendStakeV2(tx, amount, pubkey)',
            'await transactionHelper.createAndSendTransaction(tx, payload)',
        ], 'test/actions/helper_payload.test.js')
        assert.strictEqual(hits.length, 0)
    })
})
