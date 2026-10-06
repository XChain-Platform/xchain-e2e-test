// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const HIDDEN_EXPRESSION = '(globalThis?.globalThis).Promise'

function contractSource(expression){
    return [
        `const lintProbe = ${expression};`,
        'module.exports = {',
        "    meta: { name: 'Optional Chain Probe', description: 'Exercises deploy-time validation of a global object reference.', version: '1.0.0' },",
        "    probe: function() { return lintProbe ? 'present' : 'absent' }",
        '};'
    ].join('\n')
}

const HIDDEN_SOURCE = contractSource(HIDDEN_EXPRESSION)
const CONTROL_SOURCE = contractSource('1')

module.exports = { HIDDEN_SOURCE, CONTROL_SOURCE, HIDDEN_EXPRESSION }
