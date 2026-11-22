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

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { hubNodePort } = require('../../helpers/hub_node_port')

describe('hubNodePort', () => {
    it('lets an explicit NODE_PORT win over the hub port', () => {
        assert.strictEqual(hubNodePort('28443', 18443), '28443')
    })

    it('trims the env value', () => {
        assert.strictEqual(hubNodePort(' 28443 ', 18443), '28443')
    })

    it('falls back to the hub port when NODE_PORT is unset', () => {
        assert.strictEqual(hubNodePort(undefined, 18443), 18443)
        assert.strictEqual(hubNodePort(null, 18443), 18443)
    })

    it('falls back to the hub port when NODE_PORT is blank', () => {
        assert.strictEqual(hubNodePort('', 18443), 18443)
        assert.strictEqual(hubNodePort('   ', 18443), 18443)
    })

    it('returns the hub port unchanged, whatever its type', () => {
        assert.strictEqual(hubNodePort(undefined, '18443'), '18443')
        assert.strictEqual(hubNodePort(undefined, undefined), undefined)
    })

    it('is what initial_check uses for the node port after the hub answers', () => {
        const src = fs.readFileSync(path.join(__dirname, '../../initial_check.test.js'), 'utf8')
        assert.match(src, /require\(['"]\.\/helpers\/hub_node_port(\.js)?['"]\)/)
        assert.match(src, /NODE_PORT\s*=\s*hubNodePort\(\s*process\.env\.NODE_PORT\s*,\s*coinNet\["node"\]\["port"\]\s*\)/)
        assert.doesNotMatch(src, /NODE_PORT\s*=\s*coinNet\["node"\]\["port"\]/)
    })
})
