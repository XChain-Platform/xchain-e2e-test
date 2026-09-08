// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Native-coin fee injection for the general action suite on LTC/DOGE.
//
// Post-fee-era, the LTC/DOGE indexer REQUIRES a native-coin fee output on
// fee-bearing actions: detectFeePaymentMode (xchain-indexer/src/utility.js)
// returns 'rejected' for LTC/DOGE when a tx carries no output paying the
// configured FEE_DESTINATION, whereas BTC falls back to XCHAIN-gas deduction.
// The general action builder (cryptoHelper -> transactionHelper) is gas-mode
// only, so without a fee output every ISSUE on LTC/DOGE is rejected, the tick
// is never created, and the suite hangs on the resulting TICK-unknown cascade.
//
// validateNativeCoinFee (utility.js) enforces only a LOWER bound: it rejects
// when paidAmount < 0.95 * oracle-expected and never rejects overpayment, and
// this suite seeds (and therefore controls) the oracle prices. So a single flat
// fee output that comfortably clears the min for every action is sufficient; no
// per-action fee computation is needed. BTC is left untouched (gas mode).

const priceSnapshotHelper = require('./priceSnapshotHelper')
const topology            = require('./hubMirrorTopology')

const PLACEHOLDER = 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'

// Seeded oracle prices. Identical to nativeFeeLive.test.js so the global seed
// here and that suite's inline re-seed never disagree: XCHAIN at the production
// bootstrap ($2, see xchainPriceConstants), coin $100,000.
//
// This was 1.00 for the whole pre-derivation era, which is a value no
// producer has ever emitted or ever will. Seeding the bootstrap instead means these
// suites assert against what a real hub publishes today.
const { BOOTSTRAP_XCHAIN_USD, NO_PRICE_SEED } = require('./xchainPriceConstants')
const XCHAIN_USD = BOOTSTRAP_XCHAIN_USD
const COIN_USD   = '100000.00000000'

// Flat native fee output (satoshis). With the prices above, the indexer's
// minAcceptable for an action costing X XCHAIN is 0.95 * X * 2 / 100000 coin;
// 50000 sats (0.0005 coin) clears the min for any action up to ~26 XCHAIN.
// (That headroom halved when the seed moved from the 1.00-era value to the $2
// bootstrap. The largest action any e2e composes is a full-size contract
// deploy at well under 2 XCHAIN, so 26 is still an order of magnitude of slack; if
// a future action approaches it, raise this rather than lowering the price.)
// Matches nativeFeeLive's proven output and is negligible against the ~1-coin
// fundings cryptoHelper uses.
const FLAT_FEE_SATS = 50000

// Re-seed at most this often. Must stay well under ORACLE_MAX_PRICE_AGE_SECONDS
// (1800s): a >30-minute run would otherwise let the seeded snapshot age out and
// the validator would reject every fee as stale. Re-anchored to the chain clock.
// Lowered to 2min: at 10min a long full-suite run (or a test that perturbs the
// pair, e.g. the FIAT dispenser) could leave the global snapshot stale for up to
// 10min before the next fee action restored it, hanging a mid-run fee-bearing
// action (observed on the LTC full ACTION sweep).
const SEED_REFRESH_MS = 2 * 60 * 1000

// Synthetic round numbers for the seeded snapshots, kept clear of the values
// nativeFeeLive (999200001+) / nativeFeeDispenser use, so the two never collide.
// The _NOW pair carries the HIGHER round deliberately: getLatestPrice picks the
// highest round among the rows a block is allowed to see, so where both rows are
// visible the wall-clock one (the fresher of the two) wins. See seedGlobalPrices.
// Any new sentinel here must also join SEED_SENTINEL_ROUNDS in
// xchainPriceConstants, which is both what nativeFeeOracleLive asserts against
// and what clearSeedSentinels retracts on a publishing venue.
const XCHAIN_ROUND     = 888100001
const COIN_ROUND       = 888100002
const XCHAIN_ROUND_NOW = 888100011
const COIN_ROUND_NOW   = 888100012

