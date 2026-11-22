'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const gate = require('../../../../bin/check-stake-teardown')

const scan = (source) => gate.scanLines(source.split('\n'), 'test/actions/interpolation.test.js')
const REGISTER = 'stakeTeardown.bookBroadcastStake({ addressInfo, signingPubkey })'

describe('check-stake-teardown template interpolation code', function () {
    it('finds a broadcast inside an interpolation at its absolute line', function () {
        const oneLine = scan('const s = `${await tx.createAndSendTransaction(addr, "STAKE|1|1000|" + pk)}`')
        const multiLine = scan([
            'const s = `${',
            '  await prepare()',
            '  await tx.createAndSendTransaction(addr, "STAKE|1|1000|" + pk)',
            '}`',
        ].join('\n'))

        assert.deepStrictEqual(oneLine.map((hit) => hit.line), [1])
        assert.deepStrictEqual(multiLine.map((hit) => hit.line), [3])
    })

    it('honors an opt-out and a release registration across streams', function () {
        const marked = scan([
            '// stake-teardown-ok: rejected by the zero amount rule',
            'const s = `${await tx.createAndSendTransaction(addr, "STAKE|1|0|" + pk)}`',
        ].join('\n'))
        const registered = scan([
            'const s = `${await tx.createAndSendTransaction(addr, "STAKE|1|1000|" + pk)}`',
            REGISTER,
        ].join('\n'))

        assert.deepStrictEqual(marked, [])
        assert.deepStrictEqual(registered, [])
    })

    it('resolves outer bindings and de-duplicates their payload origin', function () {
        const stake = scan([
            'const msg = "STAKE|1|" + pk',
            'const s = `${await tx.createAndSendTransaction(addr, msg)}`',
        ].join('\n'))
        const nonStake = scan([
            'const wire = issueCmd(x)',
            'const s = `${await tx.createAndSendTransaction(addr, wire)}`',
        ].join('\n'))

        assert.deepStrictEqual(stake.map((hit) => hit.line), [1])
        assert.deepStrictEqual(nonStake, [])
    })

    it('recurses into nested templates without flagging unrelated code', function () {
        const stake = scan('const s = `${`${await tx.createAndSendTransaction(addr, "STAKE|1|1|" + pk)}`}`')
        const unstake = scan('const s = `${await tx.createAndSendTransaction(addr, "UNSTAKE|1|" + pk)}`')
        const comparison = scan('const s = `${tx.action === "STAKE"}`')

        assert.deepStrictEqual(stake.map((hit) => hit.line), [1])
        assert.deepStrictEqual(unstake, [])
        assert.deepStrictEqual(comparison, [])
    })

    it('finds an SDK action object inside an interpolation', function () {
        const hits = scan('const s = `${JSON.stringify({ action: "STAKE", params })}`')

        assert.deepStrictEqual(hits.map((hit) => hit.line), [1])
    })
})

describe('check-stake-teardown interpolation binding scope', function () {
    it('keeps an interpolation-local binding out of the enclosing scope', function () {
        const local = 'const s = `${(() => { const wire = issueCmd(x); return wire })()}`'
        const outerBroadcast = ['const wire = buildMaybeStake()', 'await tx.createAndSendTransaction(addr, wire)']
        const before = scan([local, ...outerBroadcast].join('\n'))
        const after = scan([...outerBroadcast, local].join('\n'))
        const shadowed = scan([
            'const wire = issueCmd(x)',
            'const s = `${await (async () => {',
            '  const wire = "STAKE|1|" + pk',
            '  return tx.createAndSendTransaction(addr, wire)',
            '})()}`',
        ].join('\n'))

        assert.deepStrictEqual(before.map((hit) => hit.line), [2])
        assert.deepStrictEqual(after.map((hit) => hit.line), [1])
        assert.deepStrictEqual(shadowed.map((hit) => hit.line), [3])
    })
})
