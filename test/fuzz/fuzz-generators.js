'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

// Custom fast-check arbitraries for XChain fuzz testing.
// Provides domain-specific generators for filter objects, ACTION fields,
// connector inputs, and general fuzz values.

const fc = require('fast-check')

// ── Category A: Type Confusion Values ────────────────────────────

const typeConfusionArb = fc.oneof(
    fc.constant(null),
    fc.constant(undefined),
    fc.constant(NaN),
    fc.constant(Infinity),
    fc.constant(-Infinity),
    fc.constant(-0),
    fc.constant(true),
    fc.constant(false),
    fc.constant(0),
    fc.constant(-1),
    fc.constant(1),
    fc.constant(Number.MAX_SAFE_INTEGER),
    fc.constant(Number.MIN_SAFE_INTEGER),
    fc.constant(''),
    fc.constant(' '),
    fc.constant('null'),
    fc.constant('undefined'),
    fc.constant('NaN'),
    fc.constant('true'),
    fc.constant('false'),
    fc.constant('0'),
    fc.constant([]),
    fc.constant({}),
    fc.constant([null]),
    fc.constant([1, 2, 3]),
    fc.integer(),
    fc.double({ noNaN: false }),
    fc.string()
)

// ── Category B: String Mutation Values ───────────────────────────

const stringMutationArb = fc.oneof(
    fc.constant(''),
    fc.constant('A'.repeat(10000)),
    fc.constant('\x00\x01\x02\x03'),
    fc.constant('caf\u00e9\u2615\ud83d\udd25'),
    fc.constant("'; DROP TABLE issues; --"),
    fc.constant('${7*7}'),
    fc.constant('<script>alert(1)</script>'),
    fc.constant('../../../etc/passwd'),
    fc.constant('\r\n\r\nHTTP/1.1 200 OK\r\n'),
    fc.constant('http://evil.com@localhost:8333'),
    fc.constant('ISSUE|0|EVIL'),
    fc.constant('|||||'),
    fc.constant('\t\n\r'),
    fc.string({ minLength: 0, maxLength: 5000 }),
    fc.string({ minLength: 0, maxLength: 200 })
)

// ── Category C: Numeric Edge Values ──────────────────────────────

const numericEdgeArb = fc.oneof(
    fc.constant(0),
    fc.constant(-0),
    fc.constant(-1),
    fc.constant(1),
    fc.constant(0.1),
    fc.constant(0.000000001),
    fc.constant(Number.MAX_SAFE_INTEGER),
    fc.constant(Number.MAX_SAFE_INTEGER + 1),
    fc.constant(Number.MIN_SAFE_INTEGER),
    fc.constant(Number.MIN_SAFE_INTEGER - 1),
    fc.constant(Number.MAX_VALUE),
    fc.constant(Number.MIN_VALUE),
    fc.constant(Infinity),
    fc.constant(-Infinity),
    fc.constant(NaN),
    fc.integer(),
    fc.double({ noNaN: false })
)

// ── Any fuzz value (union of all categories) ─────────────────────

const anyFuzzValue = fc.oneof(
    typeConfusionArb,
    stringMutationArb,
    numericEdgeArb
)

// ── Filter field: either null (omitted) or a fuzz value ──────────

const filterFieldArb = fc.oneof(
    fc.constant(null),
    fc.constant(undefined),
    anyFuzzValue
)

// ── Database filter object generators ────────────────────────────

function filterObjectArb(fieldNames) {
    const entries = fieldNames.map(name =>
        filterFieldArb.map(value => [name, value])
    )
    return fc.tuple(...entries).map(pairs => Object.fromEntries(pairs))
}

const issueFilterArb = filterObjectArb([
    'source', 'tick', 'txHash', 'maxSupply', 'maxMint', 'decimals',
    'description', 'mintSupply', 'status'
])

const sendFilterArb = filterObjectArb([
    'source', 'destination', 'tick', 'amount', 'txHash', 'memo', 'status'
])

const creditFilterArb = filterObjectArb([
    'blockIndex', 'txHash', 'tick', 'address', 'amount'
])

const debitFilterArb = filterObjectArb([
    'blockIndex', 'txHash', 'tick', 'address', 'amount'
])

const mintFilterArb = filterObjectArb([
    'blockIndex', 'txHash', 'tick', 'destination', 'amount', 'memo', 'status'
])

const broadcastFilterArb = filterObjectArb([
    'blockIndex', 'txHash', 'source', 'message', 'value', 'fee', 'memo',
    'broadcastActionIndex', 'status'
])

const dispenserFilterArb = filterObjectArb([
    'blockIndex', 'txHash', 'source', 'giveCoin', 'giveTick', 'giveAmount',
    'giveEscrow', 'getCoin', 'getTick', 'getAmount', 'getAddress',
    'fiatCode', 'fiatAmount', 'expiration', 'allowList', 'blockList', 'memo', 'status'
])

const dispenseFilterArb = filterObjectArb([
    'blockIndex', 'txHash', 'source', 'giveCoin', 'giveTick', 'giveAmount',
    'getCoin', 'getTick', 'getAmount', 'destination', 'status'
])

