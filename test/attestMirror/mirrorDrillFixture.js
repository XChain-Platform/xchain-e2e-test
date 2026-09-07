'use strict'

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
 * The prologue every attest-mirror drill needs before it has a venue.
 *
 * WHY THIS IS NOT A METHOD ON THE VENUE. `AttestMirrorVenue` takes
 * `opts.identities` and expects them to be selectable already, so the order is
 * forced: identities resolved first, venue second. A helper hanging off the
 * venue could not run early enough to matter. This is the thing you call to GET
 * a venue, not a thing you call on one.
 *
 * THIS MODULE NO LONGER STAKES ANYTHING, and that reversal is the most
 * expensive lesson the ladder has. Staking five fresh identities per run, on
 * the belief that a well-funded venue would win the draw, is what this refuses. Stake does not
 * work that way: `AttestationRound._computeResponsibleSet` uses stake as a
 * PRE-FILTER and then ranks by `sha256(requestId || pubkey)`, so staking
 * alongside a standing roster never buys selection priority, it only DILUTES the
 * pool with keys whose hubs are not in this mesh. Five AT1 drives died of it,
 * every one presenting as "the mirror produced no row", which sent the
 * investigation to the mirror instead of to the roster. The operator's ruling of
 * 2026-09-04 replaced it: no provider floor, no new stake, the venue RUNS AS THE
 * ROSTER.
 *
 * So the surviving non-obvious failure modes are these:
 *
 *   - A SEATED KEY WITH NO LIVE HUB IS FATAL, not merely unlucky.
 *     `AttestationConsensus` needs `max(quorum, redundancy)` valid signatures
 *     with the quorum measured over the PRE-widening set size, and
 *     `_handleCommit` accepts signatures only from responsible-set members. At
 *     redundancy 3 that is three signatures from the three drawn members, so one
 *     drawn member without a signer stalls the round to timeout. Wherever
 *     redundancy equals the whole live set, one orphaned seated key is not a
 *     probability, it is a guarantee of failure for every draw containing it.
 *     `provisionDrillIdentities` refuses rather than running that lottery.
 *   - The PROVIDER floor filters the seated set per provider BEFORE the ranking,
 *     and the two providers do not share a floor: `http_get` is 10000 and `llm`
 *     is 25000 (ProviderRegistry.js DEFAULTS). Filtering only ever removes
 *     members, so it cannot introduce a foreign one, but it can shrink the set
 *     below redundancy, and then the round is skipped as unfinalizable and the
 *     request expires at its deadline with nothing anywhere near the floor that
 *     caused it.
 *   - Fund and mint without letting the stack settle in between and the
 *     encoder's `unconfirmed=false` UTXO lookup intermittently crashes against
 *     a mid-batch tracker. That one reads as flake rather than as ordering.
 *
 * Every drill here runs against the STANDING regtest chain, which is the only
 * chain there is: the venue borrows it. Two live venues would run hubs for the
 * SAME roster identities and be each other's equivocation, so drills using this
 * fixture must be serialized, not parallelized, and a roll-call drive must not
 * overlap one either.
 *
 * The harness globals (`indexerDatabase`, `indexerConnector`,
 * `regtestMinerConnector`, `utxoTrackerConnector`, `COIN`, `NETWORK`) come from
 * `test/initialCheck.test.js`, which mocha loads with --require. Same
 * convention as the federation drills.
 ********************************************************************/

const assert = require('assert')
const crypto = require('crypto')
const fsx    = require('fs')
const pathx  = require('path')

const cryptoHelper = require('../cryptoHelper')
const stakeHelper  = require('../helpers/stakeHelper')
const gasHelper    = require('../helpers/gasHelper')
const vmHelper     = require('../helpers/vmHelper')
const { loadHubModule } = require('../helpers/multiValidatorHubHelper')
const xchainPrice = require('../helpers/xchainPriceConstants')

// How many idle-key generations to sweep when matching a seated key to a seed
// this harness can sign for.
//
// A SWEEP RATHER THAN A CONFIGURED NUMBER, deliberately. The generation is a
// ROLL-CALL-side rotation counter: that ladder bumps it whenever it burns a key,
// and this lane is never told. A stale configured number derives a real, valid,
// WRONG identity, which fails at the dissemination assertion instead of here.
// Matching on the resulting PUBKEY is the only comparison that cannot go stale,
// and the sweep is a handful of local hashes.
const IDLE_GENERATION_SCAN = 32

// The coin price the harness prices its own fees against, and the band a venue
// price must fall in to be usable. The band is wide on purpose: the drill does
// not care what the price IS, only that both nodes compute comparable fees from
// it, and a venue oracle that is out by two orders of magnitude is not that.
// How far the indexer may trail the node before `mineWhile` stops adding blocks.
// Small on purpose: that loop exists to keep an idle chain moving, not to drive it.
const MINE_WHILE_MAX_LAG = 3

const CANONICAL_COIN_USD = 100000
const PRICE_TOLERANCE    = 10

// Where a drill's staker keys are kept so a stake is always releasable.
//
// WHY THIS EXISTS, and it is not hypothetical. `cryptoHelper` keeps its wallets
// in a module-level object with no persistence, so a labelled address is NOT
// reproducible in a later process: the same label returns a NEW mnemonic. When
// AT1's teardown ran out of budget mid-release against a wedged indexer, two
// stakes were left in the shared capability set and their signing keys had
// already died with the run, so nothing could unstake them. They are still
// there. An unstake must be signed by the staking address, so losing the key
// makes the leak PERMANENT for anyone without venue-admin reach.
//
// The file is 0600 and gitignored. These are throwaway regtest mnemonics, but
// they are credentials, and the rule that applies is the one about generated
// credentials being stewarded rather than orphaned: whatever generates a key is
// responsible for it being readable back by whoever has to clean up.
const DRILL_KEYS_DIR = pathx.resolve(__dirname, '../../drill-keys')

/**
 * Record one staker's key material so a failed teardown stays recoverable.
 *
 * Written BEFORE the stake is broadcast, never after: a key recorded after a
 * successful stake is exactly the key you do not have when the stake succeeded
 * and the process then died.
 */
function recordStakerKey (label, entry) {
    try {
        fsx.mkdirSync(DRILL_KEYS_DIR, { recursive: true, mode: 0o700 })
        const file = pathx.join(DRILL_KEYS_DIR, label + '.json')
        let all = []
        try { all = JSON.parse(fsx.readFileSync(file, 'utf8')) } catch (_) { all = [] }
        all.push(entry)
        fsx.writeFileSync(file, JSON.stringify(all, null, 1), { mode: 0o600 })
        fsx.chmodSync(file, 0o600)
        return file
    } catch (e) {
        // Never fail a drill over bookkeeping, but do not let it pass silently
        // either: the whole point is that someone can clean up afterwards.
        console.log('mirrorDrillFixture: WARNING could not record staker keys for ' + label +
            ' (' + (e && e.message) + '). A teardown that cannot finish will strand its stakes.')
        return null
    }
}

/**
 * Wait until the mempool is empty and the tracker has caught up.
 *
 * Between every fund and the mint that spends it: the encoder looks up UTXOs
 * with `unconfirmed=false`, so a tracker mid-batch hands it a view that is
 * neither the confirmed set nor the mempool set.
 */
