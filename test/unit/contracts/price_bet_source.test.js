'use strict'

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { PRICE_BET } = require('../../contracts/sources/price_bet_source')

describe('Price Bet: inline copy matches the canonical template', function () {
    const CANONICAL = path.join(__dirname, '..', '..', '..', '..',
        'xchain-contracts', 'priceBet', 'priceBet.js')

    function requireMessages(source) {
        const out = new Set()
        const calls = source.match(/xchain\.require\(([\s\S]*?)\);/g) || []
        for (const call of calls) {
            const literals = call.match(/'((?:[^'\\]|\\.)*)'/g) || []
            for (const lit of literals) out.add(lit.slice(1, -1))
        }
        return out
    }

    let canonicalSource = null
    before(function () {
        try { canonicalSource = fs.readFileSync(CANONICAL, 'utf8') }
        catch (e) {
            console.log('Skipping priceBet template parity: xchain-contracts not mounted at ' + CANONICAL)
        }
    })

    it('carries every guard message the canonical template can throw', function () {
        if (canonicalSource === null) return this.skip()
        const missing = [...requireMessages(canonicalSource)].filter(m => !PRICE_BET.includes(m))
        assert.deepStrictEqual(missing, [],
            'inline priceBet copy is missing canonical guard(s): ' + JSON.stringify(missing) +
            ' - re-compact PRICE_BET from ' + CANONICAL)
    })

    it('carries the accept() betting-window guard specifically', function () {
        assert.ok(PRICE_BET.includes('settle round already published'),
            'accept() must reject a taker once the settle round is public')
    })

    it('fits the combined compiled payload cap for the suite deploy', function () {
        const params = [
            'a'.repeat(35), 'BT123/USD', '60000', 'OVER', 'XCHAIN', '100', '7', '50'
        ].join('|')
        const codeB64 = Buffer.from(PRICE_BET, 'utf8').toString('base64')
        const msg = 'DEPLOY|0|' + codeB64 + '|1000000|' + params

        assert.ok(Buffer.byteLength(msg, 'utf8') + 3 <= 8192,
            'combined compiled payload exceeds 8192 bytes')
    })
})
