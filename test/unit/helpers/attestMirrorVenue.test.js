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

// The attest-mirror venue's composition layer, pinned.
//
// Five hub processes, two indexer processes and seven databases is the most
// expensive venue in this suite, so it is exactly the venue whose wiring cannot
// be checked by booting it and looking. Every mistake pinned here is one that
// costs a full boot to discover and reads as something else when it happens:
// a mirror pointed at the hub's own authoritative database looks like a
// replication bug, two indexers following one hub looks like a passing
// dissemination test, and an API port that collides with a P2P port looks like
// a flaky venue.
//
// Nothing here opens a socket, spawns a process or touches a database, apart
// from the port test, which needs the kernel to say what is free.

const assert = require('assert')
const net    = require('net')
const {
    assignFollowedHubs,
    planPorts,
    portCount,
    buildHubEnv,
    buildIndexerEnv,
    pickOutsideIndexer,
    assertTimingInvariants,
    resolveWindowKeying,
    assertLlmAvailable,
    resolveWindowKeyingFrom,
    resolveDecoderCredential,
    HUB_CONFIG_REDACTION,
    coinCode,
    DEFAULT_HUB_COUNT,
    DEFAULT_INDEXER_COUNT,
    DEFAULT_FORWARD_S,
    DEFAULT_BATCH_WINDOW_S,
    DEFAULT_GRACE_S,
    GOSSIP_HOP_BUDGET_S,
    WINDOW_KEY_SIGNED,
    WINDOW_KEY_WALL_CLOCK,
    DB_PREFIX
} = require('../../helpers/attestMirrorVenue')
const { pickFreePorts, ephemeralRange } = require('../../helpers/multiValidatorHubHelper')

// A stand-in database handle. Never a real credential: the composition layer
// takes its connection details as arguments precisely so it can be driven with
// values like these.
const DB = { host: '127.0.0.1', port: '13307', user: 'root', pass: 'not-a-real-password' }

function hubSpec(over){
    return Object.assign({
        db: DB,
        dbName: 'XChain_AM_t_Hub0',
        apiPort: 41000,
        p2pPort: 41005,
        proxyPort: 41010,
        seedNodes: ['127.0.0.1:41011', '127.0.0.1:41012'],
        privkeyHex: 'ab'.repeat(32),
        network: 'regtest',
        hubCount: 5,
        oracleEpochStart: 1700000000000,
        btcIndexerApiUrl: 'http://localhost:3024',
        capabilityConfigPath: '/tmp/x/capabilities.json',
        forwardS: DEFAULT_FORWARD_S,
        batchWindowS: 30
    }, over || {})
}

function indexerSpec(over){
    return Object.assign({
        coin: 'BTC',
        network: 'regtest',
        apiPort: 41020,
        indexerDbName: 'XChain_AM_t_Ixr0',
        mirrorDbName:  'XChain_AM_t_Mirror0',
        hubApiUrl: 'http://127.0.0.1:41000',
        db: DB,
        decoder: { host: '127.0.0.1', port: 13306, name: 'XChain_BTC_Regtest_Decoder', user: 'dec', pass: 'not-a-real-password' },
        graces: { attestResponse: 0, price: 0, oracle: 0 }
    }, over || {})
}

describe('attestMirrorVenue: followed-hub assignment', function () {

    it('gives two indexers the two ENDS of a five-hub federation', () => {
        assert.deepStrictEqual(assignFollowedHubs(5, 2), [0, 4])
    })

    it('never gives two indexers the same hub, at any size it accepts', () => {
        for (let hubs = 1; hubs <= 9; hubs++) {
            for (let ixs = 1; ixs <= hubs; ixs++) {
                const followed = assignFollowedHubs(hubs, ixs)
                assert.strictEqual(followed.length, ixs)
                assert.strictEqual(new Set(followed).size, ixs,
                    hubs + ' hubs / ' + ixs + ' indexers collided: ' + followed.join(','))
                for (const h of followed) assert.ok(h >= 0 && h < hubs, 'hub index out of range: ' + h)
            }
        }
    })

    it('refuses more indexers than hubs rather than doubling them up', () => {
        // Two indexers on ONE hub is a venue that cannot ask the dissemination
        // question at all, and it would look exactly like a venue that can.
        assert.throws(() => assignFollowedHubs(2, 3), /cannot each follow a distinct hub/)
    })

    it('refuses a degenerate size', () => {
        assert.throws(() => assignFollowedHubs(0, 1), /must both be >= 1/)
        assert.throws(() => assignFollowedHubs(3, 0), /must both be >= 1/)
    })
})