async function settleStack () {
    // INSPECT THE RESULT. `quiesce` is a barrier whose failure is a RETURN VALUE,
    // not a throw: on timeout it returns the last status with `ready: false`, and
    // its own body says callers that are a barrier rather than a retry loop must
    // check `.ready`. Discarding it made thirty seconds of NON-settlement resolve
    // as success, which is precisely the ordering failure this function exists to
    // prevent and which the header above warns about: the encoder looks up UTXOs
    // with `unconfirmed=false`, so acting on an unsettled tracker produces the
    // intermittent mid-batch crash that reads as flake.
    //
    // WARNS RATHER THAN THROWS, deliberately. What was missing here was
    // VISIBILITY, not severity: an unsettled tracker often still works, and
    // failing the drill on it would trade a rare wrong answer for a common
    // spurious failure. The next step's own wait is what enforces correctness.
    const status = await utxoTrackerConnector.quiesce({
        timeoutMs: 30000, pollMs: 250, regtestMiner: regtestMinerConnector,
    })
    if (status && status.ready === false) {
        console.log('mirrorDrillFixture: WARNING the tracker did NOT settle within 30000ms ' +
            '(quiesce returned ready:false' +
            (status.height !== undefined ? ', height ' + status.height : '') +
            (status.lag !== undefined ? ', lag ' + status.lag : '') +
            '). The next step acts on a mid-batch tracker, so an encoder UTXO lookup ' +
            'failing right after this is ordering rather than flake.')
    }
    return status
}

/**
 * How far past a stake a request must sit before the stake is selectable.
 *
 * Returns `stakeHelper.ATTESTATION_STAKE_VISIBLE_BLOCKS` rather than deriving a
 * second answer, because every other drill in this suite waits that many blocks
 * and two derivations of one consensus distance is the fork this fixture exists
 * to prevent.
 *
 * It is CHECKED rather than trusted, though, and that is the point of the
 * function. The shared constant is a literal (6 activation + 6 burial + 2
 * margin) while only the burial half is a source constant: the activation half
 * lives under `config['STAKING'].ACTIVATION_DELAY_BLOCKS` and is calibrated per
 * chain. So on a chain configured differently the literal is quietly too small,
 * and too small does not fail as a missing stake, it fails as a wrong
 * responsible set. Comparing the two here turns that into a refusal with the
 * numbers in it.
 */
function stakeVisibilityBlocks (coin, network) {
    // The harness's COIN global is the FULL NAME ('bitcoin'), while the registry
    // is keyed by TICKER ('BTC'), so a caller passing COIN straight through asks
    // the registry for 'BITCOIN' and gets refused. Accept either and translate
    // through the registry's own map rather than a second table here.
    const registry = loadHubModule('src/coins/index.js')
    const raw  = String(coin || 'BTC').toUpperCase()
    const tick = registry.FULL_NAME_TO_TICK
        ? (registry.FULL_NAME_TO_TICK[raw] || registry.FULL_NAME_TO_TICK[raw.toLowerCase()] || raw)
        : raw
    const net  = String(network || 'regtest')
    const shared = Number(stakeHelper.ATTESTATION_STAKE_VISIBLE_BLOCKS)
    const burial = Number(loadHubModule('src/snapshot_reorg_buffer.js').CANONICAL_REORG_BUFFER)

    // The COINS REGISTRY is where this actually lives, not a config module:
    // ACTIVATION_DELAY_BLOCKS is nested under the coin's STAKING block and is
    // BTC 6 / LTC 24 / DOGE 60, which is the whole reason it cannot be assumed.
    // Every consumer resolves it nested-first (db.js:2881, rollback.js:614,
    // delegate.js, stake.js), so this reads the same place they do.
    let activation = null
    try {
        const staking = registry.getCoinConfig(tick, net).STAKING
        activation = staking && Number(staking.ACTIVATION_DELAY_BLOCKS)
    } catch (e) {
        assert.fail('mirrorDrillFixture: could not read STAKING.ACTIVATION_DELAY_BLOCKS for ' +
            tick + '/' + net + ' from the coins registry (' + (e && e.message) + '). It is calibrated ' +
            'per chain and guessing it is what this function exists to prevent.')
    }

    assert.ok(Number.isFinite(burial) && burial > 0,
        'mirrorDrillFixture: CANONICAL_REORG_BUFFER did not resolve to a positive number (got ' +
        burial + '); the visibility distance cannot be checked against anything')
    assert.ok(Number.isFinite(activation) && activation > 0,
        'mirrorDrillFixture: STAKING.ACTIVATION_DELAY_BLOCKS did not resolve to a positive number (got ' +
        activation + '); it is calibrated per chain and must not be assumed')

    assert.ok(shared >= activation + burial,
        'mirrorDrillFixture: this chain needs ' + activation + ' activation + ' + burial +
        ' burial = ' + (activation + burial) + ' blocks before a stake is selectable, but the shared ' +
        'ATTESTATION_STAKE_VISIBLE_BLOCKS is ' + shared + '. Mining the smaller number does not fail as a ' +
        'missing stake: the responsible set comes back smaller than REDUNDANCY, the request is rejected at ' +
        'admission, and the EXECUTE that emitted it rolls back with no valid execution row, nowhere near ' +
        'the stake. Raise the shared constant rather than working around it here.')

    return shared
}


/**
 * Mint `count` validator identities, stake each one, and mine until every stake
 * is selectable by a request.
 *
 * The identities are returned in the shape `AttestMirrorVenue` wants for
 * `opts.identities`, so the caller's next line is the venue constructor.
 *
 * @param {object}  opts
 * @param {string}  opts.label     short drill label, used in funded-address names
 * @param {number} [opts.count]    identities to mint (default 5, the venue's hub count)
 * @param {string} [opts.amount]   stake per identity
 * @param {string} [opts.coinTick] coin ticker for the visibility check (default the harness COIN)
 * @param {string} [opts.network]  network for the visibility check (default the harness NETWORK)
 * @returns {Promise<{identities: Array, stakers: Array, visibilityBlocks: number}>}
 */
/**
 * Run one prologue step, and if the roll-call wedge is what killed it, clear the
 * wedge and run it once more.
 *
 * WHY THIS EXISTS. Two AT1 drives died here on 2026-09-04 without reaching a
 * single assertion, and neither failure was the step's own: the BTC indexer was
 * parked on `rollcall_proof_unavailable` behind its own decoder, so the row the
 * step waits for could not land and the helper timed out. The wedge is NOT
 * wall-clock idleness. A drill mines BTC hard (3862 to 3891 in two minutes in
 * that run) while the DOGE tip sits still, the roll-call epoch cannot be decided
 * until DOGE passes the window end, and so the wedge RECURS mid-drill. It hit
 * that drive twice.
 *
 * The drills of the other lane survive this because their waits go through
 * `untilOrClearDogeStall`. The prologue cannot: its waits are inside the SHARED
 * harness helpers (`ensureGasBalance`, `sendStakeV1`, `sendDeployV0`), which are
 * every e2e drill's code and not this spec's to re-plumb. So the clear is applied
 * AROUND those calls instead, which fixes it for both lanes, since the other
 * lane's drills reach the same helpers through this fixture.
 *
 * DELIBERATELY NOT A BACKGROUND WATCHDOG, and this is the part to not "improve"
 * later: `mineDogeBlocks` goes through `chainRail`, which SWAPS the harness
 * globals to Dogecoin and restores them afterwards. A timer firing that while
 * `sendStakeV1` is mid-flight on the BTC globals would corrupt the run it is
 * supposed to protect. Retrying strictly BETWEEN operations is what makes the
 * rail switch safe.
 *
 * Nudges only when the node is actually behind its decoder, never on a schedule,
 * so a batch-window drill is not handed a continuously advancing DOGE tip.
 */
/**
 * Is the standing indexer parked on the roll-call wedge right now?
 *
 * Split out so it can be asked BEFORE a broadcast as well as after a failure.
 * Returns the probe sample when wedged and null otherwise, never throws.
 */
async function _wedgeSample () {
    const waits = require('./mirrorDrillWaits')
    let sample = null
    try { sample = await waits.standingTipProbe()() } catch (_) { return null }

    const behind = sample && Number.isFinite(Number(sample.height)) &&
        Number.isFinite(Number(sample.decoder)) && Number(sample.height) < Number(sample.decoder)
    const rollcall = sample && String(sample.reason || '') === 'rollcall_proof_unavailable'

    // Both conditions, not either. Behind-its-decoder alone is a node merely
    // draining, which needs no help and would mine DOGE for nothing.
    return (behind && rollcall) ? sample : null
}

