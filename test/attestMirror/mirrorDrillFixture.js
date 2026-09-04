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
 * The staking prologue every attest-mirror drill needs before it has a venue.
 *
 * WHY THIS IS NOT A METHOD ON THE VENUE. `AttestMirrorVenue` deliberately does
 * not stake: it takes `opts.identities` and expects them to be selectable
 * already. So the order is forced, identities first, staked second, venue
 * third, and a helper that hung off the venue could not run early enough to
 * matter. This is the thing you call to GET a venue, not a thing you call on
 * one.
 *
 * AT1 through AT6 all need the same prologue and AT0 needs none of it (it never
 * makes a request), so this exists to keep five drills from each growing their
 * own copy of a sequence whose every step has a non-obvious failure mode:
 *
 *   - Stake below the PROVIDER floor and the responsible set silently excludes
 *     the hub. 15000 clears both the attestation capability min_stake (1000)
 *     and the http_get / llm provider floor (10000).
 *   - Mine too few blocks after staking and the request's capability snapshot,
 *     which resolves at the request block BURIED by CANONICAL_REORG_BUFFER,
 *     cannot see the stake. The symptom is not a missing stake: a responsible
 *     set smaller than REDUNDANCY is rejected at admission, the rejected
 *     emission throws, and the EXECUTE rolls back to a failed status nowhere
 *     near the stake that caused it.
 *   - Fund and mint without letting the stack settle in between and the
 *     encoder's `unconfirmed=false` UTXO lookup intermittently crashes against
 *     a mid-batch tracker. That one reads as flake rather than as ordering.
 *
 * Every drill here runs against the STANDING regtest chain, which is the only
 * chain there is: the venue borrows it. Two live venues therefore stake into
 * one roster and are each other's pollution, so drills using this fixture must
 * be serialized, not parallelized.
 *
 * The harness globals (`indexerDatabase`, `regtestMinerConnector`,
 * `utxoTrackerConnector`, `COIN`, `NETWORK`) come from `test/initialCheck.test.js`,
 * which mocha loads with --require. Same convention as the federation drills.
 ********************************************************************/

const assert = require('assert')
const fsx    = require('fs')
const pathx  = require('path')

const cryptoHelper = require('../cryptoHelper')
const stakeHelper  = require('../helpers/stakeHelper')
const gasHelper    = require('../helpers/gasHelper')
const vmHelper     = require('../helpers/vmHelper')
const { loadHubModule } = require('../helpers/multiValidatorHubHelper')

// Clears the attestation capability min_stake (1000) AND the provider floor
// (10000) that is enforced on the responsible set at/above
// STAKE_WEIGHTED_QUORUM, which regtest arms at genesis. A stake that clears
// only the first produces a hub that is staked and never selected.
const DRILL_STAKE_XCHAIN = '15000.00000000'

// Enough gas to pay for the stake plus its fee, with room for the mint.
const DRILL_GAS_XCHAIN = '20000'

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
    await utxoTrackerConnector.quiesce({
        timeoutMs: 30000, pollMs: 250, regtestMiner: regtestMinerConnector,
    })
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