describe('attestMirrorVenue: port planning', function () {
    this.timeout(20000)

    it('asks for three ports per hub plus one per indexer', () => {
        assert.strictEqual(portCount(5, 2), 17)
        assert.strictEqual(portCount(DEFAULT_HUB_COUNT, DEFAULT_INDEXER_COUNT), 17)
    })

    it('partitions one distinct list into four non-overlapping roles', () => {
        const ports = Array.from({ length: 17 }, (_, i) => 41000 + i)
        const plan  = planPorts(ports, 5, 2)
        assert.strictEqual(plan.hubApi.length, 5)
        assert.strictEqual(plan.p2p.length, 5)
        assert.strictEqual(plan.p2pProxy.length, 5)
        assert.strictEqual(plan.indexerApi.length, 2)
        const all = [].concat(plan.hubApi, plan.p2p, plan.p2pProxy, plan.indexerApi)
        assert.strictEqual(all.length, 17)
        assert.strictEqual(new Set(all).size, 17, 'a port was handed to two roles: ' + all.join(','))
    })

    it('refuses a list that already contains a duplicate', () => {
        // The failure this guards is silent at plan time and surfaces as one hub
        // dying on listen EADDRINUSE minutes later.
        const dupes = Array.from({ length: 17 }, (_, i) => 41000 + i)
        dupes[9] = dupes[3]
        assert.throws(() => planPorts(dupes, 5, 2), /duplicates/)
    })

    it('refuses a list that is too short instead of returning empty roles', () => {
        assert.throws(() => planPorts([41000, 41001], 5, 2), /need 17 ports/)
    })

    it('plans a collision-free venue out of really allocated ports', async () => {
        const eph  = ephemeralRange()
        const plan = planPorts(await pickFreePorts(portCount(5, 2), 41000), 5, 2)
        const all  = [].concat(plan.hubApi, plan.p2p, plan.p2pProxy, plan.indexerApi)
        assert.strictEqual(new Set(all).size, all.length)
        for (const p of all)
            assert.ok(p < eph.lo || p > eph.hi, 'venue was handed ephemeral port ' + p)
    })

    it('walks past a port something else is already holding', async () => {
        const base = 41500
        const blocker = net.createServer()
        await new Promise(r => blocker.listen(base, '127.0.0.1', r))
        try {
            const plan = planPorts(await pickFreePorts(portCount(2, 1), base), 2, 1)
            const all  = [].concat(plan.hubApi, plan.p2p, plan.p2pProxy, plan.indexerApi)
            assert.ok(!all.includes(base), 'planned onto the occupied port ' + base)
        } finally {
            await new Promise(r => blocker.close(r))
        }
    })
})

