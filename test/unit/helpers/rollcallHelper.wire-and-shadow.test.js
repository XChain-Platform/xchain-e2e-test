'use strict'
// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Two rollcallHelper facts that the acceptance suites cannot cover, because
// they skip on exactly the venues where these matter:
//
//   parseWire reads a published ROLLCALL by field name. The v0 and v1 layouts
//   differ by one field (GATES between PUBLISHER and SIG_COUNT), so a suite
//   indexing the split payload with v0 offsets read GATES as SIG_COUNT and the
//   count as the first pubkey on every gates-armed venue.
//
//   assertEpochsUnshadowed refuses epochs the DOGE side already holds rows for
//   above the BTC tip: rows from a pre-reset chain, which shadow a fresh
//   signature first-seen and either keep the epoch unrolled or ROLL it with a
//   bogus absence on a signing key (measured 2026-09-08 at epoch 4470).
//
// Unit-level on purpose: arithmetic over strings and one canned peer read.
const assert = require('assert')
const rc     = require('../../helpers/rollcallHelper')

const PK  = (n) => String(n).repeat(64).slice(0, 64)
const SIG = (n) => String(n).repeat(128).slice(0, 128)
const LEDGER = 'ab'.repeat(32)

describe('rollcallHelper.parseWire: the wire is read by field name, not position', function () {
    it('reads a v0 wire: PUBLISHER, SIG_COUNT and the pairs, no gates', function () {
        const w = ['ROLLCALL', '0', '4110', LEDGER, PK(1), '2', PK(1), SIG(1), PK(2), SIG(2)].join('|')
        const p = rc.parseWire(w)
        assert.strictEqual(p.version, 0)
        assert.strictEqual(p.epochHeight, 4110)
        assert.strictEqual(p.ledgerHash, LEDGER)
        assert.strictEqual(p.publisher, PK(1))
        assert.strictEqual(p.gates, null)
        assert.strictEqual(p.sigCount, 2)
        assert.deepStrictEqual(p.pairs.map(x => x.pubkey), [PK(1), PK(2)])
    })

    it('reads a v1 wire: GATES sits between PUBLISHER and SIG_COUNT and is not mistaken for the count', function () {
        const gates = 'a.B,c.D'
        const w = ['ROLLCALL', '1', '7620', LEDGER, PK(3), gates, '1', PK(3), SIG(3)].join('|')
        const p = rc.parseWire(w)
        assert.strictEqual(p.version, 1)
        assert.strictEqual(p.publisher, PK(3))
        assert.strictEqual(p.gates, gates)
        assert.strictEqual(p.sigCount, 1)
        assert.deepStrictEqual(p.pairs, [{ pubkey: PK(3), sig: SIG(3) }])
        // The v0 offsets, applied to this wire, are exactly the misreading this
        // helper replaces: position 5 is the gates list, position 6 the count.
        const positional = w.split('|')
        assert.notStrictEqual(Number(positional[5]), 1)
        assert.strictEqual(positional[5], gates)
    })

    it('refuses a wire whose SIG_COUNT disagrees with the pairs it carries', function () {
        const w = ['ROLLCALL', '0', '10', LEDGER, PK(1), '2', PK(1), SIG(1)].join('|')
        assert.throws(() => rc.parseWire(w), /declares SIG_COUNT 2 but carries 1 pair/)
    })

    it('refuses a payload that is not a ROLLCALL', function () {
        assert.throws(() => rc.parseWire('ATTEST|0|x'), /not a ROLLCALL wire/)
    })
})

describe('rollcallHelper.assertEpochsUnshadowed: epochs the DOGE side already holds rows for are refused', function () {
    // A ctx with the DOGE peer canned: `rows` maps epoch -> pubkeys with a row.
    function ctxWith(rows){
        return {
            network: 'regtest',
            roster: [{ pubkey: PK(1) }, { pubkey: PK(2) }, { pubkey: PK(3) }, { pubkey: PK(4) }],
            dogeRail: { globals: { indexerConnector: {
                call: async (method, params) => {
                    assert.strictEqual(method, 'getrollcallsigners')
                    const signers = {}
                    for (const k of (rows[params.epoch_height] || [])) signers[k] = { sig: SIG(9), ledger_hash: LEDGER }
                    return { signers }
                },
            } } },
        }
    }

    it('passes epochs with no rows and returns them unchanged', async function () {
        const out = await rc.assertEpochsUnshadowed(ctxWith({}), [100, 130, 160])
        assert.deepStrictEqual(out, [100, 130, 160])
    })

    it('fails loud naming every shadowed epoch and the keys it shadows', async function () {
        const ctx = ctxWith({ 130: [PK(1), PK(2), PK(3)], 160: [PK(2)] })
        await assert.rejects(() => rc.assertEpochsUnshadowed(ctx, [100, 130, 160]),
            (e) => /130 \(1{8},2{8},3{8}\)/.test(e.message) && /160 \(2{8}\)/.test(e.message) &&
                   /pre-reset chain/.test(e.message) && !/\b100\b/.test(e.message.split('epoch(s)')[1]))
    })

    it('ignores rows that carry no signature (an empty peer answer is not a shadow)', async function () {
        const ctx = ctxWith({})
        ctx.dogeRail.globals.indexerConnector.call = async () => ({ signers: { [PK(1)]: { sig: null } } })
        const out = await rc.assertEpochsUnshadowed(ctx, [100])
        assert.deepStrictEqual(out, [100])
    })
})
