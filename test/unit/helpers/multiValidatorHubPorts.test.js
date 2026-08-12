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

// The L2 suites hard-code a basePort each, and several of those sit
// inside the kernel's EPHEMERAL range - the ports it hands to outbound sockets.
// A port there probes free and is taken a moment later by a hub dialling a peer
// or an axios call, and the next hub dies on `listen EADDRINUSE`. Solo runs pass;
// a long serial lane loses the lottery eventually, which is what happened to
// multiHubOracle at 33002 on 2026-08-09 the first time the whole tier ran
// as one lane.
//
// The rule is invisible in a green integration run, so it is pinned here rather
// than left to be re-learned from a flake.

const assert = require('assert')
const net    = require('net')
const { pickFreePorts, ephemeralRange } = require('../../helpers/multiValidatorHubHelper')

describe('MultiValidatorHub port allocation', function () {
    this.timeout(20000)

    const eph = ephemeralRange()

    it('reports an ephemeral range that is a sane interval', () => {
        assert.ok(Number.isInteger(eph.lo) && Number.isInteger(eph.hi))
        assert.ok(eph.lo < eph.hi && eph.lo > 1024 && eph.hi <= 65535)
    })

    it('never hands back a port inside the ephemeral range', async () => {
        // 33000 is multiHubOracle's declared base and is inside the range on
        // every Linux venue this tier runs on.
        for (const base of [33000, eph.lo, eph.hi - 3, 28000]) {
            const ports = await pickFreePorts(3, base)
            assert.strictEqual(ports.length, 3)
            for (const p of ports)
                assert.ok(p < eph.lo || p > eph.hi,
                    'base ' + base + ' produced ephemeral port ' + p)
        }
    })

    it('keeps a safe base as-is, so the suites that chose well are unaffected', async () => {
        const ports = await pickFreePorts(3, 26000)
        assert.ok(ports[0] >= 26000 && ports[0] < 26100, 'expected ports near the declared base, got ' + ports)
    })

    it('walks past a port that is genuinely occupied', async () => {
        const base = 26500
        const blocker = net.createServer()
        await new Promise(r => blocker.listen(base, '127.0.0.1', r))
        try {
            const ports = await pickFreePorts(2, base)
            assert.ok(!ports.includes(base), 'handed back the occupied port ' + base)
        } finally {
            await new Promise(r => blocker.close(r))
        }
    })

    it('returns distinct ports', async () => {
        const ports = await pickFreePorts(5, 33000)
        assert.strictEqual(new Set(ports).size, 5)
    })
})