describe('attestMirrorVenue: hub environment', function () {

    it('points every peer at the DELAY PROXY, not at the hub\'s own P2P port', () => {
        // The proxy is what makes a gossip delay injectable without touching the
        // hub's HTTP surface. A hub advertising its real P2P port would be dialled
        // directly and the delay lever would be attached to nothing.
        const env = buildHubEnv(hubSpec())
        assert.strictEqual(env.P2P_VALIDATOR_ADDR, '127.0.0.1:41010')
        assert.strictEqual(env.P2P_PORT, '41005')
        assert.notStrictEqual(env.P2P_VALIDATOR_ADDR, '127.0.0.1:' + env.P2P_PORT)
    })

    it('supplies the signing key under the redaction-safe name only', () => {
        // Both names resolve, but setting both to different values is a hard error
        // in the hub, and the _SECRET spelling is the one an operator's redaction
        // filter catches.
        const env = buildHubEnv(hubSpec())
        assert.strictEqual(env.SIGNING_PRIVKEY_SECRET, 'ab'.repeat(32))
        assert.strictEqual(env.SIGNING_PRIVKEY_HEX, undefined)
        assert.strictEqual(env.HUB_DB_SECRET, DB.pass)
        assert.strictEqual(env.HUB_DB_PASS, undefined)
    })

    it('leaves the hub keyless and DECLARES it, which is what lets it boot', () => {
        // Validator mode with no key refuses to boot unless the posture is
        // declared; and an unset key is what leaves /hub-db/snapshot/* open to the
        // venue's own indexers.
        const env = buildHubEnv(hubSpec())
        assert.strictEqual(env.HUB_API_KEY, undefined)
        assert.strictEqual(env.HUB_ALLOW_UNAUTHENTICATED, 'true')
    })

    it('carries the regtest-only timing seams as plain integer spellings', () => {
        // The hub THROWS on regtest for anything that is not a non-negative
        // integer spelling, so a number formatted as '5e0' or '05' fails at boot.
        const env = buildHubEnv(hubSpec({ forwardS: 5, batchWindowS: 30 }))
        assert.strictEqual(env.ATTEST_RESPONSE_FORWARD_S_OVERRIDE, '5')
        assert.strictEqual(env.ATTEST_BATCH_WINDOW_S_OVERRIDE, '30')
        assert.ok(/^\d+$/.test(env.ATTEST_RESPONSE_FORWARD_S_OVERRIDE))
        assert.ok(/^\d+$/.test(env.ATTEST_BATCH_WINDOW_S_OVERRIDE))
    })

    it('names the network on both gates that read it', () => {
        const env = buildHubEnv(hubSpec())
        assert.strictEqual(env.HUB_NETWORK, 'regtest')
        assert.strictEqual(env.ORACLE_EPOCH_START, '1700000000000')
    })

    it('raises the per-IP connection cap above the mesh size', () => {
        // Every validator here shares 127.0.0.1; at the production default of 3 an
        // N>4 mesh starves and the symptom is one signature and no quorum, never a
        // connection error.
        const env = buildHubEnv(hubSpec({ hubCount: 5 }))
        assert.ok(parseInt(env.P2P_MAX_CONNECTIONS_PER_IP, 10) >= 5 * 4)
    })

    it('joins the seed list the way the hub parses it', () => {
        const env = buildHubEnv(hubSpec())
        assert.deepStrictEqual(env.SEED_NODES.split(',').filter(Boolean),
            ['127.0.0.1:41011', '127.0.0.1:41012'])
    })

    it('serialises an empty seed list to an empty string, not "undefined"', () => {
        // The inbound-only hub, whose delay is total precisely because it dials
        // nobody. 'undefined' here would become one bogus seed address.
        const env = buildHubEnv(hubSpec({ seedNodes: [] }))
        assert.strictEqual(env.SEED_NODES, '')
    })

    it('refuses to build an env that is missing a load-bearing field', () => {
        for (const key of ['dbName', 'apiPort', 'p2pPort', 'proxyPort', 'privkeyHex', 'network', 'db']) {
            const spec = hubSpec()
            delete spec[key]
            assert.throws(() => buildHubEnv(spec), new RegExp('missing required field ' + key),
                'buildHubEnv accepted a spec with no ' + key)
        }
    })
})

describe('attestMirrorVenue: indexer environment', function () {

    it('keeps the three databases distinct, which is the whole mirror topology', () => {
        // HUB_DB_* is this node's local MIRROR, not the hub's authoritative
        // database: hub_db_sync owns it and re-pages it, so pointing it upstream
        // puts the hub's own rows under a replication client that deletes them.
        const env = buildIndexerEnv(indexerSpec())
        assert.strictEqual(env.INDEXER_DB_NAME, 'XChain_AM_t_Ixr0')
        assert.strictEqual(env.HUB_DB_NAME,     'XChain_AM_t_Mirror0')
        assert.strictEqual(env.DECODER_DB_NAME, 'XChain_BTC_Regtest_Decoder')
        assert.strictEqual(new Set([env.INDEXER_DB_NAME, env.HUB_DB_NAME, env.DECODER_DB_NAME]).size, 3)
    })

    it('turns the mirror on and names the hub this indexer follows', () => {
        const env = buildIndexerEnv(indexerSpec({ hubApiUrl: 'http://127.0.0.1:41004' }))
        assert.strictEqual(env.HUB_DB_SYNC_ENABLED, 'true')
        assert.strictEqual(env.HUB_API_URL, 'http://127.0.0.1:41004')
    })

    it('gives two indexers two DIFFERENT hubs and two different mirrors', () => {
        // Same-hub or same-mirror indexers make every dissemination assertion
        // vacuous while still passing.
        const a = buildIndexerEnv(indexerSpec())
        const b = buildIndexerEnv(indexerSpec({
            apiPort: 41021, indexerDbName: 'XChain_AM_t_Ixr1', mirrorDbName: 'XChain_AM_t_Mirror1',
            hubApiUrl: 'http://127.0.0.1:41004'
        }))
        assert.notStrictEqual(a.HUB_API_URL,  b.HUB_API_URL)
        assert.notStrictEqual(a.HUB_DB_NAME,  b.HUB_DB_NAME)
        assert.notStrictEqual(a.INDEXER_DB_NAME, b.INDEXER_DB_NAME)
        assert.notStrictEqual(a.INDEXER_API_PORT, b.INDEXER_API_PORT)
    })

    it('sets all three mirror graces, defaulting each to zero', () => {
        const env = buildIndexerEnv(indexerSpec({ graces: undefined }))
        assert.strictEqual(env.HUB_SYNC_ATTEST_RESPONSE_GRACE_S, String(DEFAULT_GRACE_S))
        assert.strictEqual(env.HUB_SYNC_PRICE_GRACE_S,           String(DEFAULT_GRACE_S))
        assert.strictEqual(env.HUB_SYNC_ORACLE_GRACE_S,          String(DEFAULT_GRACE_S))
    })

    it('spells an explicit zero as "0" rather than dropping it', () => {
        // resolveWatermarkGrace treats an empty value as unset and falls back to
        // the frozen 120, so a grace that stringified to '' would silently restore
        // the two-minute wait this venue exists to remove.
        const env = buildIndexerEnv(indexerSpec({ graces: { attestResponse: 0, price: 0, oracle: 0 } }))
        for (const key of ['HUB_SYNC_ATTEST_RESPONSE_GRACE_S', 'HUB_SYNC_PRICE_GRACE_S', 'HUB_SYNC_ORACLE_GRACE_S']) {
            assert.strictEqual(env[key], '0')
            assert.ok(/^\d+$/.test(env[key]), key + ' must be a plain integer spelling, got ' + JSON.stringify(env[key]))
        }
    })

    it('honours a non-zero grace when a drill wants one', () => {
        const env = buildIndexerEnv(indexerSpec({ graces: { attestResponse: 7, price: 0, oracle: 0 } }))
        assert.strictEqual(env.HUB_SYNC_ATTEST_RESPONSE_GRACE_S, '7')
    })

    it('refuses to build an env that is missing a load-bearing field', () => {
        for (const key of ['coin', 'network', 'apiPort', 'indexerDbName', 'mirrorDbName', 'hubApiUrl', 'db', 'decoder']) {
            const spec = indexerSpec()
            delete spec[key]
            assert.throws(() => buildIndexerEnv(spec), new RegExp('missing required field ' + key),
                'buildIndexerEnv accepted a spec with no ' + key)
        }
    })
})