/**
 * Clear the wedge BEFORE a broadcast, and never retry one.
 *
 * THIS EXISTS BECAUSE `withWedgeClear` IS ONLY SAFE AROUND IDEMPOTENT WORK, and
 * a broadcast-and-wait is not idempotent. `sendStakeV1` and `sendDeployV0` both
 * broadcast a transaction and THEN wait for the indexer to record it, so a wedge
 * fails the WAIT with the transaction already on the chain. Retrying that emits
 * a SECOND transaction: a double stake, or two contracts where the drill assumes
 * one, and the drill then measures something it never meant to create. A double
 * stake stays recoverable (UNSTAKE v0 sweeps every active row for a pubkey) but
 * a drill silently holding more stake than it staked is a corrupted measurement,
 * which is worse than a clean failure.
 *
 * So for those calls the wedge is cleared FIRST and the broadcast happens ONCE.
 * A wedge that forms during the wait still fails the drill, and that is the
 * correct trade: a clean failure beats a measurement nobody can trust.
 *
 * THE FUNDING AND GAS CALLS KEEP THEIR RETRY, on the ground that a re-broadcast
 * there is waste rather than wrongness: funding hits the same label-keyed
 * address, and an extra mint is gas nothing asserts on. Note that
 * `ensureGasBalance` does NOT check a balance first despite its name
 * (`gasHelper.js:28` mints unconditionally, justified by a comment that is sound
 * for a fresh run and false under retry), so the extra mint really does happen.
 *
 * THAT "WASTE, NOT WRONG" IS CONDITIONAL AND WORTH RE-CHECKING, not a permanent
 * property. Extra minted gas changes balances, and `balances_root` is one of the
 * signed roots the drills compare. It is safe today only because those
 * comparisons are between the two indexers AT THE SAME BLOCK, where both see the
 * same mints, rather than against a fixed expected value. The moment any drill
 * asserts a root or a balance against a FIXED expectation, a retried mint stops
 * being waste and becomes wrong, and these four sites have to move to pre-clear
 * only, like the two below.
 */
async function clearWedgeBefore (what) {
    const sample = await _wedgeSample()
    if (!sample) return false

    const waits = require('./mirrorDrillWaits')
    console.log('mirrorDrillFixture: clearing the roll-call wedge before ' + what +
        ' (standing indexer at ' + sample.height + ' behind its decoder at ' + sample.decoder +
        ' on ' + sample.reason + '). Cleared BEFORE the broadcast because this step cannot ' +
        'safely be retried once its transaction is out.')
    await waits.mineDogeBlocks(waits.DOGE_NUDGE_BLOCKS)
    return true
}

async function withWedgeClear (what, fn) {
    // BOTH PROTECTIONS, because they cover different failures and neither
    // subsumes the other. The pre-clear handles a wedge that already EXISTS when
    // the call starts; the retry handles one that FORMS DURING the wait, which is
    // not theoretical here, since the wedge re-forms every 25 to 30 blocks of BTC
    // mining and a mint-and-wait can easily span that. Pre-clearing alone would
    // leave these sites dying on a mid-wait wedge with no recovery, which is the
    // failure that has cost this ladder the most runs.
    await clearWedgeBefore(what)
    try {
        return await fn()
    } catch (err) {
        // Lazy require: mirrorDrillWaits requires THIS module at its top level,
        // so a top-level require here would close the cycle.
        const waits = require('./mirrorDrillWaits')
        const sample = await _wedgeSample()

        // Not the wedge: the original error is the real one and must escape
        // unchanged rather than be retried into a second, more confusing failure.
        if (!sample) throw err

        console.log('mirrorDrillFixture: ' + what + ' failed with the standing indexer at ' +
            sample.height + ' behind its decoder at ' + sample.decoder + ' on ' + sample.reason +
            '. That is the roll-call wedge, not this step. Mining DOGE and retrying once.')

        await waits.mineDogeBlocks(waits.DOGE_NUDGE_BLOCKS)
        return await fn()
    }
}

/**
 * The HTTPS server the `http_get` drills point a request at, plus the hub
 * environment that makes the real provider willing to fetch it.
 *
 * WHY THIS IS NOT `http.createServer`, WHICH ALL SEVEN DRILLS WOULD OTHERWISE
 * REACH FOR AND WHY ALL SEVEN WOULD FAIL IDENTICALLY. The provider refuses a
 * non-https payload outright (`http_get.js`: "only https:// URLs allowed"),
 * before any network work, so a plain-HTTP test server does not make the drill
 * slow or flaky, it makes the round resolve `provider_error` every single time.
 * That is not a mirror failure and it is not a roster failure, but it presents
 * as one: the round finalizes a non-ok status or nothing at all, no mirror row
 * with status `ok` ever appears, and the drill reports "0 mirror rows" exactly
 * as a genuine dissemination fault would. Measured on the venue 2026-09-04, hub
 * 0's own log: "fetch failed ... only https:// URLs allowed", then "[FOLLOWER]
 * proposing (provider=http_get, status=provider_error)".
 *
 * THE OLDER FEDERATION DRILL'S SOLUTION DOES NOT TRANSFER, which is worth saying
 * because it is the first place anyone will look:
 * `multiHubAttestationWeighted` monkey-patches `providerRegistry`'s `http_get`
 * module to accept its http URL. That works only because those hubs run
 * IN-PROCESS. This venue spawns hubs as separate PROCESSES, so there is no
 * object to patch, and reaching for that pattern here wastes a run.
 *
 * SO THE DRILL SERVES REAL TLS, which is also the better test: the provider's
 * actual TLS path runs rather than being stubbed past. A throwaway certificate
 * is minted per run, trusted by the hubs through `NODE_EXTRA_CA_CERTS`, and
 * thrown away with the run. Nothing is weakened: the certificate is a
 * short-lived local file, and the hub keeps its https-only rule intact.
 *
 * `ATTESTATION_HTTP_GET_ALLOW_PRIVATE` is needed as well and is NOT part of this
 * workaround: 127.0.0.1 is a forbidden address to the provider's SSRF guard, and
 * that hatch is the hub's own regtest-gated seam for exactly this, ignored with
 * a warning on any other network. Any local test server needs it whatever scheme
 * it speaks.
 *
 * @param {object} opts
 * @param {string} [opts.body]    the exact body to serve, byte for byte
 * @param {string} [opts.path]    the path to answer on (default '/score')
 * @param {function} [opts.handler] a full (req, res) handler, for a drill whose
 *                                body must vary per request; overrides `body`
 * @returns {Promise<{url, certPath, dir, hubEnv, close}>}
 */
async function startAttestTestServer (opts) {
    const o    = opts || {}
    const body = String(o.body === undefined ? '{}' : o.body)
    const urlPath = String(o.path || '/score')
    const handler = typeof o.handler === 'function' ? o.handler : null

    const https = require('https')
    const os    = require('os')
    const { execFileSync } = require('child_process')

    const dir = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'xchain-attest-tls-'))
    const keyPath  = pathx.join(dir, 'key.pem')
    const certPath = pathx.join(dir, 'cert.pem')

    // CA:TRUE and an IP SAN, both load-bearing. The certificate is handed to the
    // hubs as a trust ROOT, so a leaf without CA:TRUE is rejected as a self
    // signed certificate; and the provider connects to a bare IP, which is
    // matched against IP SANs only, never against the common name.
    try {
        execFileSync('openssl', [
            'req', '-x509', '-newkey', 'rsa:2048',
            '-keyout', keyPath, '-out', certPath,
            '-days', '1', '-nodes', '-subj', '/CN=127.0.0.1',
            '-addext', 'subjectAltName=IP:127.0.0.1',
            '-addext', 'basicConstraints=critical,CA:TRUE',
            '-addext', 'keyUsage=critical,digitalSignature,keyCertSign',
            '-addext', 'extendedKeyUsage=serverAuth',
        ], { stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (e) {
        // REFUSE rather than fall back to http. A fallback would produce exactly
        // the provider_error this function exists to prevent, one layer further
        // from the cause.
        throw new Error('mirrorDrillFixture: could not mint a throwaway TLS certificate with openssl ' +
            '(' + (e && e.message) + '). The http_get provider refuses non-https payloads, so there ' +
            'is no usable fallback: every round would resolve provider_error and read as a missing ' +
            'mirror row. Install openssl on this box or run the drill where it exists.')
    }

    const server = https.createServer(
        { key: fsx.readFileSync(keyPath), cert: fsx.readFileSync(certPath) },
        handler || ((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(body)
        }))

    const port = await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => resolve(server.address().port))
    })

    return {
        url:      'https://127.0.0.1:' + port + urlPath,
        certPath: certPath,
        dir:      dir,
        // Handed to the venue as `hubExtraEnv`. NODE_EXTRA_CA_CERTS is read once
        // at process start, which is why it has to reach the hub's spawn env
        // rather than being set here.
        hubEnv: {
            NODE_EXTRA_CA_CERTS: certPath,
            ATTESTATION_HTTP_GET_ALLOW_PRIVATE: '1',
        },
        close: async () => {
            await new Promise((resolve) => server.close(() => resolve()))
            try { fsx.rmSync(dir, { recursive: true, force: true }) } catch (_) { /* tmp */ }
        },
    }
}

