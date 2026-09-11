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
 **********************************************************************
 * E2E acceptance: the rules-aware attestation set (ZC7).
 *
 * The operator ask this drives: route an attestation request only to validators
 * running the CONSENSUS RULES that govern it, keyed on the rules and never on a
 * release version. The rail that answers it spans both chains and four
 * components, and this suite is the only place all four are driven together:
 *
 *   ZC7a  every hub publishes ROLLCALL v1 naming the gate list its build knows,
 *         the epoch ROLLS, and the BTC close writes one `rollcall_gates` row per
 *         verified signer carrying exactly that list.
 *   ZC7b  a second epoch in which one or more validators publish their OWN roll
 *         call over a list MISSING a gate that is active at the request block.
 *         Their rows are recorded with the short list, which is a true statement
 *         about what those builds accepted.
 *   ZC7c  at a request block judged against that epoch, the short-list validator
 *         is ABSENT from the `attestation` capability set and still PRESENT in
 *         the `price` set: the filter is scoped to the one capability whose
 *         responsible set is derived from consensus rules (spec §7.4, D16).
 *   ZC7d  with fewer sources surviving the filter than the request's REDUNDANCY,
 *         the emitting EXECUTE REVERTS carrying the rules-aware admission
 *         literal, which is a different sentence from the ordinary "the set was
 *         always this small" refusal (D61).
 *
 * WHY THIS IS ON THE LIVENESS FEDERATION VENUE AND NOT THE MIRROR ONE (D63): the
 * ROLLCALL rail is inert unless XC_ROLLCALL_REGTEST_ACTIVATION is set, and the
 * attestMirror venue has never produced a rolled epoch. Gate rows exist only as
 * an artifact of a rolled epoch's close, so the whole filter is unreachable
 * without a federation that rolls.
 *
 * BOTH RAILS ARMED, AND THE SECOND ONE IS THE VENUE'S OPT-IN. The harness arms
 * the ROLLCALL rail for itself; it deliberately does NOT arm the gates rail
 * (rollcallHelper's note at ROLLCALL_GATES_ARMING_ENV says why). Set
 * XC_ROLLCALL_GATES_REGTEST_ACTIVATION=armed in the shell that runs this suite
 * AND in the environment of BOTH indexer containers - the DOGE parser refuses a
 * v1 action for an epoch its own build reads as v0, and the BTC close refuses a
 * v0 row for an epoch it reads as v1, so a half-armed venue produces a
 * federation-wide absence rather than an error. Unarmed, this suite SKIPS.
 *
 * EXCLUSIVE ON THE VENUE. It drives two whole epochs on the shared regtest
 * chain, silences hubs, and lands hand-built ROLLCALL actions on DOGE; another
 * ROLLCALL suite running against the same chain would drive the same epochs.
 * Run it alone, or serialised behind the other rollcall suites.
 *
 * BLOCK BUDGET: about 2 x 30 (two epochs) + 12 (accept window) + 2 (proof delay)
 * BTC blocks, plus the 6-block burial before each epoch's first signable tick
 * and a handful past the second close for the capability reads and the request:
 * roughly 90 BTC blocks, with DOGE mined throughout for the publishes and the
 * close's evidence.
 *
 * WALL TIME: about 35 to 50 minutes on the regtest venue, dominated
 * by the two rank-ladder climbs and the two closes. The suite timeout is 60
 * minutes so a slow close reports its own precondition rather than a timeout.
 *
 * SIDE EFFECT WORTH KNOWING BEFORE A STANDALONE RUN: two rolled epochs with the
 * idle fourth staker absent complete its K-streak and the protocol EVICTS it,
 * exactly as rollcallEviction (AT1) does, and an evicted key can never be staked
 * again. Driven after that suite in one `npm run test:rollcall` pass there is
 * nothing left to evict; driven standalone twice on one venue, bump
 * XC_ROLLCALL_IDLE_GENERATION and re-seed between runs.
 *
 * VENUE: bootstrapped on the BITCOIN regtest stack (COIN=bitcoin) with the
 * DOGECOIN regtest stack up and a seeded four-source federation. See
 * test/helpers/rollcallHelper.js bringUpVenue for the full precondition list;
 * E2E_REQUIRE_FEDERATION=1 opts in (npm run test:rollcall sets it).
 *
 ********************************************************************/

'use strict'

const assert = require('assert')

const rc                = require('../helpers/rollcallHelper')
const cryptoHelper      = require('../cryptoHelper')
const gasHelper         = require('../helpers/gasHelper')
const vmHelper          = require('../helpers/vmHelper')
const { requireFederationEnv } = require('../helpers/federationGuards')

// Deliberately short: these requests are never meant to be answered.
const DEADLINE_BLOCKS = 10

// The shipped http_get provider entry, resolved in before() rather than at
// require time so a checkout without the sibling skips this suite instead of
// failing to load every suite in the file's directory (the same rule
// rollcallHelper's lazy sibling resolution follows). Two values are read from it
// and neither may be spelled here:
//   allowed_redundancy - a request whose redundancy is off this list is refused
//     by `invalid: REDUNDANCY (not allowed for provider)` long before the
//     admission gate this suite measures, which would read as the wrong rule;
//   min_stake_xchain   - `_computeResponsibleSet` drops staking SOURCES below it
//     on the weighted path before the ranking, so the pool this suite counts
//     must be counted at the same threshold or its arithmetic describes a set
//     the indexer never had.
let httpGet = null

describe('ROLLCALL acceptance: the rules-aware attestation set (ZC7)', function () {
    this.timeout(60 * 60 * 1000)

    let ctx = null
    let E1 = null, E2 = null, C1 = null, C2 = null

    // Chosen in ZC7b from what the venue actually holds, never assumed.
    let shortHubs   = []      // hub indexes that publish a SHORT gate list
    let shortKeys   = []      // their pubkeys, lowercase
    let shortGates  = null    // the list they publish, comma-joined
    let droppedGate = null    // the one active gate the short list omits
    let redundancy  = null    // the request redundancy ZC7d emits
    let sourcesBefore = null  // qualifying attestation SOURCES before the drop

    // getcapabilityvalidators as the hub's CapabilitySnapshot calls it: the
    // caller passes the BURIED block and the indexer judges the rules filter at
    // buried + CANONICAL_REORG_BUFFER. No height parameter is added on purpose
    // (spec §7.4), so this is the only way to ask about a request block.
    async function capabilitySet(capability, buriedBlock, minStake){
        const params = { capability: capability, block_index: Number(buriedBlock) }
        if (minStake) params.min_stake = String(minStake)
        const res = await indexerConnector.call('getcapabilityvalidators', params)
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
        return Number(buriedBlock) + Number(rc.indexerModule('src/snapshot_reorg_buffer.js').CANONICAL_REORG_BUFFER)
    }

    before(async function () {
        if (!rc.requireRollcallVenue(this)) return
        if (!requireFederationEnv(this)) return

        // The gates rail is the VENUE's opt-in, so an unarmed venue skips with the
        // reason rather than failing: every other rollcall suite runs happily on a
        // venue that arms only the ROLLCALL rail, and this one has nothing to say
        // there (every epoch is v0 and no gate row can exist).
        if (!process.env[rc.ROLLCALL_GATES_ARMING_ENV]){
            console.log('[skip] ZC7 needs the ROLLCALL GATES rail armed as well as the ROLLCALL rail. Set ' +
                        rc.ROLLCALL_GATES_ARMING_ENV + '=armed in this shell AND in both indexer containers\' ' +
                        'environments (the BTC close and the DOGE parser each read it at startup), then re-run.')
            this.skip()
            return
        }

        ctx = await rc.bringUpVenue({ hubCount: 3, needSources: 4,
            dbNamePrefix: 'XChain_BTC_Regtest_ROLLCALLGATES_' })

        // bringUpVenue's frozen-vector check already ran the v1 half on an armed
        // venue; assert the arming itself so a venue whose variable was set to an
        // OFF value ("0" is a height, "off" is inert) says so here rather than
        // producing v0 epochs this suite would misread as a protocol failure.
        assert.strictEqual(rc.gatesArmed(0, ctx.network), true,
            'ROLLCALL gates are INERT on ' + ctx.network + ' even though ' + rc.ROLLCALL_GATES_ARMING_ENV +
            ' is set to ' + JSON.stringify(String(process.env[rc.ROLLCALL_GATES_ARMING_ENV])) + '. The module ' +
            'reads that value once, at require time, and falls CLOSED to inert on anything it does not ' +
            'recognise: use "armed" or a non-negative height.')

        // The fail-closed half of ZC7d is the ATTEST v0 admission gate. Inert, the
        // request would simply be admitted with an unservable set and the leg would
        // assert on a literal nothing was going to produce.
        httpGet = rc.indexerModule('src/attestation/providerRegistry.js').PROVIDERS.http_get
        assert.ok(httpGet && Array.isArray(httpGet.allowed_redundancy) && httpGet.min_stake_xchain,
            'the shipped http_get provider entry carries no allowed_redundancy / min_stake_xchain; this suite ' +
            'reads both from it rather than spelling them, so a changed shape is a stop rather than a guess')

        const attestAdmission = rc.indexerModule('src/attest_admission_activation.js')
        assert.strictEqual(attestAdmission.isAttestAdmissionActive(0, ctx.network), true,
            'the ATTEST v0 admission gate is inert on ' + ctx.network + ', so no request can be refused for a ' +
            'short responsible set and ZC7d has no verdict to read')

        const tip = await ctx.btcTip()
        const epochs = rc.epochsAfter(tip + 6, ctx.network, 2)
        E1 = epochs[0]; E2 = epochs[1]
        C1 = rc.closeHeightOf(E1, ctx.network)
        C2 = rc.closeHeightOf(E2, ctx.network)
        console.log('    ZC7 driving epochs ' + E1 + ' (close ' + C1 + ') and ' + E2 + ' (close ' + C2 + '); ' +
                    'this build knows ' + rc.knownGates().split(',').length + ' gate(s), ' +
                    rc.activeGates(tip, ctx.network).length + ' active at the current tip')
    })

    after(async function () { await rc.tearDownVenue(ctx) })

    // ── ZC7a ─────────────────────────────────────────────────────────────────

    it('ZC7a: a rolled v1 epoch records one rollcall_gates row per present signer, carrying the list it signed', async function () {
        const row = await rc.driveEpoch(ctx, E1, { silentHubs: [] })
        assert.strictEqual(Number(row.rolled), 1,
            'epoch ' + E1 + ' closed UNROLLED with every hub present. On a gates-armed venue the likeliest cause ' +
            'is a HALF-ARMED one: the DOGE indexer refuses a v1 action for an epoch its own build reads as v0 ' +
            '(`invalid: ROLLCALL v1 before gates activation`), so every signature is discarded and the epoch ' +
            'closes with nobody present. Set ' + rc.ROLLCALL_GATES_ARMING_ENV + ' in BOTH indexer containers ' +
            'and restart them. responsible_set_json=' + String(row.responsible_set_json))
        assert.strictEqual(Number(row.close_block), C1, 'epoch ' + E1 + ' must close at E + 14')

        const full  = rc.knownGates().split(',')
        const rows  = await rc.rollcallGatesRows(ctx, E1)
        const byKey = new Map(rows.map(r => [r.pubkey, r]))

        // One row per SIGNER, and the signers are the three hubs this harness runs.
        // The idle fourth staker signs nothing and must therefore have no row: a row
        // for a key that never signed would mean the close recorded a claim nobody
        // made, which is the one way this table could lie to the filter.
        for (let i = 0; i < ctx.rounds.length; i++){
            const key = ctx.roster[i].pubkey
            const got = byKey.get(key)
            assert.ok(got,
                'ZC7a: hub ' + i + ' (' + key.slice(0, 16) + '...) signed epoch ' + E1 + ' but the close wrote no ' +
                '`rollcall_gates` row for it. The close writes these rows only for a ROLLED v1 epoch and only for ' +
                'signers it VERIFIED, so a missing row means either the row failed verification against the ' +
                'rebuilt v1 canonical or the BTC indexer read the epoch as v0. Rows present: ' +
                JSON.stringify(rows.map(r => r.pubkey.slice(0, 12))))
            assert.deepStrictEqual(got.gates, full,
                'ZC7a: hub ' + i + '\'s recorded list must be exactly the list its build knows (' + full.length +
                ' gate(s)); got ' + (got.gates === null ? 'an unparseable gates_json' : got.gates.length + ' gate(s)'))
            assert.strictEqual(got.close_block, C1,
                'ZC7a: the row is written at the close block and is rolled back with it')
        }
        assert.ok(!byKey.has(ctx.roster[rc.IDLE_SEED_INDEX].pubkey),
            'ZC7a: the idle fourth staker never signs, so it must have no `rollcall_gates` row for epoch ' + E1)

        // The property the filter actually reads: a full list is a superset of the
        // gates active at any block this epoch can be judged for, so nobody is
        // dropped. Asserted rather than assumed, because it is the control ZC7c's
        // absence is measured against.
        const active = rc.activeGates(requestBlockFor(C1 + 1), ctx.network)
        assert.ok(active.length > 0,
            'no consensus gate is active at ' + requestBlockFor(C1 + 1) + ' on ' + ctx.network + ', so the subset ' +
            'test is vacuous and nothing here can be dropped for any reason')
        for (const g of active)
            assert.ok(full.includes(g),
                'ZC7a: gate ' + g + ' is active at the request block but is not in this build\'s own list, so the ' +
                'hubs published a list their own chain would drop them for')
        console.log('    epoch ' + E1 + ': ' + rows.length + ' gate row(s) recorded, ' + full.length +
                    ' gate(s) each, ' + active.length + ' active at the judged request block')
    })

    // ── ZC7b ─────────────────────────────────────────────────────────────────

    it('ZC7b: a validator that publishes a SHORT gate list is recorded with exactly that list', async function () {
        // WHAT THE VENUE HOLDS DECIDES HOW MANY VALIDATORS MUST BE SHORTENED, and
        // that is measured, never assumed. The responsible set is source-deduped and
        // sliced to REDUNDANCY, so what bounds it is the number of qualifying
        // SOURCES; http_get only accepts redundancy 1, 3 or 5, so ZC7d needs the
        // filter to take the surviving source count strictly below one of those.
        //
        // ZC7a leaves the BTC tip exactly at C1, and the indexer refuses a read
        // above its tip ("block_index C1+1 not yet indexed"), so mine past the
        // close before asking about it, the same way ZC7c does for C2. Measured
        // 2026-09-08 on the first venue run that reached this leg.
        await rc.mineBtcTo(ctx, C1 + 2, 'reading the capability set past the close of epoch ' + E1)
        const before = await capabilitySet('attestation', C1 + 1, httpGet.min_stake_xchain)
        sourcesBefore = before.sources.size
        const allowed = httpGet.allowed_redundancy.slice().sort((a, b) => a - b)
        redundancy = allowed.filter(r => r <= sourcesBefore).pop()
        assert.ok(redundancy,
            'ZC7d needs a request whose REDUNDANCY the venue could actually serve BEFORE the filter runs, and ' +
            'this venue qualifies ' + sourcesBefore + ' attestation source(s) at or above the http_get floor of ' +
            String(httpGet.min_stake_xchain) + ' XCHAIN, which is below the smallest redundancy http_get allows (' + allowed[0] +
            '). Stake at least ' + allowed[0] + ' attestation source(s) above that floor before driving ZC7.')

        // One dropped SOURCE per shortened key (the roster keys are one per source,
        // which assertOraclePublishFederation has already established), so this many
        // takes the surviving count below `redundancy`.
        const need = sourcesBefore - redundancy + 1
        const eligible = ctx.roster.slice(0, ctx.rounds.length).filter(r => before.keys.has(r.pubkey))
        assert.ok(eligible.length >= need,
            'ZC7 needs ' + need + ' of its own hubs to be shortened to take the surviving source count from ' +
            sourcesBefore + ' below redundancy ' + redundancy + ', but only ' + eligible.length + ' roster hub(s) ' +
            'qualify for `attestation` at the http_get floor. The venue carries ' + sourcesBefore + ' qualifying ' +
            'source(s), of which ' + (sourcesBefore - eligible.length) + ' are keys this harness does not hold ' +
            'and therefore cannot shorten. Drive ZC7 on a venue whose attestation set is the acceptance roster, ' +
            'or unstake the foreign sources.')
        shortHubs = eligible.slice(0, need).map(r => r.index)
        shortKeys = shortHubs.map(i => ctx.roster[i].pubkey)

        // The list itself: this build's own, minus ONE gate that is ACTIVE at the
        // block the request will be judged at. Dropping an INACTIVE gate would be a
        // list the filter accepts, and the leg would measure nothing.
        const full   = rc.knownGates().split(',')
        const active = rc.activeGates(requestBlockFor(C2 + 1), ctx.network)
        droppedGate  = active[active.length - 1]
        shortGates   = full.filter(g => g !== droppedGate).join(',')
        assert.strictEqual(shortGates.split(',').length, full.length - 1,
            'the short list must omit exactly one gate')
        console.log('    epoch ' + E2 + ': hub(s) ' + shortHubs.join(',') + ' publish a list omitting ' +
                    droppedGate + ' (' + sourcesBefore + ' source(s) before, redundancy ' + redundancy + ')')

        // The shortened hubs are SILENT for the epoch, and their signature reaches
        // the chain only through the action this suite builds. That is not
        // decoration: a signature they gossiped would ride the leader's action over
        // the PUBLISHER's full list, the DOGE peer's per-key read would then hold two
        // rows for one key with different lists, and which one the close saw would
        // depend on row order. One publisher per key is what makes the verdict
        // deterministic.
        //
        // BEFORE the rank-ladder climb, never after it. The close counts a DOGE row
        // only if its block is stamped no later than the BTC window-end block, and
        // the climb mines BTC up to that block whenever a high rank has to unlock,
        // which is exactly what silencing a hub forces on the survivors. Measured
        // 2026-09-08 at epoch 7230: the cut was stamped 05:26:52 UTC, the short-list
        // action parsed valid at 05:27:23, and the close read the hub as absent
        // (no_row) rather than present with a short list. In beforePublish the BTC
        // tip sits at about E + 6 and the cut is six blocks away.
        const windowEnd2 = Number(rc.rca().rollcallWindowEndHeight(E2, ctx.network))
        const row = await rc.driveEpoch(ctx, E2, {
            silentHubs: shortHubs,
            beforePublish: async () => {
                const tipNow = await ctx.btcTip()
                assert.ok(tipNow < windowEnd2 - 1,
                    'epoch ' + E2 + ': BTC tip ' + tipNow + ' is already at the window end ' + windowEnd2 +
                    ', so a short-list publish now would stamp after the cut and read as an absence')
                const bh = await indexerConnector.call('getblockhashes', { block_index: E2 })
                const ledgerHash = String(bh.ledger_hash).toLowerCase()
                for (const i of shortHubs){
                    const sig = rc.signCanonical(ctx.roster[i].seed,
                        rc.canonical(ctx.network, E2, ledgerHash, shortGates))
                    const wire = rc.buildWire(E2, ledgerHash, ctx.roster[i].pubkey,
                        [{ pubkey: ctx.roster[i].pubkey, sig: sig }], shortGates)
                    assert.ok(wire.startsWith(rc.ROLLCALL_WIRE_V1 + '|'),
                        'a short-list publish must be ROLLCALL v1: v0 is positional and length-exact and cannot ' +
                        'carry a GATES field at all')
                    await rc.publishWire(ctx, wire)
                }
                // The publishes must be INDEXED before the window-end cut, or the
                // close reads them as absences and the epoch measures the wrong thing.
                await rc.waitForOnChainSigners(ctx, E2, shortKeys)
            },
        })
        assert.strictEqual(Number(row.rolled), 1,
            'epoch ' + E2 + ' must ROLL: the shortened hubs are PRESENT through their own one-pair actions (the ' +
            'union rule), a short list is a valid list, and presence is what quorum counts. rolled=0 here means ' +
            'either the hand-built actions never landed or their signatures did not verify against the v1 ' +
            'canonical rebuilt from the carried GATES.')

        const rows  = await rc.rollcallGatesRows(ctx, E2)
        const byKey = new Map(rows.map(r => [r.pubkey, r]))
        const short = shortGates.split(',')
        const full2 = rc.knownGates().split(',')
        for (const i of shortHubs){
            const got = byKey.get(ctx.roster[i].pubkey)
            assert.ok(got,
                'ZC7b: hub ' + i + ' published its own roll call for epoch ' + E2 + ' but the close recorded no ' +
                'gate row for it. Its signature is over the SHORT list, so a missing row means the close rebuilt a ' +
                'canonical over different bytes than the ones this suite signed.')
            assert.deepStrictEqual(got.gates, short,
                'ZC7b: hub ' + i + '\'s row must carry EXACTLY the short list it signed, not the full list its ' +
                'build knows: the row is a statement about what this key accepted, and recording anything else ' +
                'would let a validator be judged on a list it never signed')
            assert.ok(!got.gates.includes(droppedGate),
                'ZC7b: the omitted gate ' + droppedGate + ' must not appear in the recorded short list')
        }
        for (let i = 0; i < ctx.rounds.length; i++){
            if (shortHubs.includes(i)) continue
            const got = byKey.get(ctx.roster[i].pubkey)
            assert.ok(got && got.gates,
                'ZC7b: hub ' + i + ' signed the leader\'s full list and must still have a row for epoch ' + E2)
            assert.deepStrictEqual(got.gates, full2,
                'ZC7b: an unshortened hub keeps the full list; one hub publishing a short list must not change ' +
                'what the others are recorded as knowing')
        }
    })

    // ── ZC7c ─────────────────────────────────────────────────────────────────

    it('ZC7c: the short-list validator is absent from the attestation set at the request block and present in the price set', async function () {
        assert.ok(shortKeys.length, 'ZC7c reads back what ZC7b published; this suite runs in file order')

        // Judge at a block whose buried snapshot is at or past E2's close, which is
        // what makes E2 the epoch the filter selects.
        await rc.mineBtcTo(ctx, C2 + 2, 'reading the capability set past the close of epoch ' + E2)
        const judgedAt = requestBlockFor(C2 + 1)
        assert.ok(rc.activeGates(judgedAt, ctx.network).includes(droppedGate),
            'ZC7c: gate ' + droppedGate + ' must still be ACTIVE at the judged request block ' + judgedAt +
            ' or the short list is a superset after all and nobody is dropped')

        const after  = await capabilitySet('attestation', C2 + 1)
        const before = await capabilitySet('attestation', C1 + 1)
        const price  = await capabilitySet('price', C2 + 1)

        for (const key of shortKeys){
            // THE CONTROL FIRST. An absence proves the filter only if the key was in
            // the set before: a key that was never there would read identically, and
            // the reading a drill must never make is "the filter worked" about a
            // validator the venue had already dropped for stake reasons.
            assert.ok(before.keys.has(key),
                'ZC7c: ' + key.slice(0, 16) + '... must be in the `attestation` set at a block judged against ' +
                'epoch ' + E1 + ' (where its list was FULL); it is not, so its absence later would say nothing ' +
                'about the rules filter. Present then: ' + JSON.stringify(Array.from(before.keys).map(k => k.slice(0, 12))))
            assert.ok(!after.keys.has(key),
                'ZC7c: ' + key.slice(0, 16) + '... published a roll call omitting ' + droppedGate + ', which is ' +
                'active at block ' + judgedAt + ', so the rules-aware filter must drop it from the `attestation` ' +
                'set. Still present: ' + JSON.stringify(Array.from(after.keys).map(k => k.slice(0, 12))))
            // The scope of the rule, and the whole reason it is a filter rather than a
            // slash: the same key is still a perfectly good price validator. Only the
            // attestation set is derived from the rules a request is governed by.
            assert.ok(price.keys.has(key),
                'ZC7c: the filter is scoped to `attestation` (D16), so ' + key.slice(0, 16) + '... must still be ' +
                'in the `price` capability set at the same block. Its absence there would mean the filter is ' +
                'running on a capability whose set has nothing to do with consensus rules.')
        }

        // The unshortened hubs are the other half of the reading: a filter that
        // emptied the set would satisfy every assertion above.
        for (let i = 0; i < ctx.rounds.length; i++){
            if (shortHubs.includes(i)) continue
            assert.ok(after.keys.has(ctx.roster[i].pubkey),
                'ZC7c: hub ' + i + ' signed the full list and must SURVIVE the filter at block ' + judgedAt +
                '; a filter that drops everybody is not the rule this suite is measuring')
        }
        console.log('    attestation set at the judged block: ' + after.keys.size + ' key(s) / ' +
                    after.sources.size + ' source(s), was ' + before.keys.size + ' / ' + before.sources.size +
                    ' against epoch ' + E1 + '; price set unchanged at ' + price.keys.size + ' key(s)')
    })

    // ── ZC7d ─────────────────────────────────────────────────────────────────

    it('ZC7d: with fewer surviving sources than REDUNDANCY the emitting EXECUTE reverts with the rules-aware literal', async function () {
        assert.ok(redundancy, 'ZC7d emits the redundancy ZC7b sized; this suite runs in file order')

        // The filter reads the most recent ROLLED epoch whose close is at or below
        // the request's BURIED block (D92), and ZC7c leaves the tip at C2 + 2, so a
        // request mined now would be judged on E1's full lists and the pre-read at
        // tip - 6 would say the same: measured 2026-09-08, "1 qualifying source(s)
        // survive against redundancy 1" with ZC7c green a moment earlier. Bury E2's
        // close first so both the pre-read and the request block see its rows.
        await rc.mineBtcTo(ctx, C2 + 7, 'burying the close of epoch ' + E2 + ' so a request block reads its gates rows')

        const tip = await ctx.btcTip()
        const after = await capabilitySet('attestation', tip - 6, httpGet.min_stake_xchain)
        assert.ok(after.sources.size < redundancy,
            'ZC7d needs the filtered set to be SHORT of the request\'s redundancy: ' + after.sources.size +
            ' qualifying source(s) survive at the http_get floor against redundancy ' + redundancy + '. ZC7b ' +
            'sized this from ' + sourcesBefore + ' source(s) before the drop, so a set this large means stake ' +
            'moved during the run.')
        assert.ok(redundancy <= sourcesBefore,
            'ZC7d\'s request must be one the venue could have served before the filter ran, or the refusal says ' +
            'nothing about the rules')

        const operator = await cryptoHelper.getNewFundedAddress(
            'zc7-operator', COIN, NETWORK, null, 'legacy', 0, 0.02)
        // DEPLOY gas plus one EXECUTE that pays full metered gas for a reverted
        // tree: a failed execution is not refunded.
        await gasHelper.ensureGasBalance(operator, '20000')
        await utxoTrackerConnector.quiesce({ timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector })

        // The redundancy is baked in at deploy time because it is measured, not
        // chosen: the contract is written after ZC7b has counted the venue.
        const code = `
module.exports = {
    meta: { name: 'Rollcall Asker', description: 'Requests an attestation and records a marker for the roll-call gate drill.', version: '1.0.0' },
    ask: function(xchain) {
        xchain.state.set('zc7_marker', xchain.getInputParam(0));
        xchain.attestation.request('http_get', 'https://example.com/zc7/' + xchain.getInputParam(0),
            'handleResponse', ['ctx-zc7'], { redundancy: ${redundancy}, deadlineBlocks: ${DEADLINE_BLOCKS} });
        return 'asked';
    },
    handleResponse: function(xchain) { xchain.state.set('zc7_callback', xchain.getInputParam(2)); }
};
`
        const deploy = await rc.mineWhile(ctx, () => vmHelper.sendDeployV0(operator, code, 500000))
        assert.strictEqual(deploy.contract.status, 'valid', 'deploy status: ' + deploy.contract.status)
        const contractIndex = deploy.contract.action_index

        const exec = await rc.mineWhile(ctx,
            () => vmHelper.sendExecuteV0Invalid(operator, contractIndex, 'ask', ['rules'], 120000))
        assert.ok(exec.execution, 'the refused EXECUTE must still be recorded on-chain')
        assert.notStrictEqual(exec.execution.status, 'valid',
            'a refused ATTEST v0 emission must not leave the EXECUTE valid: processEmission throws on a ' +
            'non-valid emission and the savepoint rolls back')

        const why = String(exec.execution.error_message || '')
        console.log('    ZC7d EXECUTE status=' + exec.execution.status + ' error_message=' + why)
        // THE LITERAL, and it is the point of the leg. Two refusals share this gate
        // and they mean different things to an operator: "the set was always this
        // small" is a staking problem nobody can act on, while "the rules filter
        // shrank it" names a fleet that has not rolled a call covering the gates
        // active at this block. The rules-aware branch is reachable ONLY when the
        // filter actually dropped somebody at the request block, which is why
        // matching it here is a measurement of the filter and not of the string.
        const m = why.match(/invalid: REDUNDANCY \(rules-aware set (\d+) < (\d+) at request block\)/)
        assert.ok(m,
            'ZC7d: the refusal must carry the RULES-AWARE literal, got: ' + why + '\nThe generic ' +
            '"responsible set N < M" literal here would mean the filter dropped nobody at the request block and ' +
            'the set was short for an ordinary staking reason.')
        assert.strictEqual(Number(m[2]), redundancy,
            'the literal must name the request\'s own redundancy, got ' + m[2])
        assert.ok(Number(m[1]) < redundancy,
            'the literal must name a surviving set smaller than the redundancy, got ' + m[1])

        // The revert, stated as rows: a v0 exists only as a VM emission, so no ATTEST
        // row survives and neither does the state write that ran before it.
        const stored = await indexerDatabase.getAttestationRequestsByContract(contractIndex)
        assert.strictEqual(stored.length, 0,
            'ZC7d: a refused request is never stored, not even as `rejected`: found ' + stored.length + ' row(s)')
        const marker = await indexerDatabase.getContractState(contractIndex, 'zc7_marker')
        assert.strictEqual(marker, null,
            'ZC7d: the reverted EXECUTE must leave no contract state behind, which is what a contract author ' +
            'actually sees when the fleet has not rolled a call covering this block\'s rules')
    })
})
