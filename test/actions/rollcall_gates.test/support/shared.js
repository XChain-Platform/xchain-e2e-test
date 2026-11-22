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
 ********************************************************************/

// Shared state and helpers for the ZC7 gates suite. Part of rollcall_gates.test.js.

'use strict'

const assert = require('assert')

const rc = require('../../../helpers/rollcallHelper')
const { requireFederationEnv } = require('../../../helpers/federationGuards')

// The suite's one mutable record, handed to every part. Parts read what earlier
// parts measured (the suite runs in file order), so it lives here and not in
// any one part's closure.
//
// httpGet is the shipped http_get provider entry, resolved in loadProvider()
// rather than at require time so a checkout without the sibling skips this
// suite instead of failing to load every suite in the file's directory (the
// same rule rollcallHelper's lazy sibling resolution follows). Two values are
// read from it and neither may be spelled here:
//   allowed_redundancy - a request whose redundancy is off this list is refused
//     by `invalid: REDUNDANCY (not allowed for provider)` long before the
//     admission gate this suite measures, which would read as the wrong rule;
//   min_stake_xchain   - `computeResponsibleSet` drops staking SOURCES below it
//     on the weighted path before the ranking, so the pool this suite counts
//     must be counted at the same threshold or its arithmetic describes a set
//     the indexer never had.
function newState(){
    return {
        httpGet: null,
        ctx: null,
        E1: null, E2: null, C1: null, C2: null,
        // Chosen in ZC7b from what the venue actually holds, never assumed.
        shortHubs: [],        // hub indexes that publish a SHORT gate list
        shortKeys: [],        // their pubkeys, lowercase
        shortGates: null,     // the list they publish, comma-joined
        droppedGate: null,    // the one active gate the short list omits
        redundancy: null,     // the request redundancy ZC7d emits
        sourcesBefore: null,  // qualifying attestation SOURCES before the drop
    }
}

// getcapabilityvalidators as the hub's CapabilitySnapshot calls it: the
// caller passes the BURIED block and the indexer judges the rules filter at
// buried + CANONICAL_REORG_BUFFER. No height parameter is added on purpose
// (spec §7.4), so this is the only way to ask about a request block.
async function capabilitySet(capability, buriedBlock, minStake){
    const params = { capability: capability, block_index: Number(buriedBlock) }
    if (minStake) params.min_stake = String(minStake)
    const res = await indexerConnector.getCapabilityValidators(
        params.capability, params.block_index, params.min_stake)
    assert.ok(res && !res.error,
        'getcapabilityvalidators(' + capability + ') at buried block ' + buriedBlock + ' failed: ' +
        JSON.stringify(res && res.error))
    const keys    = new Set((res.validators || []).map(v => String(v.pubkey).toLowerCase()))
    // getcapabilityvalidators answers {pubkey, amount} only: it carries no
    // source, so counting `v.source` here collapsed every key into one
    // undefined source and sized ZC7b/ZC7d as "1 source before, 1 after" on
    // a venue holding four (measured 2026-09-08 at blocks 7605/7635). The
    // SOURCE is what the responsible set dedupes on (D58), so it is read from
    // getstakeweightsbycapability, the same-height, same-floor view that does
    // carry it, joined by pubkey to the FILTERED set above.
    const weights = await indexerConnector.call('getstakeweightsbycapability', params)
    assert.ok(weights && !weights.error,
        'getstakeweightsbycapability(' + capability + ') at buried block ' + buriedBlock + ' failed: ' +
        JSON.stringify(weights && weights.error))
    const sourceOf = new Map((weights.validators || []).map(v => [String(v.pubkey).toLowerCase(), String(v.source)]))
    const sources  = new Set(Array.from(keys).filter(k => sourceOf.has(k)).map(k => sourceOf.get(k)))
    assert.strictEqual(sources.size > 0, keys.size > 0,
        'every filtered ' + capability + ' key must resolve to a staking source through the weights read; ' +
        'keys ' + Array.from(keys).map(k => k.slice(0, 8)).join(',') + ' vs sources known for ' +
        Array.from(sourceOf.keys()).map(k => k.slice(0, 8)).join(','))
    return { res, keys, sources }
}

// The BTC height the filter judges a request at, given the buried block a
// reader passes. Borrowed from the shipped module so the two cannot drift.
function requestBlockFor(buriedBlock){
    return Number(buriedBlock) + Number(rc.indexerModule('src/consensus/snapshot_reorg_buffer.js').CANONICAL_REORG_BUFFER)
}

