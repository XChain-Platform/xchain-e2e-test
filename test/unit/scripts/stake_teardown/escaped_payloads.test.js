'use strict'

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert')
const gate = require('../../../../bin/check-stake-teardown')

const scanPayload = (payload) => gate.scanLines([
    `await transactionHelper.createAndSendTransaction(tx, ${payload})`,
], 'test/actions/escaped_payload.test.js')

describe('check-stake-teardown gate: escaped payloads', () => {
    it('catches cooked STAKE escapes in quoted and template payloads', () => {
        for (const payload of [
            "'ST\\x41KE|1|1000|' + pk",
            '`ST\\x41KE|1|1000|${pk}`',
            "'\\u0053TAKE|1|1000|' + pk",
            '`ST\\u{41}KE|1|1000|${pk}`',
        ]) {
            assert.deepStrictEqual(scanPayload(payload).map((hit) => hit.line), [1], payload)
        }
    })

    it('leaves cooked non-stake payloads clean', () => {
        for (const payload of [
            "'UNST\\x41KE|1|' + pk",
            '`UNST\\x41KE|1|${pk}`',
            '`SEND|1|${amount}\\n`',
        ]) assert.strictEqual(scanPayload(payload).length, 0, payload)
    })

    it('counts a template line continuation before a later payload', () => {
        const source = [
            'const harmless = `SEND|1|' + '\\',
            'continued`',
            'const msg = `ST\\x41KE|1|${amount}|${pk}`',
        ].join('\n')
        const hits = gate.scanLines(source.split('\n'), 'test/actions/escaped_payload.test.js')
        assert.deepStrictEqual(hits.map((hit) => hit.line), [3])
    })
})
