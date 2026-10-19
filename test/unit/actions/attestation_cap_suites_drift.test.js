/*
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 */

'use strict'

// Offline guards for the two attestation cap suites, which only run against a live
// stack. Both broke on the v0.25.0 release matrix without a stack being needed to
// see it: one called a predicate the indexer had retired, and one deployed a
// contract with no meta export, which DEPLOY refuses (CONTRACT_MANIFEST, meta required).

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ACTIONS = path.join(__dirname, '..', '..', 'actions')
const GATE = path.join(__dirname, '..', '..', '..', '..', 'xchain-indexer',
    'src', 'actions', 'attest', 'gates', 'attest_request_cap_gate.js')

function source(name) {
    return fs.readFileSync(path.join(ACTIONS, name), 'utf8')
}

describe('attestation cap suites stay in step with the indexer @unit', function () {
    it('attestation_request_cap.test.js calls only what the cap gate module exports', function () {
        if (!fs.existsSync(GATE)) {
            if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1') assert.fail('xchain-indexer sibling is missing')
            this.skip()
        }
        const gate = require(GATE)
        const used = new Set()
        for (const match of source('attestation_request_cap.test.js').matchAll(/capRule\.([A-Za-z_$][\w$]*)/g))
            used.add(match[1])
        assert.ok(used.size > 0, 'the suite no longer reads the cap gate module')
        for (const name of used)
            assert.ok(Object.prototype.hasOwnProperty.call(gate, name),
                'attest_request_cap_gate.js does not export ' + name)
    })

    it('every contract the admission cap suite deploys declares a meta export', function () {
        const text = source('attestationAdmissionCap.test.js')
        const contracts = text.split('module.exports = {').slice(1)
        assert.ok(contracts.length > 0, 'no contract source found in the suite')
        for (const body of contracts)
            assert.match(body.slice(0, 400), /^\s*meta:\s*\{/, 'a deployed contract has no meta export first')
    })
})
