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

// The one part of the attestation reseeder that can be judged without a chain:
// which seated keys it may seed BESIDE and which it must refuse on.
//
// It is worth pinning because the failure is invisible in the direction that
// matters. A guard that accidentally admits an unaccounted seated key does not
// fail here; it fails forty minutes into an acceptance drill as a round that
// never finalized, and every earlier investigation in this spec went to the
// mirror rather than to the roster.

const assert = require('assert')

// LOADED WITHOUT ADOPTING ITS SUITE, and the mechanics matter.
//
// The tool file is a mocha spec: requiring it registers a suite that funds
// addresses and broadcasts stakes against a live venue, and the unit tier has no
// venue and no harness globals. So the BDD globals are stubbed for the length of
// the require, and the module is then dropped from the cache again, so that a
// broader run which also loads the tool as a spec still registers the real suite
// rather than getting a cached, suite-less copy of it.
function loadTool () {
    const toolPath = require.resolve('../../tools/reseedAttestationRoster.test.js')
    const saved = { describe: global.describe, it: global.it }
    global.describe = () => {}
    global.it = () => {}
    let mod
    try {
        mod = require(toolPath)
    } finally {
        global.describe = saved.describe
        global.it = saved.it
        delete require.cache[toolPath]
    }
    return mod
}

const { classifySeatedForReseed, ALLOW_PREFIX_MIN_HEX } = loadTool()

// The measured situation this hatch was built for, 2026-09-08: the re-genesised
// BTC regtest chain seats exactly this one attestation key, which is the standing
// xchain-node hub's own identity. Nothing in this harness derives its seed, and a
// venue hub running it beside the live one would equivocate and get the real
// validator slashed, so it can be neither adopted nor unstaked by this lane.
const STANDING_HUB_KEY = 'a20a4fa165f293a887b8294cf3cf16a4d5aef6e65434feb7438d0168e29dd250'
const DERIVABLE_KEY    = 'd04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737'
const STRANGER_KEY     = '7e3aa9d750d51883000000000000000000000000000000000000000000000000'

const known = (pubkeys) => new Map(pubkeys.map((p) => [p, { seedHex: '00'.repeat(32), origin: 'test seed' }]))

describe('reseedAttestationRoster: which seated keys a reseed may run beside', function () {

    it('calls an EMPTY set clean, which is the case that always worked', function () {
        const out = classifySeatedForReseed([], known([]), '')
        assert.deepStrictEqual(out.blocking, [])
        assert.deepStrictEqual(out.allowed, [])
        assert.deepStrictEqual(out.derivable, [])
    })

    it('REFUSES an unnamed seated key with no derivable seed, exactly as before the hatch', function () {
        const out = classifySeatedForReseed([STANDING_HUB_KEY], known([]), '')
        assert.deepStrictEqual(out.blocking, [STANDING_HUB_KEY],
            'a seated key nobody named and nobody can sign for must still block the reseed')
    })

    it('admits the same key once the operator NAMES it', function () {
        const out = classifySeatedForReseed([STANDING_HUB_KEY], known([]),
            STANDING_HUB_KEY.slice(0, 16))
        assert.deepStrictEqual(out.blocking, [])
        assert.deepStrictEqual(out.allowed, [STANDING_HUB_KEY])
        assert.deepStrictEqual(out.derivable, [])
    })

    it('names ONE key and not a class: a different key is still refused under the same allow-list', function () {
        // THE PROPERTY THE WHOLE HATCH RESTS ON. An allow-list that admitted the
        // set rather than the key would readmit the dilution fc52bcc banned, and
        // it would do it silently, on whatever stranger seated next.
        const out = classifySeatedForReseed([STANDING_HUB_KEY, STRANGER_KEY], known([]),
            STANDING_HUB_KEY.slice(0, 16))
        assert.deepStrictEqual(out.allowed, [STANDING_HUB_KEY])
        assert.deepStrictEqual(out.blocking, [STRANGER_KEY],
            'naming one key must not wave through the next one')
    })

    it('sorts a derivable seated key as derivable, not as blocking', function () {
        const out = classifySeatedForReseed([DERIVABLE_KEY, STANDING_HUB_KEY],
            known([DERIVABLE_KEY]), STANDING_HUB_KEY.slice(0, 16))
        assert.deepStrictEqual(out.derivable, [DERIVABLE_KEY])
        assert.deepStrictEqual(out.allowed, [STANDING_HUB_KEY])
        assert.deepStrictEqual(out.blocking, [])
    })

    it('takes several prefixes, comma-separated, with whitespace and case forgiven', function () {
        const out = classifySeatedForReseed([STANDING_HUB_KEY, STRANGER_KEY], known([]),
            '  ' + STANDING_HUB_KEY.slice(0, 20).toUpperCase() + ' , ' + STRANGER_KEY.slice(0, 16) + ' ,')
        assert.deepStrictEqual(out.blocking, [])
        assert.deepStrictEqual(out.allowed, [STANDING_HUB_KEY, STRANGER_KEY])
        assert.strictEqual(out.prefixes.length, 2, 'the trailing empty entry must be dropped, not refused')
    })

    it('matches on the full key as well as on a prefix', function () {
        const out = classifySeatedForReseed([STANDING_HUB_KEY], known([]), STANDING_HUB_KEY)
        assert.deepStrictEqual(out.blocking, [])
    })

    it('REFUSES a prefix shorter than the bound rather than letting it match a class', function () {
        assert.throws(() => classifySeatedForReseed([STANDING_HUB_KEY], known([]),
            STANDING_HUB_KEY.slice(0, ALLOW_PREFIX_MIN_HEX - 1)),
        (e) => {
            assert.ok(/is not a usable pubkey prefix/.test(e.message), e.message)
            assert.ok(new RegExp(ALLOW_PREFIX_MIN_HEX + ' to 64').test(e.message),
                'the refusal must state the bound it refused on, got: ' + e.message)
            return true
        })
    })

    it('REFUSES a non-hex or over-long prefix', function () {
        assert.throws(() => classifySeatedForReseed([], known([]), 'not-hexadecimal-at-all'),
            /is not a usable pubkey prefix/)
        assert.throws(() => classifySeatedForReseed([], known([]), 'a'.repeat(65)),
            /is not a usable pubkey prefix/)
    })

    it('does not match a prefix that merely appears inside the key', function () {
        // startsWith, never includes: a prefix is a position as well as a value,
        // and a substring match would name several keys from one operator typo.
        const out = classifySeatedForReseed([STANDING_HUB_KEY], known([]),
            STANDING_HUB_KEY.slice(8, 8 + ALLOW_PREFIX_MIN_HEX))
        assert.deepStrictEqual(out.blocking, [STANDING_HUB_KEY])
    })
})