// Re-seed once the CHAIN clock has moved this far past the last seed's anchor,
// independent of the wall-clock throttle above. A clock-drill family (BET, and
// every expiry drill) jumps block time by an hour or more in one step, which ages
// the snapshot out of the 1800s window instantly while `_lastSeedMs` still reads
// fresh, so a purely wall-clock throttle leaves the next fee-bearing action
// rejected for up to SEED_REFRESH_MS. Half the budget keeps a margin for the
// blocks mined between this check and the action's own block.
const SEED_CHAIN_DRIFT_SECONDS = 900

let _lastSeedMs = 0
let _lastSeedAnchor = 0

// See seedGlobalPrices: opt-in suppression for a venue that derives XCHAIN/USD.
// The flag has ONE definition for the whole tree (xchainPriceConstants, imported
// above), enforced per seed site by the guard test.
let _noSeedAnnounced = false

// Only LTC/DOGE mandate a native fee output; BTC uses the XCHAIN-gas fallback.
function isFeeChain(){
    return global.COIN_CODE === 'LTC' || global.COIN_CODE === 'DOGE'
}

// Resolve the protocol fee destination the decoder/indexer were configured with.
// Matches the env the container is given (XCHAIN_FEE_DESTINATION_<CODE>_<NET>,
// falling back to FEE_DESTINATION); the XXXX placeholder counts as "unset".
function resolveFeeDestination(){
    const a = process.env['XCHAIN_FEE_DESTINATION_' + global.COIN_CODE + '_' + global.NETWORK.toUpperCase()]
        || process.env.FEE_DESTINATION || null
    return (a && a !== PLACEHOLDER) ? a : null
}

// ── Where a seed has to land to survive an indexer `reset` ───────────────────
//
// The direct seed writes where the indexer READS, which on a mirrored venue is the
// local copy hub_db_sync owns. That copy is not durable state, for two independent
// reasons, and both were measured on the chunked-deploy regtest venue:
//   - price_snapshots is in hub_db_sync's FULL_REPAGE_TABLES, so its cursor is forced
//     to 0 and every bootstrap re-pages the table from the hub over
//     /hub-db/snapshot/price_snapshots. A `reset` replays from genesis against a table
//     rebuilt from the hub, and a row that was never on the hub does not come back;
//   - even without a reset, _reconcileForeignPriceRounds DELETES every local finalized
//     row a complete drain did not see the hub serve, which is exactly the shape of an
//     out-of-band seed.
// So every native-fee action a drive produced re-parses as `no current oracle price` on
// replay, and no replay can reproduce a live block that held one (spec D45, row 29c).
//
// Seeding the HUB's own price_snapshots answers both: the row lives outside the
// indexer's database entirely, and the next bootstrap mirrors it down like any other
// finalized round.
//
// It does NOT replace the direct write, and that is a measurement rather than caution.
// The hub broadcasts new rows only from its own writers (HubDbBroadcaster is fed by
// PriceAggregator), and the mirror re-pages price_snapshots only on a (re)connect,
// watchdog or forced resync, so a hub-only seed is invisible to the indexer that is
// running right now. Both writes are made, hub FIRST: hub first is what stops a re-page
// landing between them from purging the direct copy as a foreign round.
//
// Which database is the hub's own is the operator's statement, never a guess:
// HUB_SOURCE_DB_NAME, the env hubMirrorTopology already defines for exactly this
// ("seed upstream of the mirror"). With it unset, seedParams() collapses onto the read
// target, there is no hub path to take, and this is today's behaviour unchanged.
function hubSeedTarget(){
    let seed = null
    let read = null
    try { seed = topology.seedParams(); read = topology.readParams() } catch (e) { return null }
    if (!seed || !read || !seed.database) return null
    return topology.sameTarget(seed, read) ? null : seed
}