describe('attestMirrorVenue: the outside-the-responsible-set picker', function () {

    const indexers = [
        { index: 0, followsHub: 0, hubPubkey: 'aa'.repeat(32) },
        { index: 1, followsHub: 4, hubPubkey: 'bb'.repeat(32) }
    ]

    it('picks the indexer whose hub never ran the round', () => {
        const responsible = ['aa'.repeat(32), 'cc'.repeat(32), 'dd'.repeat(32)]
        assert.strictEqual(pickOutsideIndexer(indexers, responsible).index, 1)
    })

    it('compares pubkeys case-insensitively', () => {
        // The set arrives in three spellings across this codebase (registration,
        // the lower-cased ranking, and a mirror row's signer_pubkeys). A
        // case-sensitive compare reports EVERY indexer as outside the set, which
        // is a dissemination test that passes without testing anything.
        const responsible = ['AA'.repeat(32), 'CC'.repeat(32), 'DD'.repeat(32)]
        assert.strictEqual(pickOutsideIndexer(indexers, responsible).index, 1)
    })

    it('throws rather than returning null when every indexer is inside', () => {
        const responsible = ['aa'.repeat(32), 'bb'.repeat(32), 'cc'.repeat(32)]
        assert.throws(() => pickOutsideIndexer(indexers, responsible),
            /every indexer follows a hub inside the responsible set/)
    })

    it('refuses an empty responsible set instead of calling everything outside it', () => {
        assert.throws(() => pickOutsideIndexer(indexers, []), /empty responsible set/)
    })
})