async function stakeDrillIdentities (opts) {
    const o     = opts || {}
    const label = String(o.label || 'drill').replace(/[^A-Za-z0-9]/g, '')
    const count = Number(o.count || 5)
    const amount = String(o.amount || DRILL_STAKE_XCHAIN)
    assert.ok(label, 'mirrorDrillFixture: a label is required; it names the funded addresses')
    assert.ok(Number.isInteger(count) && count > 0, 'mirrorDrillFixture: count must be a positive integer')

    // Resolved BEFORE any chain work, so a misconfigured chain refuses in
    // seconds rather than after five funded addresses and a staking loop.
    const visibilityBlocks = stakeVisibilityBlocks(o.coinTick || COIN, o.network || NETWORK)

    const ValidatorIdentity = loadHubModule('src/ValidatorIdentity.js')
    const identities = []
    const stakers    = []

    for (let i = 0; i < count; i++) {
        const id = ValidatorIdentity.generate()
        identities.push({ pubkeyHex: id.pubkeyHex, privkeyHex: id.privkeyHex })

        // A separate source address per stake: stake weight is per source, and
        // one address staking five times is not the same roster as five
        // addresses staking once.
        const stakerLabel = label + '-staker-' + i
        // WRAPPED, and the reason is a hole found only by driving it: this call
        // seeds gas INTERNALLY (`seedGas` defaults true, and cryptoHelper mints
        // 100 XCHAIN inside it), so the mint that actually died in run 1 was one
        // level BELOW the ensureGasBalance below, which was the only mint the
        // first version of this protection covered. Retry is safe: getNewAddress
        // is keyed by label and returns the same wallet, so a second attempt
        // funds the same address rather than minting a new identity.
        const addr = await withWedgeClear('funding and gas seed for ' + stakerLabel,
            () => cryptoHelper.getNewFundedAddress(
                stakerLabel, COIN, NETWORK, null, 'legacy', 0, 0.02))

        // Recorded BEFORE the stake exists, so the key is on disk no matter
        // where the run dies afterwards.
        const wallet = await cryptoHelper.getWallet(stakerLabel)
        recordStakerKey(label, {
            staker: stakerLabel,
            address: addr.address,
            signingPubkey: id.pubkeyHex,
            mnemonic: wallet && wallet.mnemonic,
            stakedAt: new Date().toISOString(),
        })

        await settleStack()
        await withWedgeClear('gas mint for ' + stakerLabel,
            () => gasHelper.ensureGasBalance(addr, DRILL_GAS_XCHAIN))
        await settleStack()

        // CLEARED BEFORE, NOT WRAPPED AROUND: sendStakeV1 broadcasts and then
        // waits, so a retry would double-stake this identity.
        await clearWedgeBefore('stake ' + i + ' for ' + label)
        const result = await stakeHelper.sendStakeV1(addr, amount, id.pubkeyHex)
        assert.strictEqual(result.stake.status, 'valid',
            'mirrorDrillFixture: stake ' + i + ' for ' + label + ' came back ' + result.stake.status +
            ' rather than valid; the venue built on it would have a short responsible set')
        stakers.push({ addressInfo: addr, pubkey: id.pubkeyHex })
    }

    // Past activation AND past the snapshot burial, so a request made now
    // resolves a capability snapshot that can see every stake above.
    await regtestMinerConnector.generateBlocks(visibilityBlocks)
    await settleStack()

    return { identities, stakers, visibilityBlocks }
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
    const owner = await withWedgeClear('funding and gas seed for ' + label + '-owner',
        () => cryptoHelper.getNewFundedAddress(
            label + '-owner', COIN, NETWORK, null, 'legacy', 0, 0.02))
    // Explicitly mined rather than only quiesced: the mint's UTXO lookup wants
    // the funding CONFIRMED, and quiesce alone is satisfied by an empty mempool.
    await regtestMinerConnector.generateBlocks(2)
    await settleStack()
    await withWedgeClear('gas mint for ' + label + '-owner',
        () => gasHelper.ensureGasBalance(owner, '5000'))

    // The step run 2 died on, after a full 5-identity prologue and a deployed
    // contract: `checkContract GAVE UP after 225505ms` with 3 polls in 225s.
    //
    // CLEARED BEFORE, NOT WRAPPED AROUND: sendDeployV0 broadcasts and then waits,
    // so a retry would deploy a SECOND contract while every later assertion here
    // assumes exactly one contract index.
    await clearWedgeBefore('contract deploy for ' + label)
    const deploy = await vmHelper.sendDeployV0(owner, o.code, Number(o.gas || 500000))
    assert.strictEqual(deploy.contract.status, 'valid',
        'mirrorDrillFixture: deploy for ' + label + ' came back ' + deploy.contract.status)

    return { owner, contractIndex: deploy.contract.action_index }
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
        'SELECT a.action_index, a.block_index, a.tx_index, a.tx_hash, a.source, ' +
        '       r.request_id, r.response_status, r.response_payload, r.status_id, ' +
        '       r.callback_execute_action_index ' +
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
    stakeDrillIdentities,
    withWedgeClear,
    clearWedgeBefore,
    recordStakerKey,
    DRILL_KEYS_DIR,
    deployRequestContract,
    stakeVisibilityBlocks,
    settleStack,
    queryVenueDb,
    readAppliedResponse,
    readContractState,
    DRILL_STAKE_XCHAIN,
    DRILL_GAS_XCHAIN,
}