// True when the venue can run this suite. False means the caller must skip:
// only the mocha context can, so this reports and the hook acts.
function venueReady(mocha){
    if (!rc.requireRollcallVenue(mocha)) return false
    if (!requireFederationEnv(mocha)) return false

    // The gates rail is the VENUE's opt-in, so an unarmed venue skips with the
    // reason rather than failing: every other rollcall suite runs happily on a
    // venue that arms only the ROLLCALL rail, and this one has nothing to say
    // there (every epoch is v0 and no gate row can exist).
    if (!process.env[rc.ROLLCALL_GATES_ARMING_ENV]){
        console.log('[skip] ZC7 needs the ROLLCALL GATES rail armed as well as the ROLLCALL rail. Set ' +
                    rc.ROLLCALL_GATES_ARMING_ENV + '=armed in this shell AND in both indexer containers\' ' +
                    'environments (the BTC close and the DOGE parser each read it at startup), then re-run.')
        mocha.skip()
        return false
    }
    return true
}

async function bringUp(st){
    st.ctx = await rc.bringUpVenue({ hubCount: 3, needSources: 4,
        dbNamePrefix: 'XChain_BTC_Regtest_ROLLCALLGATES_' })

    // bringUpVenue's frozen-vector check already ran the v1 half on an armed
    // venue; assert the arming itself so a venue whose variable was set to an
    // OFF value ("0" is a height, "off" is inert) says so here rather than
    // producing v0 epochs this suite would misread as a protocol failure.
    assert.strictEqual(rc.gatesArmed(0, st.ctx.network), true,
        'ROLLCALL gates are INERT on ' + st.ctx.network + ' even though ' + rc.ROLLCALL_GATES_ARMING_ENV +
        ' is set to ' + JSON.stringify(String(process.env[rc.ROLLCALL_GATES_ARMING_ENV])) + '. The module ' +
        'reads that value once, at require time, and falls CLOSED to inert on anything it does not ' +
        'recognise: use "armed" or a non-negative height.')
}

async function loadProvider(st){
    // The fail-closed half of ZC7d is the ATTEST v0 admission gate. Inert, the
    // request would simply be admitted with an unservable set and the leg would
    // assert on a literal nothing was going to produce.
    // The indexer renamed its registry to snake_case; an indexer origin from before
    // that rename carries the camelCase name, so that one is tried only when the
    // snake_case file does not resolve at all.
    let providerRegistry
    try { providerRegistry = rc.indexerModule('src/attestation/provider_registry.js') }
    catch (e) {
        if (!/cannot resolve/.test(e.message)) throw e
        providerRegistry = rc.indexerModule('src/attestation/providerRegistry.js')
    }
    const httpGet = st.httpGet = providerRegistry.PROVIDERS.http_get
    assert.ok(httpGet && Array.isArray(httpGet.allowed_redundancy) && httpGet.min_stake_xchain,
        'the shipped http_get provider entry carries no allowed_redundancy / min_stake_xchain; this suite ' +
        'reads both from it rather than spelling them, so a changed shape is a stop rather than a guess')

    // The admission gate lives as a registry row (src/protocol_changes/gates_1.js);
    // its former predicate module was retired in W4, so the row is read through
    // the registry's generic predicate against the request's own LOCAL height.
    const gateRegistry = rc.indexerModule('src/consensus/gate_registry.js')
    assert.strictEqual(gateRegistry.activeAt('attest_admission_activation.ATTEST_ADMISSION_ACTIVATION', st.ctx.network, null, 0, 0), true,
        'the ATTEST v0 admission gate is inert on ' + st.ctx.network + ', so no request can be refused for a ' +
        'short responsible set and ZC7d has no verdict to read')
}

async function planEpochs(st){
    const ctx = st.ctx
    const tip = await ctx.btcTip()
    const epochs = rc.epochsAfter(tip + 6, ctx.network, 2)
    const E1 = st.E1 = epochs[0], E2 = st.E2 = epochs[1]
    const C1 = st.C1 = rc.closeHeightOf(E1, ctx.network)
    const C2 = st.C2 = rc.closeHeightOf(E2, ctx.network)
    console.log('    ZC7 driving epochs ' + E1 + ' (close ' + C1 + ') and ' + E2 + ' (close ' + C2 + '); ' +
                'this build knows ' + rc.knownGates().split(',').length + ' gate(s), ' +
                rc.activeGates(tip, ctx.network).length + ' active at the current tip')
}

module.exports = {
    newState, capabilitySet, requestBlockFor, venueReady, bringUp, loadProvider, planEpochs,
}
