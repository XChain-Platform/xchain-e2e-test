// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const DB_DIR = path.resolve(__dirname, '../../../../src/db')
const sourceJoin = /index_addresses\s+\w+\s+ON\s+\w+\.id\s*=\s*(\w+)\.source_id/g

function sourceJoins(source) {
    return Array.from(source.matchAll(sourceJoin), match => match[1])
}

describe('action source joins', function () {
    it('detects a transaction-backed source join', function () {
        const sql = 'LEFT JOIN index_addresses ia ON ia.id = tr.source_id'
        assert.deepStrictEqual(sourceJoins(sql), ['tr'])
    })

    it('uses actions for every action-backed source address', function () {
        const joins = []
        for (const name of fs.readdirSync(DB_DIR).filter(name => name.endsWith('.js'))) {
            const source = fs.readFileSync(path.join(DB_DIR, name), 'utf8')
            for (const owner of sourceJoins(source)) joins.push({ name, owner })
        }
        assert.deepStrictEqual(joins.filter(join => join.owner === 'tr'), [])
        assert.ok(joins.filter(join => join.owner === 'act').length >= 20)
    })
})
