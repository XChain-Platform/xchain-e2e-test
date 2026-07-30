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
// federation produced. The devhost BTC regtest venue IS that venue since
// 2026-07-26; NO_PRICE_SEED below is how a run declares it.

'use strict'

const fs   = require('fs')
const path = require('path')

//  step 8, the validator-venue tightening. XCHAIN_E2E_NO_PRICE_SEED=1
// declares "this venue's hub publishes prices itself". Every seeding site in the
// tree must honor it, because a seeded row carries a synthetic round number far
// above any round a hub reaches, getLatestPrice takes the HIGHEST round, and so
// ONE unsuppressed seed silently shadows every derived round on the venue - the
// exact condition that let the original bug survive. The guard test enforces
// that every seed site references this flag. Opt-in, because on every venue
// whose hub does NOT publish the pair the seed is what makes LTC/DOGE payable.
const NO_PRICE_SEED = process.env.XCHAIN_E2E_NO_PRICE_SEED === '1'

// For the sdk venue SETUPS, whose fee sizing is computed FROM the fixture prices:
// suppressing their seed would not adapt them to live prices, it would misprice
// every fee they compose. On a publishing venue they are not runnable at all, and
// that must fail loudly at the seed site rather than as a fee rejection later.
function refuseSeedIfSuppressed(site) {
    if (!NO_PRICE_SEED) return
    throw new Error(site + ': XCHAIN_E2E_NO_PRICE_SEED=1 but this setup prices its fees ' +
        'from the fixture it seeds; it cannot run against a venue whose hub publishes ' +
        'the pair. Unset the flag (non-validator venue) or use the derivation suite.')
}

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

// . Every synthetic round number any seeding site in the tree writes, in
// ONE place. These used to be declared twice - the values in nativeFeeHelper and
// a hand-maintained copy in nativeFeeOracleLive's SEED_SENTINELS - with a comment
// asking future editors to keep them in lockstep, which is exactly the kind of
// duplication that goes stale silently.
//
// They all sit far above any round a hub will ever reach, deliberately: a seeded
// row must win getLatestPrice's `ORDER BY round_number DESC` on a venue that has
// no oracle. The cost is that on a venue that DOES derive the pair, one leftover
// row from an earlier run outranks every real round forever, and suppressing new
// seeds cannot retract rows already written (, observed shadowing BTC
// regtest at round 888100002 / $2.00 while the hub derived ~1948 at ~12.90).
// That is what clearSeedSentinels exists to undo.
//
// The list must name EVERY synthetic round the tree writes, not just the
// native-fee ones. A round that seeds but is absent here is worse than no clear
// at all: the flagged run reports "cleared N rows" and looks finished while that
// round keeps shadowing its pair. The first six entries below were exactly that
// case, found still live on the BTC regtest venue after the LTC clear (
// round 3): 999000001-6 and 999000708 were sitting above the hub's derived
// rounds for BTC/EUR, BTC/GBP, BTC/JPY, BTC/CHF and BTC/CAD at a flat 50000.00.
// seedSentinelCoverage.test.js now derives this set from the seed sites, so the
// list cannot drift behind them again by hand.
const SEED_SENTINEL_ROUNDS = Object.freeze([
    990001, 990002,          // dexDogeSetup + xcallDogeSetup + _ctlseed + the nativeFeeOracleLive sidecar
    990011, 990012,          // _ctlseed's wall-clock anchor (written only when the chain trails)
    888100001, 888100002,    // nativeFeeHelper XCHAIN_ROUND / COIN_ROUND (chain-time anchor)
    888100011, 888100012,    // nativeFeeHelper *_ROUND_NOW (wall-clock anchor, seeded when the chain clock trails)
    999000001, 999000002,    // dispenser FIAT Mode 1 / Mode 2 (the pair is COIN/<fiat>, not COIN/USD)
    999000003, 999000004,
    999000005, 999000006,
    999000708,               // oracleMirror's validator leg
    999200001, 999200002,    // nativeFeeLive band (chain-time anchor)
    999200011, 999200012,    // nativeFeeLive band (wall-clock anchor)
    999300001, 999300002,    // nativeFeeDispenser band
])

module.exports = { BOOTSTRAP_XCHAIN_USD, BOOTSTRAP_XCHAIN_USD_NUM, hubBootstrapConstant,
                   NO_PRICE_SEED, refuseSeedIfSuppressed, SEED_SENTINEL_ROUNDS }