// The upsert the hub copy receives.
//
// Never a DELETE, unlike the direct path's clearPair: the hub's table is the
// federation's authoritative price history, so on a venue that has a federation wiping
// a pair there would destroy real validator rounds. The blast radius is the sentinel
// rounds and nothing else, keyed on the table's own UNIQUE (round_number, coin_pair) so
// a re-seed replaces its own row.
//
// The column list is the subset the hub and the indexer's mirror both declare
// (xchain-hub/src/sql/price_snapshots.sql, xchain-indexer/src/sql/price_snapshots.sql),
// so the row a bootstrap carries down is the row seeded here; the columns left out
// (source_chain, source_action_index, push_generation) all carry table defaults that
// mark it hub-finalized, which is what a round with no source-chain PRICE tx is.
const HUB_SEED_SQL = `INSERT INTO price_snapshots
    (round_number, coin_pair, price, reference_block, reference_chain,
     block_timestamp, validator_count, consensus_round, consensus_proof, status)
    VALUES (?, ?, ?, 0, 'BTC', ?, 1, 1, '[]', 'finalized')
    ON DUPLICATE KEY UPDATE
     price = VALUES(price),
     block_timestamp = VALUES(block_timestamp),
     status = 'finalized'`

async function seedIntoHub(target, rows){
    // Resolved at call time, so a fake driver can stand in for this without depending on
    // the order the helper and the test load their module graphs.
    const mariadb = require('mariadb')
    const conn = await mariadb.createConnection(Object.assign({ connectTimeout: 5000 }, target))
    try {
        for (const row of rows)
            await conn.query(HUB_SEED_SQL, [row.roundNumber, row.coinPair, row.price, row.blockTimestamp])
    } finally {
        if (conn && typeof conn.end === 'function') await conn.end().catch(() => {})
    }
}

// Where the last seed actually landed: { direct, hub, hubError }. Read by
// warnIfSeedInvisible so its diagnosis matches what was written, and exposed so a
// caller (or a drive report) can say whether this run's prices are replay-safe.
let _lastSeedReport = null
function lastSeedReport(){ return _lastSeedReport }