/**
 * Hold until every venue indexer has caught the chain, BEFORE any request is
 * made, mining nothing while it waits.
 *
 * THIS IS THE BARRIER THE WHOLE LADDER WAS MISSING, and its absence is what
 * every "not applied" reading in this spec has actually been. The venue builds
 * FRESH indexer databases each run and replays the borrowed chain from its start
 * height, so at the moment `start()` returns they are hundreds or thousands of
 * blocks behind the tip. A drill that then makes a request at the tip is asking
 * a node about a block it has not reached: the mirror row is delivered, valid
 * and applicable, and the applier is never offered it, which surfaces as
 * `applied [null,null]` and reads exactly like a broken applier. Measured
 * 2026-09-04: the venue indexers ran 3249 to 4253 across a twenty-minute drill
 * whose request sat at 5577.
 *
 * MINING WHILE WAITING IS THE TRAP, so this refuses to do it and callers must
 * not either. These indexers parse roughly fifty blocks a minute; every mined
 * block is one more they must chase, so a wait that mines is a race the drill
 * loses by design. With mining stopped the gap closes monotonically.
 *
 * THE COST IS REAL AND IT GROWS, which is worth stating rather than hiding: the
 * catch-up is proportional to how far the shared chain has advanced since the
 * venue's start height, so it lengthens every session this ladder runs. When it
 * stops being tolerable the fix is to seed the venue databases near the tip
 * rather than to shorten this wait, because a shortened wait does not fail, it
 * silently returns to the failure above.
 *
 * THE BUDGET IS DELIBERATELY LARGE, and 60 minutes was measured to be too small.
 * A genesis-to-tip replay is roughly forty minutes on a quiet box, but the rate
 * is not a property of the code: it collapsed to one to four blocks a minute
 * when a sibling repo's CI perf tier ran on the same host, and a run that had
 * already spent half an hour then failed on the budget rather than on anything
 * it was testing. Since this barrier polls to a CONDITION, a generous budget
 * costs nothing on a healthy box and is the difference between a real verdict
 * and a wasted hour on a loaded one.
 *
 * @param {object} venue
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]  total budget (default 150 minutes)
 * @param {number} [opts.maxLag]     blocks behind its own decoder still counted
 *                                   as caught up (default 1)
 */
async function waitForVenueIndexersAtTip (venue, opts) {
    const o = opts || {}
    const timeoutMs = Number(o.timeoutMs || 150 * 60 * 1000)
    const maxLag    = Number.isFinite(Number(o.maxLag)) ? Number(o.maxLag) : 1
    const deadline  = Date.now() + timeoutMs
    const started   = Date.now()

    let last = null
    let announced = false
    let lastReport = Date.now()
    let lastWorst = null
    while (Date.now() < deadline) {
        const seen = []
        for (const ix of venue.indexers) {
            let s = null
            try { s = await venue.statusOf(ix.index) } catch (_) { s = null }
            const b = (s && s.body) || {}
            seen.push({
                index:   ix.index,
                height:  Number.isFinite(Number(b.indexerBlock)) ? Number(b.indexerBlock) : null,
                decoder: Number.isFinite(Number(b.decoderBlock)) ? Number(b.decoderBlock) : null,
                reason:  b.stallReason || null,
                klass:   b.stallClass || null,
            })
        }
        last = seen

        const readable = seen.filter((s) => s.height !== null && s.decoder !== null)
        const caught = readable.length === seen.length &&
            readable.every((s) => (s.decoder - s.height) <= maxLag)
        if (caught) {
            // AND THE PRICES, before this barrier reports the venue ready.
            //
            // Catching the chain is necessary and not sufficient. A priced action
            // is refused without a current price for BOTH the coin pair and
            // XCHAIN, and a contract DEPLOY's constructor is a priced action, so a
            // drill that deploys before the venue hubs have published their first
            // oracle round gets "no current oracle price", the contract never
            // exists on the venue nodes, every later call fails as an unknown
            // contract action, and NO attestation request is ever emitted there.
            // The applier then has nothing to bind and stays silent, which is what
            // made a delivered mirror row look like an applier defect for runs on
            // end.
            //
            // It is a RACE rather than a missing capability: the venue hubs do
            // publish both pairs, just not by the time the drill wants to deploy.
            // So this waits for the rows to be visible instead of seeding them,
            // which is what an earlier attempt did and which the mirror bootstrap
            // silently overwrote.
            await waitForVenuePrices(venue)
            console.log('mirrorDrillFixture: venue indexers caught the chain after ' +
                Math.round((Date.now() - started) / 1000) + 's at ' +
                seen.map((s) => s.index + '=' + s.height).join(', '))
            return seen
        }

        const worst = readable.reduce((a, s) => Math.max(a, s.decoder - s.height), 0)

        // Announced ONCE at the start, then PROGRESS every couple of minutes.
        //
        // NO PREDICTED DURATION, and that is a correction rather than an
        // omission. The first version printed an estimate derived from a blocks
        // per minute constant, and the rate is not constant: measured across one
        // catch-up it ran about 265 blocks a minute over the empty early chain,
        // about 60 over the later chain that carries real transaction volume, and
        // about 1 while a sibling's CI saturated the host. Three samples, three
        // answers, and the printed estimate was wrong every time. What a reader
        // actually needs is whether the number is still moving, so that is what
        // is printed.
        if (!announced) {
            announced = true
            console.log('mirrorDrillFixture: holding until the venue indexers catch the chain. ' +
                'Behind by up to ' + worst + ' block(s) (' +
                seen.map((s) => s.index + '=' + s.height + '/' + s.decoder).join(', ') +
                '). NOTHING IS MINED while this runs, deliberately: every mined block is one more ' +
                'for these nodes to chase. Progress is reported below; no duration is predicted ' +
                'because the replay rate varies by more than two orders of magnitude with chain ' +
                'content and host load.')
        } else if (Date.now() - lastReport >= 120000) {
            lastReport = Date.now()
            const moved = lastWorst === null ? null : (lastWorst - worst)
            console.log('mirrorDrillFixture: catching up, ' + worst + ' block(s) behind (' +
                seen.map((s) => s.index + '=' + s.height).join(', ') + ')' +
                (moved === null ? '' :
                    ', closed ' + moved + ' in the last 2 min' +
                    (moved <= 0 ? ' -- NOT ADVANCING, check host load before waiting further' : '')) +
                '.')
            lastWorst = worst
        }
        if (lastWorst === null) lastWorst = worst
        await new Promise((r) => setTimeout(r, 5000))
    }

    assert.fail('mirrorDrillFixture: the venue indexers did not catch the chain within ' +
        timeoutMs + 'ms: ' +
        (last || []).map((s) => 'indexer ' + s.index + ' at ' + s.height + ' of ' + s.decoder +
            (s.reason ? ' (' + s.klass + '/' + s.reason + ')' : '')).join('; ') +
        '. Making a request now would put it at a block these nodes have not reached, and the ' +
        'response would read as "not applied" when the node simply has not got there yet. If they ' +
        'are not advancing at all, check the stall reason above rather than extending this budget.')
}