describe('attestMirrorVenue: timing invariants', function () {
    // The two verdicts the guard branches on, built here rather than read off whichever
    // hub checkout happens to be resolvable. The wall-clock band is the value the hub
    // carried at the revision that keyed windows that way; pinning the arithmetic to a
    // literal is what keeps these cases meaningful in a checkout whose hub has moved.
    // resolveWindowKeying's own reading of a live hub is covered further down.
    const SIGNED = { key: WINDOW_KEY_SIGNED, boundarySkewS: null }
    const WALL   = { key: WINDOW_KEY_WALL_CLOCK, boundarySkewS: 5 }

    it('accepts the venue defaults, which is the combination every drill runs', () => {
        assert.doesNotThrow(() =>
            assertTimingInvariants(DEFAULT_FORWARD_S, DEFAULT_BATCH_WINDOW_S, SIGNED))
        assert.doesNotThrow(() =>
            assertTimingInvariants(DEFAULT_FORWARD_S, DEFAULT_BATCH_WINDOW_S, WALL))
    })

    it('refuses a forward margin at or below the gossip hop, naming both values', () => {
        // At the hop exactly, not merely below it: a row arriving the instant it becomes
        // applicable is already too late for the follower to bound it.
        for (const keying of [SIGNED, WALL]) {
            assert.throws(
                () => assertTimingInvariants(GOSSIP_HOP_BUDGET_S, DEFAULT_BATCH_WINDOW_S, keying),
                (e) => /refusing to boot/.test(e.message) &&
                       /ATTEST_RESPONSE_FORWARD_S_OVERRIDE=2s/.test(e.message) &&
                       /gossip hop/.test(e.message))
        }
    })

    it('says the margin also guards the co-signer rebuild, but only under signed keying', () => {
        // Under the signed key the margin is what gives a co-signer time to hold the same
        // rows the leader does when a window closes. The wall-clock hub has the band for
        // that, so its refusal must NOT claim the second reason.
        assert.throws(
            () => assertTimingInvariants(GOSSIP_HOP_BUDGET_S, DEFAULT_BATCH_WINDOW_S, SIGNED),
            /co-signer can rebuild a closing window/)
        assert.throws(
            () => assertTimingInvariants(GOSSIP_HOP_BUDGET_S, DEFAULT_BATCH_WINDOW_S, WALL),
            (e) => /refusing to boot/.test(e.message) && !/co-signer/.test(e.message))
    })

    it('refuses a window whose quarter-clamped completeness band falls under the hop', () => {
        // 4s window: the band clamps to floor(4/4) = 1s, under the 2s hop, so two hubs
        // straddling a boundary intermittently cost the window its quorum. This is the
        // exact shape that reads as a flaky AT5 rather than as a bad knob.
        assert.throws(
            () => assertTimingInvariants(DEFAULT_FORWARD_S, 4, WALL),
            (e) => /refusing to boot/.test(e.message) &&
                   /completeness band is min\(BOUNDARY_SKEW_S 5, floor\(4\/4\) = 1\) = 1s/.test(e.message) &&
                   /batchWindowS >= 8s/.test(e.message))
    })

    it('holds the band at the boundary window size rather than one either side of it', () => {
        // The rule is band >= hop, so at a 2s band (an 8s window) it passes and at 7s it
        // does not. Pinned because an off-by-one here is invisible until a drill flakes.
        assert.doesNotThrow(() => assertTimingInvariants(DEFAULT_FORWARD_S, 8, WALL))
        assert.throws(() => assertTimingInvariants(DEFAULT_FORWARD_S, 7, WALL),
            /refusing to boot/)
    })

    it('applies no band rule at all under signed keying, at any window size', () => {
        // The straddle the band forgives cannot happen when every hub reads the same signed
        // value, so a 1s window is legal there while it is refused under wall clock. This is
        // the case that would red if the band rule were left applying to both keyings, which
        // is exactly the defect that stopped the venue booting against the shipped hub.
        assert.doesNotThrow(() => assertTimingInvariants(DEFAULT_FORWARD_S, 1, SIGNED))
        assert.throws(() => assertTimingInvariants(DEFAULT_FORWARD_S, 1, WALL), /refusing to boot/)
    })

    it('refuses an absent boundary band under wall-clock keying rather than checking nothing', () => {
        // Under that keying the band is the whole of rule B, so a verdict that carries no
        // usable band must refuse rather than pass the window against nothing.
        for (const absent of [undefined, null, 0, NaN]) {
            assert.throws(
                () => assertTimingInvariants(DEFAULT_FORWARD_S, DEFAULT_BATCH_WINDOW_S,
                    { key: WINDOW_KEY_WALL_CLOCK, boundarySkewS: absent }),
                /boundarySkewS must be a positive number/)
        }
    })

    it('refuses a keying verdict it does not recognize rather than picking a rule', () => {
        // A third keying is not a missing detail: the guard would be judging a mechanism
        // the hub does not have. Includes the pre-rewrite call shape, a bare number, which
        // must not be read as a band any more.
        for (const bad of [undefined, null, 5, {}, { key: 'block_index' }, 'effective_time']) {
            assert.throws(
                () => assertTimingInvariants(DEFAULT_FORWARD_S, DEFAULT_BATCH_WINDOW_S, bad),
                /window keying must be the verdict of resolveWindowKeying/)
        }
    })

    it('refuses a non-positive or unset knob rather than treating it as zero', () => {
        for (const bad of [0, -1, undefined, null, NaN, 'soon']) {
            assert.throws(() => assertTimingInvariants(bad, DEFAULT_BATCH_WINDOW_S, SIGNED),
                /must be a positive number/)
            assert.throws(() => assertTimingInvariants(DEFAULT_FORWARD_S, bad, SIGNED),
                /must be a positive number/)
        }
    })
})