// Seed XCHAIN/USD + {COIN}/USD so the indexer can value fees. Runs on EVERY
// chain: native-fee chains (LTC/DOGE) value the injected fee output against
// these, and gas-mode BTC still needs a fresh {COIN}/USD because USD-pegged
// contract-fee validation looks one up for every DEPLOY/EXECUTE (without a
// current snapshot the action indexes `invalid: no current oracle price for
// BTC/USD`, a false red/green by timing on runs past ORACLE_MAX_PRICE_AGE).
// No-op only when the last seed is still fresh (unless force=true), or when the
// venue derives the pair itself (NO_PRICE_SEED below).
async function seedGlobalPrices(force){
    // The full de-seed. On a venue whose own hub publishes XCHAIN/USD (a
    // price-capability oracle validator), seeding it is a defect rather than a
    // convenience: the seed carries a synthetic round number far above any the
    // hub will ever reach, and getLatestPrice picks the highest round, so ONE
    // seeded row silently shadows every derived round and a broken derivation
    // still reads green. Force does not override this - a forced re-seed is
    // still a seed.
    //
    // Deliberately opt-IN. Everywhere else the seed is what makes LTC/DOGE
    // payable at all, so defaulting this on would red every native-fee suite on
    // every venue whose hub does not derive the pair, which today is all of them
    // but one.
    if (NO_PRICE_SEED) {
        if (!_noSeedAnnounced) {
            _noSeedAnnounced = true
            console.log('nativeFeeHelper: XCHAIN_E2E_NO_PRICE_SEED=1; not seeding oracle prices ' +
                '(the venue is expected to publish them itself)')
            // Suppressing the seed is necessary but NOT sufficient: rows a
            // pre-flag run already wrote carry sentinel round numbers far above any
            // the hub reaches, and getLatestPrice orders by round DESC, so they go
            // on shadowing every derived round and the venue keeps pricing off a
            // fixture while looking green. Retract exactly those rows, once per
            // process, leaving derived rounds untouched. Non-fatal: a venue whose
            // DB this process cannot write is still readable, and the assertions
            // downstream will catch a shadowed price anyway.
            try {
                const removed = await priceSnapshotHelper.clearSeedSentinels()
                if (removed > 0)
                    console.log('nativeFeeHelper: cleared ' + removed + ' leftover seed-sentinel ' +
                        'price_snapshots row(s) that would have shadowed the derived rounds')
            } catch (e) {
                console.log('nativeFeeHelper: WARN could not clear leftover seed-sentinel rows: ' +
                    (e && e.message ? e.message : e))
            }
        }
        return
    }

    const now = Date.now()
    const throttled = !force && (now - _lastSeedMs) < SEED_REFRESH_MS
    // The chain clock, not the wall clock, is what ages a snapshot out. Read it
    // even while throttled so a clock jump re-seeds immediately (the read is one
    // indexed query on the suite's existing pool).
    if (throttled) {
        if (!_lastSeedAnchor) return
        let chainNow = 0
        try { chainNow = await priceSnapshotHelper.latestBlockTime() } catch (e) { return }
        const drift = chainNow - _lastSeedAnchor
        // Forward drift inside the budget is the only case that needs no work. A
        // NEGATIVE drift is not a smaller version of the same thing: it puts the
        // anchor in the future of the blocks now being mined, which the H-3 gate
        // reads as no price at all, so re-seed however small it is.
        if (drift >= 0 && drift < SEED_CHAIN_DRIFT_SECONDS) return
    }

    const available = await priceSnapshotHelper.isAvailable()
    if (!available) {
        console.log('nativeFeeHelper: price_snapshots not reachable; skipping price seed')
        return
    }

    // TWO anchors per pair, because no single timestamp survives all three regtest
    // clock regimes. A snapshot at S is usable by a block at time B only inside
    // S <= B <= S + ORACLE_MAX_PRICE_AGE_SECONDS: the upper bound is the staleness
    // guard, and the LOWER bound is the H-3 selection gate (getLatestPrice's
    // `block_timestamp <= ?` on LTC/DOGE, where the reference_block gate is
    // vacuous). The old max(tip, now) anchor honoured only the upper bound, which
    // an earlier comment here described as one-sided; that stopped being true when
    // H-3 landed, and on a native-fee chain the consequence is total:
    //   - chain clock PINNED BEHIND wall time (every clock drill ends this way -
    //     betHelper.releaseClock pins tip+5 rather than releasing to 0, since
    //     releasing with the tip ahead wedges the miner). Wall time then walks
    //     past the pin while blocks stay frozen at it, so a now-anchored snapshot
    //     sits in the FUTURE of every block and is excluded outright: each action
    //     rejects `no current oracle price`, permanently, until someone moves the
    //     node's clock. Found wedging the whole LTC stack this way (blocks 354s
    //     behind wall clock), which is what kept the BET family BTC-only.
    //   - idle chain: the tip lags wall clock (one DOGE venue's tip ran ~6300s
    //     behind) but the miner is NOT pinned, so new actions land in blocks
    //     stamped ~now and a tip-anchored snapshot is instantly stale. (C4 Bug 2.)
    //   - sustained mining / post-jump: block timestamps lead wall clock, so the
    //     tip is the only usable anchor.
    // Seeding BOTH the tip time and wall-clock now covers all three: the frozen
    // regime sees only the tip row (the now row fails the gate), the idle regime
    // sees both and takes the now row on round precedence, and an ahead-of-clock
    // chain has tip >= now so the single tip row is written.
    // clearPair first so the only finalized rows for the pair are the ones below.
    //
    // Read this before pointing any new test at {COIN}/USD: the clear
    // below DELETES the whole pair, and this runs from getNativeFeeOutput(), which
    // every ACTION tx passes through. So it fires between an arbitrary test's seed
    // and that test's later assertions, throttled to once per SEED_REFRESH_MS,
    // which turns any collision into a timing flake rather than a hard failure.
    // An earlier version of this comment claimed the FIAT dispenser cases were
    // safe because they re-seed right before a DISPENSE and the bare payment never
    // re-seeds. That held only for the original Mode 1 case: the Mode 2 cases added
    // later seed FIRST and then send a dispenser-create action tx, and they
    // back-date their snapshots by up to 25h, so a reseed anchored at "now" both
    // removed their row and replaced it with a different price (COIN_USD, not the
    // 50000 they assert). Those cases now price in their own fiats and no longer
    // share this pair; keep it that way.
    const chainTime = await priceSnapshotHelper.latestBlockTime()
    const wallTime  = Math.floor(Date.now() / 1000)

    // Both pairs stay spelled out at the call sites rather than hoisted into a
    // variable: an isolation guard scans this file for the clearPair set to
    // prove the seed's blast radius is still these two pairs, and it cannot
    // resolve an indirection. (Both clearPair calls are still spelled out below.)
    //
    // The rows this seed writes, oldest anchor first so the fresher one carries the
    // higher round (see the anchor note above). Built once and handed to BOTH targets,
    // so the durable hub copy and the copy the indexer reads today cannot disagree.
    const rows = [
        { coinPair: 'XCHAIN/USD', price: XCHAIN_USD, blockTimestamp: chainTime, roundNumber: XCHAIN_ROUND },
        { coinPair: global.COIN_CODE + '/USD', price: COIN_USD, blockTimestamp: chainTime, roundNumber: COIN_ROUND }
    ]
    if (wallTime > chainTime) {
        rows.push({ coinPair: 'XCHAIN/USD', price: XCHAIN_USD, blockTimestamp: wallTime, roundNumber: XCHAIN_ROUND_NOW })
        rows.push({ coinPair: global.COIN_CODE + '/USD', price: COIN_USD, blockTimestamp: wallTime, roundNumber: COIN_ROUND_NOW })
    }

    // The durable half, first (see hubSeedTarget). Non-fatal by construction: a venue
    // whose hub database this process cannot reach must keep behaving exactly as it did,
    // with the direct write below carrying the run.
    const hubTarget = hubSeedTarget()
    let hubSeeded = null
    let hubError  = null
    if (hubTarget) {
        try {
            await seedIntoHub(hubTarget, rows)
            hubSeeded = hubTarget
        } catch (e) {
            hubError = (e && e.message) ? e.message : String(e)
            console.log('nativeFeeHelper: WARN could not seed the hub database ' + hubTarget.database +
                ' (' + hubError + '); this run is still priced by the direct seed, but an indexer ' +
                'reset will replay these blocks with no oracle price')
        }
    }

    await priceSnapshotHelper.clearPair('XCHAIN/USD')
    await priceSnapshotHelper.clearPair(global.COIN_CODE + '/USD')
    for (const row of rows) await priceSnapshotHelper.seedSnapshot(row)
    _lastSeedMs = now
    // The CHAIN anchor is what the drift check compares against: it is the row a
    // frozen or jumped chain actually reads.
    _lastSeedAnchor = chainTime
    // Named only for the log and the visibility check below; a stubbed helper need not
    // provide it, so this stays optional rather than becoming a second contract.
    const target = (typeof priceSnapshotHelper.seedTarget === 'function')
        ? priceSnapshotHelper.seedTarget() : null
    _lastSeedReport = { direct: target || null, hub: hubSeeded, hubError: hubError }
    console.log('nativeFeeHelper: seeded oracle prices XCHAIN/USD=' + XCHAIN_USD +
        ' ' + global.COIN_CODE + '/USD=' + COIN_USD + ' (chain_time=' + chainTime +
        (wallTime > chainTime ? ', wall_time=' + wallTime : '') +
        (target && target.database ? ', db=' + target.database : '') +
        // Named so a drive's log says whether its native-fee blocks can be replayed.
        (hubSeeded ? ', hub_db=' + hubSeeded.database + ' (replay-safe)' : '') + ')')
    // A seed that the indexer cannot see is worse than no seed: every priced action
    // rejects `no current oracle price` while this log says the prices are in place, and
    // the two databases involved both look healthy. Confirm it once at bootstrap, where
    // the cost is one call and the answer is unambiguous.
    if (force) await warnIfSeedInvisible(target, _lastSeedReport)
}