/**
 * Hold until every venue indexer can see a CURRENT price for both pairs.
 *
 * Read from the same mirror database the indexer prices actions against, so this
 * cannot pass while the reader still sees nothing.
 */
async function waitForVenuePrices (venue, opts) {
    const o = opts || {}
    const timeoutMs = Number(o.timeoutMs || 20 * 60 * 1000)
    const deadline  = Date.now() + timeoutMs
    const tick = String(global.COIN_CODE || 'BTC').toUpperCase()
    const pairs = [tick + '/USD', 'XCHAIN/USD']
    let last = ''
    let announced = false

    while (Date.now() < deadline) {
        const missing = []
        for (const ix of venue.indexers) {
            for (const pair of pairs) {
                // READ THE ROW THE READER WILL READ. `db.getLatestPrice` orders
                // by `round_number DESC` (with a reference_block / block_timestamp
                // ceiling), NEVER by timestamp, so a barrier that ordered by
                // block_timestamp was judging a different row from the one the
                // indexer prices against: the venue's seeded rows carry a
                // synthetic round far above any round a venue hub reaches, while
                // the hub's own oracle rounds carry later timestamps. Both a false
                // refusal and a false pass are reachable that way, and the first
                // is what a 2026-09-04 reading of 7,679,017 against a canonical
                // 100,000 may well have been.
                let rows = []
                try {
                    rows = await queryVenueDb(venue, ix.mirrorDbName,
                        'SELECT price, round_number, reference_block, block_timestamp ' +
                        'FROM price_snapshots WHERE coin_pair = ? AND price IS NOT NULL ' +
                        "AND status = 'finalized' ORDER BY round_number DESC LIMIT 3", [pair])
                } catch (_) { rows = [] }
                // SANE, not merely present. A price that is wrong by orders of
                // magnitude is worse than none: the venue node then computes a
                // native fee far above what the harness paid off the STANDING
                // node's prices and rejects the deploy for an insufficient fee,
                // which is the same divergence class as a missing price one layer
                // down, and which surfaces much later as a mirror row that never
                // applies.
                const px = (rows && rows.length) ? Number(rows[0].price) : null
                const want = pair === 'XCHAIN/USD'
                    ? Number(xchainPrice.BOOTSTRAP_XCHAIN_USD) : CANONICAL_COIN_USD
                const sane = px !== null && Number.isFinite(px) &&
                    px >= want / PRICE_TOLERANCE && px <= want * PRICE_TOLERANCE
                if (!sane){
                    // Name the rows, not just the number. Which row won and by
                    // what round is the whole diagnosis: a bad SEED and a bad
                    // ORACLE round are different faults with different remedies,
                    // and the bare value cannot tell them apart.
                    const detail = (rows || []).map((r) =>
                        Number(r.price) + '@round ' + r.round_number + '/ref ' + r.reference_block).join(', ')
                    missing.push(ix.index + ':' + pair +
                        (px === null ? ' (absent)' : ' (' + px + '; top rounds: ' + detail + ')'))
                }
            }
        }
        if (missing.length === 0) {
            console.log('mirrorDrillFixture: every venue indexer sees a finalized price for ' +
                pairs.join(' and ') + '.')
            return true
        }
        last = missing.join(', ')
        if (!announced) {
            announced = true
            console.log('mirrorDrillFixture: waiting for the venue hubs to publish their first oracle ' +
                'round. Missing ' + last + '. A priced action, which includes a contract deploy, is ' +
                'refused until both pairs are present, and that refusal surfaces much later as a ' +
                'mirror row that never applies.')
        }
        await new Promise((r) => setTimeout(r, 5000))
    }

    assert.fail('mirrorDrillFixture: the venue hubs never published a usable oracle price within ' +
        timeoutMs + 'ms; still missing ' + last + '. Deploying now would fail the constructor for a ' +
        'missing price and no attestation request would ever be emitted on the venue nodes.')
}

/**
 * Derive the pubkey a 32-byte Ed25519 seed signs with, through the hub's OWN
 * identity module rather than a second derivation written here.
 */
function _pubkeyForSeed (seedHex) {
    const ValidatorIdentity = loadHubModule('src/ValidatorIdentity.js')
    return String(new ValidatorIdentity(String(seedHex).toLowerCase()).getPubkeyHex()).toLowerCase()
}

/**
 * Every seed this harness could possibly hold a signer for, pubkey-keyed.
 *
 * THE THREE SIGNING SEEDS are fixed by the roll-call federation and re-exported
 * rather than retyped, so a harness that can sign for this federation is the
 * same harness that agrees with its frozen vector.
 *
 * THE FOURTH IS THE IDLE KEY, and it is the reason this is a search rather than
 * a list. Its seed is `sha256('xchain-rollcall-idle|<generation>|<mnemonic>')`,
 * where the generation is a ROLL-CALL-side rotation counter this lane has no
 * authority over and no reliable way to be told: that ladder bumps it whenever
 * it burns a key, and an attest drill configured with a stale number would
 * derive a real, valid, WRONG identity and fail at the dissemination assertion
 * rather than here. So generations are swept and the match is made ON THE
 * PUBKEY, which is the only comparison that cannot be stale.
 *
 * The legacy fixed seed is included for the same reason: an unconfigured venue
 * seats it, and a seated key nobody can sign for is precisely what this whole
 * function exists to detect.
 */
function _knownSignerSeeds () {
    const rollcall = require('../helpers/rollcallHelper')
    const seeds = new Map()   // pubkey -> {seedHex, origin}

    const add = (seedHex, origin) => {
        if (!seedHex || !/^[0-9a-fA-F]{64}$/.test(String(seedHex))) return
        const hex = String(seedHex).toLowerCase()
        const pk  = _pubkeyForSeed(hex)
        if (!seeds.has(pk)) seeds.set(pk, { seedHex: hex, origin: origin })
    }

    const signing = rollcall.SIGNING_SEEDS || []
    signing.forEach((s, i) => add(s, 'federation signing seed ' + i))

    // An operator-pinned idle seed wins, exactly as it does in rollcallHelper.
    add(process.env.XC_ROLLCALL_IDLE_SEED, 'XC_ROLLCALL_IDLE_SEED')

    const mnemonic = process.env.XC_ROLLCALL_FEDERATION_MNEMONIC
    if (mnemonic) {
        // The configured generation first, so its origin string names the
        // configured value when that is what matched.
        const configured = process.env.XC_ROLLCALL_IDLE_GENERATION
        const gens = []
        if (configured !== undefined && configured !== null && String(configured) !== '') {
            gens.push(String(configured))
        }
        for (let g = 0; g <= IDLE_GENERATION_SCAN; g++) gens.push(String(g))
        for (const g of gens) {
            add(crypto.createHash('sha256')
                .update('xchain-rollcall-idle|' + g + '|' + mnemonic, 'utf8')
                .digest('hex'), 'idle generation ' + g)
        }
    }

    add(rollcall.LEGACY_IDLE_SEED, 'the legacy fixed idle seed')
    return seeds
}

/**
 * The seated attestation set at the height a request made NOW would resolve.
 *
 * READ AT THE BURIED HEIGHT, NOT AT THE TIP, and the distinction is not
 * pedantry: `CapabilitySnapshot` subtracts `CANONICAL_REORG_BUFFER` from every
 * height it is handed, so the set a round actually draws from is the set as it
 * stood a buffer ago. A tip read and a buried read disagree exactly while a
 * stake is inside its activation window, which is the window that matters most,
 * because that is when the roster is changing under the drill.
 */
