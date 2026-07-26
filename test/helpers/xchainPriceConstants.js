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
// The XCHAIN/USD value production actually publishes (, spec §10 step 8).
//
// WHY THIS FILE EXISTS. Every native-fee suite used to seed XCHAIN/USD = 1.00, a
// number production has never produced and now never will: the pair is derived from
// platform-realized fills, and with the D2 supersession threshold undecided the hub
// publishes the bootstrap carry-forward of 2.00 every round. Testing against 1.00
// was not merely inaccurate, it was the specific reason the missing-pair bug
// survived to launch-blocker status - every green native-fee run was asserting
// against data no producer emits.
//
// So the suites seed THIS value, and the guard test pins it against the hub's own
// constant. When D2 is decided and a real market supersedes the bootstrap, the
// derived value moves and this constant stops being the expected price; that is a
// deliberate future breakage, and it should break loudly here rather than quietly
// somewhere downstream.
//
// This is NOT a licence to keep hand-seeding forever. The end state (§10 step 8) is
// a venue whose hub runs as a price-capability oracle validator and publishes the
// pair itself, at which point the seeding goes away and the suites read what the
// federation produced. That venue does not exist yet, so until it does the suites
// seed the value the federation WOULD have produced rather than a 1.00-era fiction.

'use strict'

const fs   = require('fs')
const path = require('path')

// D2, DECIDED 2026-07-25 (operator): anchored on a token issuance costing $2.00.
// GAS_PRICE 0.00001 XCHAIN/gas x ISSUE 100,000 gas is exactly 1.0 XCHAIN, so the
// bootstrap price equals the target issuance cost 1:1.
const BOOTSTRAP_XCHAIN_USD = '2.00000000'

// Numeric form, for the setups that compute an expected native fee from the ratio
// rather than seeding a decimal string.
const BOOTSTRAP_XCHAIN_USD_NUM = 2.00

// The hub's own constant, or null when the sibling checkout is absent. Read from
// source rather than required, because the e2e repo does not depend on the hub and
// requiring it would drag in its whole module graph for one string.
function hubBootstrapConstant() {
    const hubDir = process.env.XCHAIN_HUB_DIR ||
        path.join(__dirname, '..', '..', '..', 'xchain-hub')
    const file = path.join(hubDir, 'src', 'constants.js')
    if (!fs.existsSync(file)) return null
    const m = fs.readFileSync(file, 'utf8')
        .match(/const\s+XCHAIN_PRICE_BOOTSTRAP_USD\s*=\s*'([^']+)'/)
    return m ? m[1] : null
}

module.exports = { BOOTSTRAP_XCHAIN_USD, BOOTSTRAP_XCHAIN_USD_NUM, hubBootstrapConstant }