describe('attestMirrorVenue: reading the hub\'s window keying', function () {
    // The venue resolves ONE hub checkout, so the keyings it does not currently have are
    // reached by driving the resolver's decision against stand-in publisher shapes. The
    // real hub is then read for real in the last case, which is what ties the decision to
    // the code being driven rather than to these stand-ins.
    //
    // The clause has to be BAKED INTO the stand-in's source, not closed over: the resolver
    // reads the function's own text, and a closed-over variable leaves that text saying
    // `whereClause` and every stand-in looking identical.
    const publisherWith = (whereClause, extra) => Object.assign(
        function AttestationBatchPublisher() {}, extra || {},
        { prototype: { _selectWindowRows: new Function('a', 'b',
            'return this.q(' + JSON.stringify(whereClause) + ', [a, b])') } })

    it('reads the shipped hub and calls its window signed, with no band', () => {
        // The real module, not a stand-in: this is the case that failed before the rewrite,
        // when the resolver demanded a constant the hub had correctly deleted.
        const verdict = resolveWindowKeying()
        assert.strictEqual(verdict.key, WINDOW_KEY_SIGNED)
        assert.strictEqual(verdict.boundarySkewS, null)
    })

    it('refuses a publisher whose window read matches neither column', () => {
        assert.throws(() => resolveWindowKeyingFrom(publisherWith('WHERE network = ? AND id >= ?')),
            (e) => /refusing to boot/.test(e.message) && /matches neither/.test(e.message))
    })

    it('refuses a publisher whose window read matches both columns', () => {
        assert.throws(() => resolveWindowKeyingFrom(publisherWith(
            'WHERE finalized_at >= ? AND effective_time >= ?')),
            /matches both/)
    })

    it('reads the band only once the window read says wall clock', () => {
        const withBand = publisherWith('WHERE network = ? AND finalized_at >= ? AND finalized_at < ?',
            { BOUNDARY_SKEW_S: 5 })
        assert.deepStrictEqual(resolveWindowKeyingFrom(withBand),
            { key: WINDOW_KEY_WALL_CLOCK, boundarySkewS: 5 })

        // A signed-keying hub that still carries the constant is signed, not wall clock:
        // the read decides, not the leftover export.
        const signedWithStaleBand = publisherWith(
            'WHERE network = ? AND effective_time >= ? AND effective_time < ?', { BOUNDARY_SKEW_S: 5 })
        assert.strictEqual(resolveWindowKeyingFrom(signedWithStaleBand).key, WINDOW_KEY_SIGNED)
    })

    it('refuses a wall-clock publisher that exports no usable band', () => {
        assert.throws(() => resolveWindowKeyingFrom(publisherWith(
            'WHERE network = ? AND finalized_at >= ? AND finalized_at < ?')),
            (e) => /refusing to boot/.test(e.message) &&
                   /keys its batch window on finalized_at but exports no positive BOUNDARY_SKEW_S/.test(e.message))
    })
})