async function readSeatedAttestationSet (opts) {
    const o = opts || {}
    const indexer = o.indexer || indexerConnector
    const stakeTeardown = require('../helpers/stakeTeardown')
    const buffer = Number(loadHubModule('src/snapshot_reorg_buffer.js').CANONICAL_REORG_BUFFER)

    const tip = await indexer.call('getblockhashes', {})
    assert.ok(tip && tip.block_index !== undefined && tip.block_index !== null,
        'mirrorDrillFixture: the indexer would not report a tip, so the seated set cannot be read')
    const buried = Number(tip.block_index) - buffer
    assert.ok(Number.isFinite(buried) && buried > 0,
        'mirrorDrillFixture: computed a nonsensical buried height (' + buried + ') from tip ' +
        tip.block_index + ' and reorg buffer ' + buffer)

    const set = await stakeTeardown.readCapabilitySet({
        indexer: indexer, capability: 'attestation', blockIndex: buried,
    })
    // NO VERDICT rather than an empty one. An unreadable set says nothing about
    // the roster, and treating it as clean is how a drill talks itself into
    // running against a roster it never saw.
    assert.ok(set && !set.error,
        'mirrorDrillFixture: could not read the seated attestation set at buried block ' + buried +
        (set && set.error ? ' (' + set.error + ')' : '') +
        '. This is an INSTRUMENT failure and NOT evidence that the roster is clean.')
    assert.ok(set.pubkeys.length > 0,
        'mirrorDrillFixture: the attestation capability is EMPTY at buried block ' + buried +
        ', so no responsible set can be drawn at all and every request would be refused at admission.')

    return { set: set, tipBlock: Number(tip.block_index), buriedBlock: buried, reorgBuffer: buffer }
}

/**
 * Provision the identities the venue's hubs sign with, by ADOPTING THE ROSTER
 * rather than adding to it.
 *
 * THIS REPLACED A STAKING PROLOGUE, and the reason is the single most expensive
 * lesson this ladder has: the responsible set is drawn from EVERY staked
 * validator carrying the attestation capability, ranked by
 * `sha256(requestId || pubkey)`, with stake acting only as a pre-filter
 * (`AttestationRound._computeResponsibleSet`). Stake is therefore a FILTER and
 * never a RANK, so staking new identities alongside a standing roster does not
 * win the draw, it DILUTES it: the venue's keys compete with keys whose hubs are
 * not in this mesh, and a draw containing one of those can never finalize.
 *
 * WHY IT CAN NEVER FINALIZE, since "it might work sometimes" is the belief that
 * cost five runs: `AttestationConsensus` computes `needed = max(quorum,
 * redundancy)` with the quorum measured over the PRE-widening set size, so at
 * redundancy 3 it needs THREE valid signatures, and `_handleCommit` accepts
 * signatures only from responsible-set members. One drawn member with no live
 * hub means the round stalls to timeout. It does not degrade, it does not
 * widen its way out on the first pass, and it presents as "the mirror produced
 * no row", which points the investigation at the mirror instead of the roster.
 *
 * So the venue runs AS the roster: every seated key gets a live hub here, and
 * the draw is venue-only BY CONSTRUCTION for any redundancy and any ranking.
 * That is the operator's 2026-09-04 ruling (no provider floor, no new stake),
 * and it is also the only form that stays correct when the roster changes size,
 * which it did DURING this build, between one read and the next.
 *
 * WHAT THIS REFUSES TO DO, deliberately: it will not run with a seated key it
 * cannot sign for. That is a 1-in-4 lottery at four seated keys and redundancy
 * 3, and a drill that fails three times in four is worse than one that refuses
 * once, because a lottery loss is indistinguishable from a real defect.
 *
 * @param {object} opts
 * @param {number} [opts.count]        hub count to provision for (default 5)
 * @param {number} [opts.redundancy]   the redundancy the drill's contract asks
 *                                     for, checked against the eligible set
 * @returns {Promise<{identities, adopted, observers, seated, buriedBlock}>}
 */
async function provisionDrillIdentities (opts) {
    const o     = opts || {}
    const label = String(o.label || 'drill').replace(/[^A-Za-z0-9]/g, '')
    const count = Number(o.count || 5)
    const redundancy = Number(o.redundancy || 3)
    assert.ok(label, 'mirrorDrillFixture: a label is required; it names the drill in refusals')
    assert.ok(Number.isInteger(count) && count > 0, 'mirrorDrillFixture: count must be a positive integer')

    const reading = await readSeatedAttestationSet({ indexer: o.indexer })
    const seated  = reading.set
    const known   = _knownSignerSeeds()

    // ── every seated key must have a signer we can actually run ──────────────
    const adopted = []
    const orphans = []
    for (const pk of seated.pubkeys) {
        const hit = known.get(pk)
        if (hit) adopted.push({ pubkeyHex: pk, privkeyHex: hit.seedHex, origin: hit.origin })
        else orphans.push(pk)
    }

    assert.strictEqual(orphans.length, 0,
        'mirrorDrillFixture: ' + orphans.length + ' of the ' + seated.pubkeys.length +
        ' seated attestation validator(s) at buried block ' + reading.buriedBlock +
        ' have NO signing key this harness can run: ' +
        orphans.map((p) => p.slice(0, 16)).join(', ') + '.\n' +
        'A responsible set is drawn from ALL of them and finalization needs max(quorum, redundancy) ' +
        'signatures from the DRAWN members, so a draw containing one of these stalls to timeout and ' +
        'reads as a missing mirror row. Refusing rather than running that lottery.\n' +
        'The idle key is the usual cause: set XC_ROLLCALL_FEDERATION_MNEMONIC (with ' +
        'XC_ROLLCALL_IDLE_GENERATION) or XC_ROLLCALL_IDLE_SEED so it can be derived, or have the ' +
        'roll-call lane unstake it. Signers this harness holds: ' +
        [...known.keys()].map((p) => p.slice(0, 16)).join(', '))

    assert.ok(count >= adopted.length,
        'mirrorDrillFixture: ' + adopted.length + ' seated key(s) need a hub but the venue is sized ' +
        'for ' + count + '. Raise the hub count: a seated key without a hub is the refusal above.')

    // ── the eligible set must still be big enough to draw from ───────────────
    //
    // The PROVIDER floor filters the seated set BEFORE the ranking, per provider,
    // and it filters to a SUBSET, so it can never introduce a foreign member.
    // What it can do is shrink the set below redundancy, and `_computeResponsibleSet`
    // then returns fewer members than needed, which `AttestationConsensus` skips
    // as an unfinalizable round: the request sits until its deadline and expires.
    // Checked through the hub's OWN comparator, never a second one written here,
    // because a test-side `>=` on decimal strings is exactly the kind of second
    // implementation this fixture exists to avoid.
    const AttestationRound = loadHubModule('src/AttestationRound.js')
    const meetsFloor = AttestationRound.prototype._meetsProviderFloor
    assert.strictEqual(typeof meetsFloor, 'function',
        'mirrorDrillFixture: the hub no longer exposes _meetsProviderFloor, so the provider-floor ' +
        'precondition cannot be checked against the rule the hub actually applies')

    const providerDefaults = loadHubModule('src/ProviderRegistry.js').DEFAULTS || {}
    const floorReport = []
    for (const providerId of Object.keys(providerDefaults)) {
        const floor = providerDefaults[providerId].min_stake_xchain
        if (floor === undefined || floor === null) continue
        const eligible = seated.pubkeys.filter((pk) => {
            const v = seated.byPubkey.get(pk)
            return meetsFloor.call(null, v && v.weight, floor)
        })
        floorReport.push({ providerId: providerId, floor: String(floor), eligible: eligible.length })
        assert.ok(eligible.length >= redundancy,
            'mirrorDrillFixture: provider ' + providerId + ' declares min_stake_xchain ' + floor +
            ' and only ' + eligible.length + ' of ' + seated.pubkeys.length + ' seated validator(s) ' +
            'clear it at buried block ' + reading.buriedBlock + ', which is below the redundancy of ' +
            redundancy + '. The responsible set comes back SHORT, the round is skipped as ' +
            'unfinalizable, and the request expires at its deadline with no response and no error ' +
            'anywhere near the floor that caused it.')
    }

    // ── the remaining hubs are deliberate OUTSIDERS ──────────────────────────
    //
    // Unstaked, in the mesh, and never in a responsible set. AT2 needs at least
    // one: its whole claim is that an indexer following a hub OUTSIDE the set
    // derives the identical rows, and a venue whose every hub is responsible
    // cannot state that claim at all.
    const ValidatorIdentity = loadHubModule('src/ValidatorIdentity.js')
    const identities = adopted.map((a) => ({ pubkeyHex: a.pubkeyHex, privkeyHex: a.privkeyHex }))
    const observers  = []
    for (let i = adopted.length; i < count; i++) {
        const gen = ValidatorIdentity.generate()
        identities.push({ pubkeyHex: gen.pubkeyHex, privkeyHex: gen.privkeyHex })
        observers.push(gen.pubkeyHex)
    }

    console.log('mirrorDrillFixture: adopted the roster for ' + label + ' at buried block ' +
        reading.buriedBlock + ' (tip ' + reading.tipBlock + ', reorg buffer ' + reading.reorgBuffer + '): ' +
        adopted.length + ' seated key(s) each given a live hub [' +
        adopted.map((a) => a.pubkeyHex.slice(0, 16) + ' via ' + a.origin).join('; ') + '], plus ' +
        observers.length + ' unstaked observer hub(s). Eligible per provider: ' +
        floorReport.map((f) => f.providerId + ' ' + f.eligible + '/' + seated.pubkeys.length).join(', ') +
        '. NOTHING WAS STAKED.')

    return {
        identities:  identities,
        adopted:     adopted,
        observers:   observers,
        seated:      seated,
        buriedBlock: reading.buriedBlock,
        tipBlock:    reading.tipBlock,
        floors:      floorReport,
    }
}