// Ask the indexer whether the seed just written is the one it prices against, and say
// so loudly when it is not. Never throws: a venue can be mid-reorg or have a tip the
// suite is about to advance, and a false alarm must not fail the bootstrap.
// `report` is the seed's own account of where it landed (lastSeedReport); optional, so
// an older caller passing only `target` gets exactly the diagnosis it always got.
async function warnIfSeedInvisible(target, report){
    const c = global.indexerConnector
    if (!c || typeof c.call !== 'function') return
    let sched = null
    try { sched = await c.call('feeschedule', {}) } catch (e) { return }
    if (!sched || sched.error || !sched.prices) return
    if (sched.prices.available) return
    const src = sched.priceSource
    const hub = report && report.hub
    console.log('nativeFeeHelper: WARN the indexer still reports no usable price after seeding'
        + ' (' + (sched.prices.error || 'unavailable') + ').'
        + ' Seeded into: ' + (hub
            ? ('hub database ' + hub.database + ' (upstream) and '
                + ((target && target.database) || 'unknown'))
            : ((target && target.database) || 'unknown')) + '.'
        + ' Indexer reads: ' + (src
            ? (src.hubDb ? ('hub database ' + (src.database || 'unnamed')) : ('its own database '
                + (src.database || 'unnamed')))
            : 'undisclosed (indexer predates the priceSource field)')
        // The mismatch advice is only true of a seed with ONE target. Once the hub path
        // is in play the two databases differ BY DESIGN (seed upstream, read the mirror),
        // so repeating it there sends an operator to "fix" a correct configuration, and
        // the honest reading of an unavailable price is the opposite one: the row is
        // durable, it is the mirror leg that has not delivered it.
        + (hub
            ? '. Those two differ by design here (the seed is upstream of the mirror), so this is'
            + ' the mirror not having carried the row down rather than a database mismatch;'
            + ' check hub_db_sync is running against HUB_API_URL.'
            : '. If those two differ, the fixtures and the indexer are pointed at different'
            + ' databases; check HUB_DB_HOST/HUB_DB_USER/HUB_DB_PASS reach the one the indexer names.'))
}