const destroyFilterArb = filterObjectArb([
    'txHash', 'source', 'tick', 'amount', 'memo', 'status'
])

const messageFilterArb = filterObjectArb([
    'txHash', 'source', 'destination', 'plaintextMessage', 'status'
])

const fileFilterArb = filterObjectArb([
    'txHash', 'source', 'name', 'title', 'status'
])

const sleepFilterArb = filterObjectArb([
    'txHash', 'source', 'type', 'tick', 'resumeBlock', 'status'
])

const sweepFilterArb = filterObjectArb([
    'txHash', 'source', 'destination', 'balances', 'ownerships', 'orders', 'swaps', 'dispensers', 'status'
])

const dividendFilterArb = filterObjectArb([
    'txHash', 'source', 'tick', 'dividendTick', 'amount', 'status'
])

const callbackFilterArb = filterObjectArb([
    'txHash', 'source', 'tick', 'callbackTick', 'status'
])

const orderFilterArb = filterObjectArb([
    'txHash', 'source', 'giveCoin', 'giveTick', 'giveAmount', 'getCoin',
    'getTick', 'getAmount', 'getAddress', 'expiration', 'status', 'orderStatus'
])

const addressOptionFilterArb = filterObjectArb([
    'txHash', 'source', 'feePreference', 'requireMemo', 'status'
])

const listFilterArb = filterObjectArb([
    'blockIndex', 'txHash', 'source', 'type', 'edit', 'listActionIndex', 'status', 'items'
])

const airdropFilterArb = filterObjectArb([
    'blockIndex', 'txHash', 'source', 'tick', 'amount', 'listActionIndex', 'memo', 'status'
])

const dispenserStatusFilterArb = filterObjectArb([
    'dispenserActionIndex', 'status'
])

// ── ACTION field generators ──────────────────────────────────────

const actionFieldArb = fc.oneof(
    fc.constant(''),
    fc.constant(null),
    fc.constant(undefined),
    fc.constant(0),
    fc.constant(-1),
    fc.constant(NaN),
    fc.constant(true),
    fc.constant(false),
    fc.constant('|'),
    fc.constant('||'),
    fc.constant('ISSUE|0|NESTED'),
    fc.constant('\x00'),
    fc.constant('\n'),
    fc.string({ minLength: 0, maxLength: 200 }),
    fc.integer(),
    fc.double({ noNaN: false })
)

// ── Connector input generators ───────────────────────────────────

const hostArb = fc.oneof(
    fc.constant('localhost'),
    fc.constant(''),
    fc.constant('127.0.0.1'),
    fc.constant('::1'),
    fc.constant('[::1]'),
    fc.constant('http://evil.com'),
    fc.constant('host@user:pass'),
    fc.constant('../../../etc/passwd'),
    fc.constant('host with spaces'),
    fc.constant('\x00nullhost'),
    fc.string({ minLength: 0, maxLength: 500 })
)

const portArb = fc.oneof(
    fc.constant('8080'),
    fc.constant('0'),
    fc.constant('-1'),
    fc.constant('65536'),
    fc.constant(''),
    fc.constant('abc'),
    fc.constant('8080/path'),
    fc.constant(8080),
    fc.constant(0),
    fc.constant(NaN),
    fc.constant(null),
    fc.string({ minLength: 0, maxLength: 100 })
)

// ── Hub config generators ────────────────────────────────────────

const hubConfigArb = fc.oneof(
    fc.constant(null),
    fc.constant(undefined),
    fc.constant({}),
    fc.constant({ bitcoin: null }),
    fc.constant({ bitcoin: {} }),
    fc.constant({ bitcoin: { regtest: null } }),
    fc.constant({ bitcoin: { regtest: {} } }),
    fc.constant({ bitcoin: { regtest: { node: null } } }),
    fc.constant({ bitcoin: { regtest: { node: {} } } }),
    fc.constant({
        bitcoin: {
            regtest: {
                node: { host: 'h', server_port: 1, user: 'u', pass: 'p' },
                database: { host: 'h', port: 2 },
                'xchain-utxo-tracker': { host: 'h', server_port: 3 },
                'xchain-encoder': { host: 'h', server_port: 4 },
                'xchain-indexer': { host: 'h', server_port: 5, name: 'n', user: 'u', pass: 'p' },
                'xchain-regtest-miner': { host: 'h', server_port: 6 }
            }
        }
    }),
    fc.anything()
)

module.exports = {
    typeConfusionArb,
    stringMutationArb,
    numericEdgeArb,
    anyFuzzValue,
    filterFieldArb,
    filterObjectArb,
    actionFieldArb,
    hostArb,
    portArb,
    hubConfigArb,
    // Named filter arbs
    issueFilterArb,
    sendFilterArb,
    creditFilterArb,
    debitFilterArb,
    mintFilterArb,
    broadcastFilterArb,
    dispenserFilterArb,
    dispenseFilterArb,
    destroyFilterArb,
    messageFilterArb,
    fileFilterArb,
    sleepFilterArb,
    sweepFilterArb,
    dividendFilterArb,
    callbackFilterArb,
    orderFilterArb,
    addressOptionFilterArb,
    listFilterArb,
    airdropFilterArb,
    dispenserStatusFilterArb,
}