/**
 * Fund an owner and deploy a contract that requests an attestation.
 *
 * Kept separate from the staking loop because the owner must NOT be one of the
 * stakers: a request whose fee payer is also a responsible validator makes the
 * fee-split assertions ambiguous about which leg paid what.
 *
 * @param {object} opts
 * @param {string} opts.label   short drill label
 * @param {string} opts.code    the contract source
 * @param {number} [opts.gas]   deploy gas limit
 * @returns {Promise<{owner: object, contractIndex: number}>}
 */
async function deployRequestContract (opts) {
    const o     = opts || {}
    const label = String(o.label || 'drill').replace(/[^A-Za-z0-9]/g, '')
    assert.ok(o.code, 'mirrorDrillFixture: deployRequestContract needs contract source')

    // WRAPPED for the same reason as the staker funding above, and this is the
    // call another lane's AT2b actually died in: the traceback ran
    // deployRequestContract -> getNewFundedAddress -> ensureGasBalance ->
    // sendMintV0, i.e. the internal 100-gas seed, NOT the explicit gas mint that
    // follows on the next lines. The first version of this protection wrapped
    // only that following mint, which is the same one-level-too-high mistake
    // twice over. Retry is safe here as above: the wallet is cached per label,
    // so a second attempt re-funds the SAME owner rather than minting a new one.
    // MINED UNDER, at THIS level and not one lower. `getNewFundedAddress` does
    // its own 100-XCHAIN seed mint internally, and that mint is what lost the
    // 60-second poll on 2026-09-05: the standing node logged `MINT : XCHAIN :
    // 100 : valid` seconds later, on a block that took 59.8s to parse. Wrapping
    // only `ensureGasBalance` below leaves this one exposed, which is the same
    // one-level-too-high mistake the paragraph above records, made downward.
    const owner = await withWedgeClear('funding and gas seed for ' + label + '-owner',
        () => mineWhile(() => cryptoHelper.getNewFundedAddress(
            label + '-owner', COIN, NETWORK, null, 'legacy', 0, 0.02)))
    // Explicitly mined rather than only quiesced: the mint's UTXO lookup wants
    // the funding CONFIRMED, and quiesce alone is satisfied by an empty mempool.
    await regtestMinerConnector.generateBlocks(2)
    await settleStack()
    await withWedgeClear('gas mint for ' + label + '-owner',
        () => mineWhile(() => gasHelper.ensureGasBalance(owner, '5000')))

    // The step run 2 died on, after a full 5-identity prologue and a deployed
    // contract: `checkContract GAVE UP after 225505ms` with 3 polls in 225s.
    //
    // CLEARED BEFORE, NOT WRAPPED AROUND: sendDeployV0 broadcasts and then waits,
    // so a retry would deploy a SECOND contract while every later assertion here
    // assumes exactly one contract index.
    await clearWedgeBefore('contract deploy for ' + label)
    // MINED WHILE IT WAITS, and that is not the retry the paragraph above
    // forbids: nothing is re-broadcast, the venue's block cadence is simply not
    // left to decide. `sendDeployV0` polls on a fixed 60s budget that extends
    // only when the indexer is visibly behind or still writing, and neither
    // fires when the transaction is merely waiting for a BLOCK. Measured
    // 2026-09-05: this leg gave up at 60s with `last indexer lag 1 blocks` and
    // the indexer logged the very same transaction `DEPLOY ... : valid` moments
    // later, which reads as a failed deploy and is a lost race.
    const deploy = await mineWhile(() => vmHelper.sendDeployV0(owner, o.code, Number(o.gas || 500000)))
    assert.strictEqual(deploy.contract.status, 'valid',
        'mirrorDrillFixture: deploy for ' + label + ' came back ' + deploy.contract.status)

    return { owner, contractIndex: deploy.contract.action_index }
}

/**
 * Refuse a round whose responsible set contains anyone this venue does not run.
 *
 * WHY A GUARD AND NOT A MECHANISM. The responsible set is drawn from EVERY
 * staked validator carrying the attestation capability and ranked by
 * `sha256(requestId || pubkey)`, with stake acting only as a pre-filter
 * (`AttestationRound.js`). The venue stakes its identities INTO a shared roster
 * that already holds others, so nothing makes its own hubs win: measured
 * 2026-09-04, an all-venue draw of three from five venue identities among eleven
 * is C(5,3)/C(11,3), about 6%. Retrying until the draw is clean is therefore not
 * a strategy, and this must never be used as one.
 *
 * The MECHANISM is the provider stake floor, raised between the venue's
 * identities and the standing roster through the `configs` table under
 * module='ATTESTATION_PROVIDER', scoped by coin and network so nothing outside
 * regtest moves. This function is what makes a floor that did not work FAIL
 * LOUDLY AND EARLY, naming the members it could not account for, rather than
 * presenting an hour later as a round that never finalized.
 *
 * WHY "not a venue hub" AND NOT "dead": a staked validator whose hub is not in
 * THIS venue's P2P mesh cannot sign this venue's round however alive it is
 * elsewhere. Two of the standing six have no key at all and the other four are
 * simply out of mesh, and both are equally unusable, so the test is membership
 * of the mesh rather than liveness.
 *
 * @param {object} venue       the started AttestMirrorVenue
 * @param {object} federation  a `captureFederationState` result
 */
function assertResponsibleSetIsVenueOnly (venue, federation) {
    assert.ok(venue && Array.isArray(venue.hubs) && venue.hubs.length,
        'mirrorDrillFixture: no venue hubs to compare a responsible set against')
    assert.ok(federation && Array.isArray(federation.hubs),
        'mirrorDrillFixture: assertResponsibleSetIsVenueOnly needs a captureFederationState result')

    // The capture reports pubkeys truncated to 16 chars, so compare on that
    // prefix rather than re-deriving a full key that is not present.
    const ours = new Set(venue.hubs.map((h) => String(h.pubkey).slice(0, 16)))

    const readable = federation.hubs.filter((h) => Array.isArray(h.responsible))
    // NO VERDICT rather than a pass. An unreadable capture says nothing about
    // the draw, and letting that look like a clean set is the same defect the
    // capture itself had to be rebuilt for.
    assert.ok(readable.length > 0,
        'mirrorDrillFixture: no hub returned a readable responsible set, so the draw cannot be ' +
        'judged. This is an INSTRUMENT failure and NOT evidence that the set was clean.')

    const foreign = []
    for (const h of readable) {
        for (const member of h.responsible) {
            if (!ours.has(String(member))) foreign.push(String(member))
        }
    }

    assert.strictEqual(foreign.length, 0,
        'the responsible set contains ' + [...new Set(foreign)].join(', ') + ', which this venue ' +
        'does not run, so the round cannot reach quorum and nothing downstream of it is being ' +
        'tested. Since the venue ADOPTS the roster rather than staking into it, this means a key ' +
        'was seated that `provisionDrillIdentities` did not give a hub: either the roster changed ' +
        'mid-run (it activates on a delay, so a stake made before the drill can seat during it), ' +
        'or the venue was sized for fewer hubs than there are seated keys. Re-read the seated set ' +
        'at the buried height and compare. Venue hubs: ' + [...ours].join(', '))
}

