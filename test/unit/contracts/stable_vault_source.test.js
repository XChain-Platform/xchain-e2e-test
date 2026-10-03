'use strict'

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert')
const { STABLE_VAULT } = require('../../contracts/sources/stable_vault_source')

describe('Stable Vault source', function () {
    const COLL = 'XCHAIN'
    const STABLE = 'DUSCV'
    const PAIR = 'XC123/USD'
    const RATIO = '150'
    const BONUS = '20'
    const MAXAGE = '100000'
    const params = [COLL, STABLE, PAIR, RATIO, BONUS, MAXAGE]

    it('initializes with one representable ISSUE emission', function () {
        const contractModule = { exports: {} }
        Function('module', 'exports', STABLE_VAULT)(contractModule, contractModule.exports)

        const stateValues = new Map()
        const emissions = []
        const x = {
            getInputParam: index => params[index],
            require: (condition, message) => {
                if (!condition) throw new Error(message)
            },
            math: {
                gt: (left, right) => Number(left) > Number(right),
                gte: (left, right) => Number(left) >= Number(right)
            },
            state: {
                get: key => stateValues.get(key),
                set: (key, value) => stateValues.set(key, value)
            },
            emit: {
                issue: payload => emissions.push({ method: 'issue', payload })
            }
        }

        contractModule.exports.initialize(x)

        assert.deepStrictEqual(emissions, [{
            method: 'issue',
            payload: { tick: STABLE, decimals: '0', maxSupply: '1000000000' }
        }])
        assert.match(emissions[0].payload.maxSupply, /^[0-9]+$/)
    })

    it('fits the deploy message limit with the suite parameters', function () {
        const codeB64 = Buffer.from(STABLE_VAULT, 'utf8').toString('base64')
        const msg = 'DEPLOY|0|' + codeB64 + '|1000000|' + params.join('|')

        assert.ok(Buffer.byteLength(msg, 'utf8') + 3 <= 8192,
            'combined compiled payload exceeds 8192 bytes')
    })
})
