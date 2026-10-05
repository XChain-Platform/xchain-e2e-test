/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

// The ladder below is relative to test/helpers, where it lived before the split.
const HELPERS_DIR = path.resolve(__dirname, '..')

// ── sibling module resolution ────────────────────────────────────────────────
//
// Same candidate ladder multiValidatorHubHelper uses for xchain-hub: monorepo
// sibling, e2e image bundle, or an explicit override. Resolved lazily so a
// suite that only reads its own preconditions does not die at require() time in
// a checkout without the sibling.
function internalResolveSibling(pkg, rel){
    const candidates = [
        process.env['XCHAIN_' + pkg.replace('xchain-', '').toUpperCase() + '_PATH'] &&
            path.join(process.env['XCHAIN_' + pkg.replace('xchain-', '').toUpperCase() + '_PATH'], rel),
        path.resolve(HELPERS_DIR, '../../', pkg, rel),
        path.resolve(HELPERS_DIR, '../../../', pkg, rel),
        path.resolve(HELPERS_DIR, '../../../../', pkg, rel),
        path.resolve(HELPERS_DIR, '../../../../../modules/', pkg, rel),
    ].filter(Boolean)
    for (const p of candidates) if (fs.existsSync(p)) return p
    throw new Error(
        'ROLLCALL harness: cannot resolve ' + pkg + '/' + rel + '. The suite reads its consensus ' +
        'constants and its canonical builder from the shipped module rather than re-deriving them. ' +
        'Place ' + pkg + ' adjacent to xchain-e2e-test. Tried: ' + candidates.join(', ')
    )
}

// The same ladder, answering "is it there" instead of throwing. Used where a
// missing sibling is a legitimate skip and a broken one must still be loud.
function internalResolveSiblingIfPresent(pkg, rel){
    try { return internalResolveSibling(pkg, rel) }
    catch (e) { return null }
}

// This harness IS a two-chain regtest venue, so it opts itself in.
// rollcall_activation.js resolves ROLLCALL_ACTIVATION.regtest from this variable
// at REQUIRE time and ships inert otherwise (arming a network by default wedged
// every single-coin BTC venue at its first close, the 2026-08-31 finding), so it
// has to be set before the sibling module is first loaded -- here, and before
// the in-process hubs load their own byte-twin copy of it. The DEPLOYED BTC
// indexer and any container-side hub need the SAME variable in their own
// environment; assertBtcProofWiring below is what catches a venue that armed the
// harness and forgot the containers.
const ROLLCALL_REGTEST_ARMING_ENV = 'XC_ROLLCALL_REGTEST_ACTIVATION'
if (!process.env[ROLLCALL_REGTEST_ARMING_ENV]) process.env[ROLLCALL_REGTEST_ARMING_ENV] = 'armed'

// The GATES rail (ROLLCALL v1: the roll call names the consensus gates its
// signers know, and the rules-aware attestation set reads them) has its OWN
// environment variable, and this harness DELIBERATELY DOES NOT SET IT.
//
// Arming the ROLLCALL rail for ourselves is safe: it only decides whether the
// in-process hubs sign an epoch at all. Arming the GATES rail is not, because it
// changes the WIRE the hubs publish, and the DOGE parser refuses a v1 action for
// an epoch its own build reads as v0 ('invalid: ROLLCALL v1 before gates
// activation'). A harness that armed itself against unarmed indexer containers
// would land actions the chain rejects and read the result as a federation-wide
// absence - the same shape ROLLCALL_REGTEST_ARMING_ENV's own note warns about,
// with a louder failure. So this variable is the VENUE's opt-in: set it in the
// shell that runs the suite AND in both indexer containers' environments, or
// leave it unset and every leg here stays v0 exactly as before.
const ROLLCALL_GATES_ARMING_ENV = 'XC_ROLLCALL_GATES_REGTEST_ACTIVATION'

let internalRca = null, internalEqh = null, internalRga = null, internalCrd = null
function rca(){ if (!internalRca) internalRca = require(internalResolveSibling('xchain-indexer', 'src/consensus/gates/rollcall_gate.js')); return internalRca }
function eqh(){ if (!internalEqh) internalEqh = require(internalResolveSibling('xchain-indexer', 'src/consensus/equivocation_header.js')); return internalEqh }
function rga(){ if (!internalRga) internalRga = require(internalResolveSibling('xchain-indexer', 'src/consensus/gates/rollcall_gates_gate.js')); return internalRga }
// Any other shipped indexer module, through the SAME candidate ladder. A suite
// that hard-coded '../../../xchain-indexer/...' would resolve in a monorepo
// checkout and fail in the e2e image bundle, where the sibling sits elsewhere.
function indexerModule(rel){ return require(internalResolveSibling('xchain-indexer', rel)) }
function crd(){ if (!internalCrd) internalCrd = require(internalResolveSibling('xchain-indexer', 'src/consensus_rules_digest.js')); return internalCrd }

// The frozen cross-implementation vector. Authoritative in xchain-documentation;
// read, never forked.
function frozenVector(){
    return require(internalResolveSibling('xchain-documentation', 'protocol/test-vectors/rollcall_canonical.json'))
}

// ── epoch arithmetic, borrowed ───────────────────────────────────────────────

function closeHeightOf(epochHeight, network){
    const h = rca().rollcallCloseHeight(epochHeight, network)
    assert.notStrictEqual(h, null,
        'rollcallCloseHeight(' + epochHeight + ', ' + network + ') is null: unknown network or unparseable height')
    return h
}

// Every epoch boundary strictly after `afterHeight`, in ascending order. The
// suites call this to pick the epochs a run will drive rather than hard-coding
// heights, which would break the moment the venue chain moves.
function epochsAfter(afterHeight, network, count){
    const r = rca()
    const interval = r.ROLLCALL_INTERVAL_BLOCKS[network]
    assert.ok(Number.isFinite(interval) && interval > 0,
        'no ROLLCALL_INTERVAL_BLOCKS for network ' + JSON.stringify(network))
    const out = []
    let e = Math.floor(Number(afterHeight) / interval) * interval
    while (out.length < count){
        e += interval
        if (r.isRollcallEpoch(e, network) && r.isRollcallActive(e, network)) out.push(e)
    }
    return out
}

module.exports = {
    internalResolveSibling,
    internalResolveSiblingIfPresent,
    ROLLCALL_REGTEST_ARMING_ENV,
    ROLLCALL_GATES_ARMING_ENV,
    rca,
    eqh,
    rga,
    indexerModule,
    crd,
    frozenVector,
    closeHeightOf,
    epochsAfter,
}