/**
 * Read one of the venue's own indexer databases.
 *
 * These live HERE rather than on the venue helper deliberately: the venue is a
 * shared file another lane is editing constantly, and a drill's read queries are
 * the drill's business. The venue already publishes everything needed to open
 * the connection (`venue.hubDb` and each indexer's database names), so nothing
 * private is being reached into.
 *
 * A connection per call, closed in a finally: a drill makes a handful of these
 * across tens of minutes, so a pooled handle would spend most of its life idle
 * and occasionally time out mid-drill, which reads as a venue fault.
 */
/**
 * Run `work` while mining underneath it, and settle exactly as `work` does.
 *
 * The broadcast-then-wait helpers poll for their row on a fixed budget and
 * extend it only when the indexer is visibly behind or still writing. A
 * transaction waiting for a BLOCK trips neither signal: the indexer is at the
 * tip, idle and correct, and the wait expires while the chain is simply between
 * blocks. Mining removes that dependency without touching the wait's budget or
 * its diagnostics, and re-broadcasts nothing.
 */
async function mineWhile (work, everyMs) {
    let settled = false
    const p = Promise.resolve(work()).finally(() => { settled = true })
    const miner = (async () => {
        while (!settled) {
            await new Promise((r) => setTimeout(r, everyMs || 5000))
            if (settled) break
            try {
                // NEVER MINE ONTO A NODE THAT IS ALREADY BEHIND. The wait this
                // runs under extends itself when the indexer is lagging, so
                // adding blocks it has not reached both prolongs the wait and
                // starves it: measured 2026-09-05, `checkMint` reported
                // `last indexer lag 49 blocks` after this loop mined every five
                // seconds while the node spent up to 60 s on a single block.
                // The point here is only to stop a transaction waiting on an
                // idle chain, which one block at a time satisfies.
                const tip = await indexerConnector.call('getblockhashes', {})
                const at  = Number(tip && tip.block_index)
                const node = Number(await nodeConnector.getBlockCount())
                if (Number.isFinite(at) && Number.isFinite(node) && node - at > MINE_WHILE_MAX_LAG) continue
                await regtestMinerConnector.generateBlocks(1)
            } catch (e) { /* the wait itself reports the real failure */ }
        }
    })()
    try { return await p }
    finally { await miner }
}

async function queryVenueDb (venue, dbName, sql, params) {
    const mariadb = require('mariadb')
    assert.ok(venue && venue.hubDb, 'mirrorDrillFixture: the venue has no hubDb; it is not started')
    assert.ok(/^[A-Za-z0-9_]+$/.test(String(dbName)),
        'mirrorDrillFixture: refusing an unsafe database identifier ' + dbName)
    let conn = null
    try {
        conn = await mariadb.createConnection({
            host: venue.hubDb.host, port: parseInt(venue.hubDb.port, 10),
            user: venue.hubDb.user, password: venue.hubDb.pass, connectTimeout: 10_000,
            // THE VALIDATED NAME HAS TO BE USED, not merely checked. Without this
            // every unqualified query here dies with errno 1046, "No database
            // selected", and BOTH readers below (`readAppliedResponse`,
            // `readContractState`) go through this helper, so neither had ever
            // worked. It went unnoticed only because no drill had reached one of
            // them: AT1 died earlier every time, and the federation capture was
            // the first caller to get this far. It would have failed AT2, AT3,
            // AT4 and AT6 identically, as a fresh unexplained error at the END of
            // a seven-minute run.
            //
            // The assertion above is what made it hard to see: a function that
            // carefully validates an identifier reads like a function that uses
            // it. Same shape as `ensureGasBalance` not ensuring anything.
            database: String(dbName),
        })
        return await conn.query(sql, params || [])
    } finally {
        if (conn) await conn.end().catch(() => {})
    }
}

/**
 * The ATTEST v1 response row a venue indexer APPLIED, joined to the action it
 * hangs off.
 *
 * The join is what makes this worth a helper: the mirror claim is about the
 * ACTION (no transaction, deterministic hash), while the response body lives on
 * the response row, and reading either alone answers half the question.
 *
 * Returns null rather than throwing when nothing is applied yet, so a caller can
 * poll.
 */
async function readAppliedResponse (venue, indexerIndex, requestId) {
    const ix = venue.indexers[indexerIndex]
    assert.ok(ix, 'mirrorDrillFixture: no indexer ' + indexerIndex)
    const rows = await queryVenueDb(venue, ix.indexerDbName,
        // COLUMNS THAT EXIST, and the three that did not are worth naming because
        // each was a different wrong assumption about where a synthetic action
        // records itself. `actions` has `source_id`, not `source`, and it has NO
        // `tx_hash` at all: the hash lives on `transactions`, and a mirror-applied
        // action deliberately has no transaction, which is the entire claim. And
        // `attests` carries BOTH `request_status` and `status_id`, so both are read.
        'SELECT a.action_index, a.block_index, a.tx_index, a.source_id, ' +
        '       r.request_id, r.response_status, r.response_payload, r.request_status, ' +
        '       r.status_id, ' +
        '       r.response_hash, r.callback_execute_action_index ' +
        'FROM attests r JOIN actions a ON a.action_index = r.action_index ' +
        'WHERE r.request_id = ? AND r.version = 1 ' +
        'ORDER BY a.action_index ASC LIMIT 1',
        [String(requestId)])
    return (rows && rows[0]) || null
}

/** Every state key a contract carries on one venue indexer, as a plain object. */
async function readContractState (venue, indexerIndex, contractIndex) {
    const ix = venue.indexers[indexerIndex]
    assert.ok(ix, 'mirrorDrillFixture: no indexer ' + indexerIndex)
    // contract_state is APPEND-ONLY: one row per write, so the latest value per key
    // is MAX(id) within the key and a plain SELECT would hand back history in
    // whatever order the engine chose. This is the shape db.getContractState uses.
    const rows = await queryVenueDb(venue, ix.indexerDbName,
        'SELECT cs.state_key, cs.state_value FROM contract_state cs ' +
        'INNER JOIN (SELECT MAX(id) AS max_id FROM contract_state ' +
        '            WHERE contract_index = ? GROUP BY state_key) latest ' +
        '  ON latest.max_id = cs.id',
        [Number(contractIndex)])
    const out = {}
    for (const r of rows || []) out[String(r.state_key)] = r.state_value
    return out
}

module.exports = {
    provisionDrillIdentities,
    waitForVenueIndexersAtTip,
    waitForVenuePrices,
    startAttestTestServer,
    readSeatedAttestationSet,
    withWedgeClear,
    assertResponsibleSetIsVenueOnly,
    clearWedgeBefore,
    recordStakerKey,
    DRILL_KEYS_DIR,
    deployRequestContract,
    stakeVisibilityBlocks,
    settleStack,
    queryVenueDb,
    mineWhile,
    readAppliedResponse,
    readContractState,
    IDLE_GENERATION_SCAN,
    // Exported for the unit tier only: these are the two pure pieces of the
    // adoption decision, and a guard that cannot reach them can only test
    // adoption by standing up a chain.
    _knownSignerSeeds,
    _pubkeyForSeed,
}