describe('attestMirrorVenue: the decoder credential', function () {
    // Saved and restored around each case: these are process-wide and a leak here would
    // silently change what a later case resolves.
    let savedUser, savedPass
    beforeEach(() => {
        savedUser = process.env.DECODER_DB_USER
        savedPass = process.env.DECODER_DB_PASS
        delete process.env.DECODER_DB_USER
        delete process.env.DECODER_DB_PASS
    })
    afterEach(() => {
        if (savedUser === undefined) delete process.env.DECODER_DB_USER
        else process.env.DECODER_DB_USER = savedUser
        if (savedPass === undefined) delete process.env.DECODER_DB_PASS
        else process.env.DECODER_DB_PASS = savedPass
    })

    // A coin/network pair with no sidecar on disk, so these cases exercise the oracle and
    // environment branches without depending on the checkout's own config files.
    const NO_SIDECAR = ['nosuchcoin', 'nosuchnet']

    it('refuses the hub oracle redaction sentinel instead of trying to authenticate with it', () => {
        // The failure this run actually hit. Passing '[redacted]' to MariaDB yields
        // ER_ACCESS_DENIED_ERROR, which reads as a rotated password and sends the reader
        // looking for a credential rotation that never happened.
        const out = resolveDecoderCredential(
            { user: 'xchain_decoder_x', pass: HUB_CONFIG_REDACTION }, ...NO_SIDECAR)
        assert.ok(out.problem, 'expected a refusal, got a credential from the sentinel')
        assert.match(out.problem, /redacts every password/)
        assert.match(out.problem, /DECODER_DB_PASS/)
        assert.strictEqual(out.pass, undefined, 'the sentinel must never be handed back as a password')
    })

    it('refuses an absent password the same way, rather than handing back undefined', () => {
        const out = resolveDecoderCredential({ user: 'xchain_decoder_x' }, ...NO_SIDECAR)
        assert.ok(out.problem)
        assert.strictEqual(out.pass, undefined)
    })

    it('prefers an explicit environment credential and says where it came from', () => {
        process.env.DECODER_DB_PASS = 'from-the-environment'
        const out = resolveDecoderCredential(
            { user: 'xchain_decoder_x', pass: HUB_CONFIG_REDACTION }, ...NO_SIDECAR)
        assert.strictEqual(out.pass, 'from-the-environment')
        assert.strictEqual(out.user, 'xchain_decoder_x')
        assert.match(out.source, /environment/)
    })

    it('lets the environment override the user as well as the password', () => {
        process.env.DECODER_DB_PASS = 'from-the-environment'
        process.env.DECODER_DB_USER = 'someone_else'
        const out = resolveDecoderCredential({ user: 'xchain_decoder_x' }, ...NO_SIDECAR)
        assert.strictEqual(out.user, 'someone_else')
    })

    it('ignores the environment credential entirely when it is not this coin\'s', () => {
        // A venue for a coin the harness .env does not describe (AT5's DOGE reader):
        // taking Bitcoin's decoder user there authenticates and then fails
        // ER_TABLEACCESS_DENIED on the other coin's database, which reads as a venue
        // that cannot start rather than as the wrong credential.
        process.env.DECODER_DB_PASS = 'from-the-environment'
        process.env.DECODER_DB_USER = 'someone_else'
        const out = resolveDecoderCredential(
            { user: 'xchain_decoder_x', pass: 'a-real-password' }, ...NO_SIDECAR, false)
        assert.strictEqual(out.user, 'xchain_decoder_x')
        assert.strictEqual(out.pass, 'a-real-password')
        assert.match(out.source, /config oracle/)
    })

    it('uses an unredacted oracle password when one is genuinely served', () => {
        // Not dead code: a hub configured without redaction, or a future one that serves
        // credentials to authenticated callers, must still work.
        const out = resolveDecoderCredential(
            { user: 'xchain_decoder_x', pass: 'a-real-password' }, ...NO_SIDECAR)
        assert.strictEqual(out.pass, 'a-real-password')
        assert.match(out.source, /config oracle/)
    })

    it('names the missing sidecar in the refusal so the reader knows which store to fix', () => {
        const out = resolveDecoderCredential(
            { user: 'xchain_decoder_x', pass: HUB_CONFIG_REDACTION }, ...NO_SIDECAR)
        assert.match(out.problem, /no nosuchcoin-nosuchnet\.local config sidecar was found/)
    })
})