// Feeschedule-readiness retry budget for fee chains. On a freshly
// reset stack the first suite's beforeAll can outrun the indexer: `feeschedule`
// answers `{error: 'indexer not ready'}` (or refuses the connection) for a few
// seconds until indexerDb/actions are wired, and the old single-shot discovery
// turned that startup race into a false beforeAll failure ("cannot determine
// native-fee mode"). Read at call time so tests can shrink them via env.
function discoveryTimeoutMs(){ return parseInt(process.env.NATIVE_FEE_DISCOVERY_TIMEOUT_MS, 10) || 90000 }
function discoveryPollMs(){ return parseInt(process.env.NATIVE_FEE_DISCOVERY_POLL_MS, 10) || 2000 }

// Discover the stack's ACTUAL native-fee mode. Env is an override (matches the
// container's XCHAIN_FEE_DESTINATION_<CODE>_<NET> / FEE_DESTINATION); otherwise
// ask the live indexer's `feeschedule` JSON-RPC (the source of truth, since the
// indexer reads its destination from config.ADDRESS.FEE_DESTINATION, NOT from
// any env the e2e runner happens to export. This is the fix for the LTC/DOGE
// action-suite hang: resolveFeeDestination() was env-only, returned null in the
// e2e env, the fee output was never injected, and every fee-bearing action was
// rejected (tick never created -> TICK-unknown poll hang). On fee chains a
// failing feeschedule is retried with backoff until the readiness budget above
// is spent (post-reset the indexer needs a moment to populate it); non-fee
// chains keep the single-shot probe since they fall back to gas mode anyway.
// Returns { enabled, destination }; cached after first resolution.
let _feeMode = null
async function discoverFeeMode(){
    if (_feeMode) return _feeMode
    const envDest = resolveFeeDestination()
    if (envDest) { _feeMode = { enabled: true, destination: envDest }; return _feeMode }
    if (global.indexerConnector && typeof global.indexerConnector.call === 'function') {
        const deadline = Date.now() + discoveryTimeoutMs()
        let lastError = null
        let attempts = 0
        for (;;) {
            attempts++
            try {
                const sched = await global.indexerConnector.call('feeschedule', {})
                if (sched && !sched.error) {
                    if (attempts > 1)
                        console.log('nativeFeeHelper: feeschedule became ready after ' + attempts + ' attempts')
                    _feeMode = { enabled: !!sched.nativeFeeEnabled, destination: sched.feeDestination || null }
                    return _feeMode
                }
                lastError = (sched && sched.error) ? String(sched.error) : 'empty feeschedule response'
            } catch (e) {
                lastError = 'indexer feeschedule unreachable: ' + (e && e.message)
            }
            // Non-fee chains (BTC) fall through to gas mode below; only fee
            // chains keep polling, and only while the readiness budget lasts.
            if (!isFeeChain() || Date.now() >= deadline) break
            if (attempts === 1)
                console.log('nativeFeeHelper: waiting for indexer feeschedule on ' + global.COIN_CODE +
                    ' (' + lastError + ')')
            await new Promise(resolve => setTimeout(resolve, discoveryPollMs()))
        }
        // On a fee chain an unresolved feeschedule is NOT a safe "skip": it
        // would silently drop the fee output and hang. Surface it.
        if (isFeeChain())
            throw new Error('native-fee discovery failed on ' + global.COIN_CODE +
                ' (feeschedule not ready after ' + attempts + ' attempts over ' +
                discoveryTimeoutMs() + 'ms: ' + lastError + ')')
    }
    // No env + no API signal: only safe on non-fee chains (BTC = gas mode).
    if (isFeeChain())
        throw new Error('cannot determine native-fee mode on ' + global.COIN_CODE +
            ' (no FEE_DESTINATION env and no indexerConnector.feeschedule)')
    _feeMode = { enabled: false, destination: null }
    return _feeMode
}

// The native fee output to attach to an action tx, or null to skip (gas-mode
// chains where native fees are disabled). Throws loudly when native fees ARE
// enabled but no destination is resolvable. Throwing loudly is far better than
// a silent skip that hangs the suite. Refreshes prices first so a long run never ages out.
async function getNativeFeeOutput(){
    // Refresh oracle prices for EVERY chain first (throttled). Gas-mode BTC
    // returns null just below, but its contract actions still need a fresh
    // BTC/USD for USD-pegged fee validation, so the seed must run BEFORE the
    // gas-mode early return (this is the BTC contract-suite staleness fix).
    await seedGlobalPrices(false)
    const mode = await discoverFeeMode()
    if (!mode.enabled) return null
    if (!mode.destination)
        throw new Error('native fee enabled on ' + global.COIN_CODE +
            ' but no FEE_DESTINATION resolvable (set FEE_DESTINATION or check indexer feeschedule)')
    return { address: mode.destination, value: FLAT_FEE_SATS }
}

module.exports = { resolveFeeDestination, discoverFeeMode, seedGlobalPrices, getNativeFeeOutput,
    warnIfSeedInvisible, hubSeedTarget, lastSeedReport, FLAT_FEE_SATS }