describe('attestMirrorVenue: the llm precondition', function () {
    // The two halves live in different places and a box can have exactly one, which is
    // why the refusal has to say WHICH. Both probes are injected so these cases describe
    // boxes this run is not on.
    const OK = {
        dirExists: () => true,
        isExecutable: (p) => p === '/opt/venue-fixture/bin/claude'
    }
    const SPEC = { claudeConfigDir: '/opt/venue-fixture/creds', pathEnv: '/usr/bin:/opt/venue-fixture/bin' }

    it('passes when both halves are present', () => {
        assert.doesNotThrow(() => assertLlmAvailable(SPEC, OK))
    })

    it('names the CREDENTIAL half when only the directory is missing', () => {
        const probes = Object.assign({}, OK, { dirExists: () => false })
        assert.throws(() => assertLlmAvailable(SPEC, probes), (e) => {
            assert.match(e.message, /1 of the 2 halves/)
            assert.match(e.message, /credential directory \/opt\/venue-fixture\/creds does not exist/)
            assert.ok(!/claude` binary is not executable/.test(e.message),
                'it blamed the PATH as well, which sends the reader in the wrong direction')
            return true
        })
    })

    it('names the PATH half when only the binary is missing, and shows the PATH searched', () => {
        const probes = Object.assign({}, OK, { isExecutable: () => false })
        assert.throws(() => assertLlmAvailable(SPEC, probes), (e) => {
            assert.match(e.message, /1 of the 2 halves/)
            assert.match(e.message, /binary is not executable on the PATH THE HUBS WILL RECEIVE/)
            assert.match(e.message, /usr\/bin:\/opt\/venue-fixture\/bin/)
            assert.ok(!/does not exist ON THIS BOX/.test(e.message),
                'it blamed the credentials as well, which is the exact confusion this avoids')
            return true
        })
    })

    it('names BOTH when neither is present', () => {
        assert.throws(
            () => assertLlmAvailable(SPEC, { dirExists: () => false, isExecutable: () => false }),
            /2 of the 2 halves/)
    })

    it('refuses an unconfigured credential directory rather than falling back to an interactive one', () => {
        // The venue must never inherit whichever store the operator happens to be logged
        // into, so an absent config is its own named failure and not a default.
        assert.throws(
            () => assertLlmAvailable({ claudeConfigDir: null, pathEnv: SPEC.pathEnv }, OK),
            /no credential directory is configured/)
    })

    it('searches PATH entries in order and tolerates a trailing slash', () => {
        const probes = { dirExists: () => true, isExecutable: (p) => p === '/opt/bin/claude' }
        assert.doesNotThrow(() =>
            assertLlmAvailable({ claudeConfigDir: '/d', pathEnv: '/usr/bin:/opt/bin/' }, probes))
    })

    it('reports an empty PATH as empty rather than as a mysterious absence', () => {
        assert.throws(
            () => assertLlmAvailable({ claudeConfigDir: '/d', pathEnv: '' }, OK),
            /<empty>/)
    })
})

describe('attestMirrorVenue: mirror barrier graces', function () {
    // The barriers sit in sequence in ONE block loop, so the first one whose grace is
    // not turned down parks the block and every barrier after it is never reached.
    // Turning down a subset is therefore not a partial win, it is a wedge, and it made
    // the attest-response barrier unobservable behind anchor_attest_barrier.
    const { HUB_SYNC_WATERMARK_GRACE_S } =
        require('../../../../xchain-indexer/src/hub_db_sync.js')

    function indexerEnv(graces) {
        return buildIndexerEnv({
            coin: 'bitcoin', network: 'regtest', apiPort: 61015,
            indexerDbName: 'XChain_AM_MVH_x_Ixr0', mirrorDbName: 'XChain_AM_MVH_x_Mirror0',
            hubApiUrl: 'http://127.0.0.1:61000',
            db: { host: '127.0.0.1', port: 13306, user: 'u', pass: 'p' },
            decoder: { host: '127.0.0.1', port: 13306, name: 'D', user: 'du', pass: 'dp' },
            graces: graces
        })
    }

    it('zeroes EVERY barrier the indexer has a grace for, not a hand-listed subset', () => {
        const env = indexerEnv(undefined)
        const missing = []
        for (const barrier of Object.keys(HUB_SYNC_WATERMARK_GRACE_S)) {
            const key = 'HUB_SYNC_' + barrier.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase() + '_GRACE_S'
            if (env[key] === undefined) missing.push(barrier + ' (' + key + ')')
            else assert.strictEqual(env[key], '0', key + ' is ' + env[key] + ' rather than 0')
        }
        assert.deepStrictEqual(missing, [],
            'these barriers get no grace override, so the first of them parks every block ' +
            'and the barriers after it are never reached: ' + missing.join(', '))
    })

    it('covers the barriers that were previously missed by name', () => {
        // Named explicitly because these three are the ones that were left frozen, and a
        // generated set that silently stopped covering them would otherwise pass.
        const env = indexerEnv(undefined)
        for (const key of ['HUB_SYNC_ANCHOR_ATTEST_GRACE_S', 'HUB_SYNC_MATCH_GRACE_S',
                           'HUB_SYNC_CALL_GRACE_S']) {
            assert.strictEqual(env[key], '0', key + ' must be turned down on the venue')
        }
    })

    it('still lets one barrier be overridden by name without disturbing the others', () => {
        const env = indexerEnv({ attestResponse: 7 })
        assert.strictEqual(env.HUB_SYNC_ATTEST_RESPONSE_GRACE_S, '7')
        assert.strictEqual(env.HUB_SYNC_ANCHOR_ATTEST_GRACE_S, '0')
    })
})

describe('attestMirrorVenue: database naming', function () {
    // The hub account's CREATE grant is `XChain\_%\_MVH\_%` and nothing else. A name
    // outside it fails at the first CREATE DATABASE on a live venue and in no pure test,
    // so the pattern is asserted here in the same shape MariaDB matches it.
    it('produces names the pattern-restricted CREATE grant actually admits', () => {
        const grant = /^XChain_.*_MVH_.*$/
        for (const suffix of ['Hub0', 'Ixr1', 'Mirror1']) {
            const name = DB_PREFIX + 'smoke_12345_abc_' + suffix
            assert.ok(grant.test(name), name + ' is outside the granted pattern')
            assert.ok(/^[A-Za-z0-9_]+$/.test(name), name + ' is not a plain identifier')
        }
    })
})

describe('attestMirrorVenue: coin codes', function () {
    it('maps the three chains the venue can index', () => {
        assert.strictEqual(coinCode('bitcoin'),  'BTC')
        assert.strictEqual(coinCode('litecoin'), 'LTC')
        assert.strictEqual(coinCode('dogecoin'), 'DOGE')
    })
})
