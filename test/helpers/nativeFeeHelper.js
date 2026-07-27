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

const PLACEHOLDER = 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'

// Seeded oracle prices. Identical to nativeFeeLive.test.js so the global seed
// here and that suite's inline re-seed never disagree: XCHAIN at the production
// bootstrap ($2, see xchainPriceConstants), coin $100,000.
//
//  step 8: this was 1.00 for the whole pre-derivation era, which is a value no
// producer has ever emitted or ever will. Seeding the bootstrap instead means these
// suites assert against what a real hub publishes today.
const { BOOTSTRAP_XCHAIN_USD } = require('./xchainPriceConstants')
const XCHAIN_USD = BOOTSTRAP_XCHAIN_USD
const COIN_USD   = '100000.00000000'

// Flat native fee output (satoshis). With the prices above, the indexer's
// minAcceptable for an action costing X XCHAIN is 0.95 * X * 2 / 100000 coin;
// 50000 sats (0.0005 coin) clears the min for any action up to ~26 XCHAIN.
// (That headroom halved when  step 8 moved the seed from the 1.00-era value
// to the $2 bootstrap. The largest action any e2e composes is a full-size contract
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
// action (observed on the LTC full ACTION sweep, ).
const SEED_REFRESH_MS = 2 * 60 * 1000

// Synthetic round numbers for the seeded snapshots, kept clear of the values
// nativeFeeLive (999200001+) / nativeFeeDispenser use, so the two never collide.
const XCHAIN_ROUND = 888100001
const COIN_ROUND   = 888100002

let _lastSeedMs = 0

// See seedGlobalPrices: opt-in suppression for a venue that derives XCHAIN/USD.
const NO_PRICE_SEED = process.env.XCHAIN_E2E_NO_PRICE_SEED === '1'
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

// Seed XCHAIN/USD + {COIN}/USD so the indexer can value fees. Runs on EVERY
// chain: native-fee chains (LTC/DOGE) value the injected fee output against
// these, and gas-mode BTC still needs a fresh {COIN}/USD because USD-pegged
// contract-fee validation looks one up for every DEPLOY/EXECUTE (without a
// current snapshot the action indexes `invalid: no current oracle price for
// BTC/USD`, a false red/green by timing on runs past ORACLE_MAX_PRICE_AGE).
// No-op only when the last seed is still fresh (unless force=true), or when the
// venue derives the pair itself (NO_PRICE_SEED below).
async function seedGlobalPrices(force){
    //  step 8, the full de-seed. On a venue whose own hub publishes
    // XCHAIN/USD (a price-capability oracle validator), seeding it is the defect
    // this item exists to remove rather than a convenience: the seed carries a
    // synthetic round number far above any the hub will ever reach, and
    // getLatestPrice picks the highest round, so ONE seeded row silently
    // shadows every derived round and a broken derivation still reads green.
    // Force does not override this - a forced re-seed is still a seed.
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
        }
        return
    }

    const now = Date.now()
    if (!force && (now - _lastSeedMs) < SEED_REFRESH_MS) return

    const available = await priceSnapshotHelper.isAvailable()
    if (!available) {
        console.log('nativeFeeHelper: price_snapshots not reachable; skipping price seed')
        return
    }

    // Anchor to max(chain tip block_time, wall-clock now). The staleness guard
    // (db.getLatestPrice) is ONE-SIDED: it rejects only when the snapshot is
    // OLDER than the processed block by > ORACLE_MAX_PRICE_AGE_SECONDS (1800s);
    // a future-dated snapshot is accepted. Two regtest regimes must both stay
    // fresh, and a tip-only anchor fails the first:
    //   - idle chain: the tip block_time lags wall clock (test-host's DOGE tip ran
    //     ~6300s behind), yet new actions mine into blocks timestamped ~now, so
    //     a tip-anchored seed is instantly stale against them. `now` keeps it
    //     fresh. (This was C4 Bug 2.)
    //   - sustained mining: regtest block timestamps can drift AHEAD of wall
    //     clock, so the tip leads `now`; anchoring to the tip tracks it.
    // max() satisfies both.
    // clearPair first so exactly one finalized row exists per pair (no ambiguity
    // for getLatestPrice).
    //
    // , and read this before pointing any new test at {COIN}/USD: the clear
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
    const blockTimestamp = Math.max(
        await priceSnapshotHelper.latestBlockTime(),
        Math.floor(Date.now() / 1000)
    )
    await priceSnapshotHelper.clearPair('XCHAIN/USD')
    await priceSnapshotHelper.clearPair(global.COIN_CODE + '/USD')
    await priceSnapshotHelper.seedSnapshot({ coinPair: 'XCHAIN/USD', price: XCHAIN_USD, blockTimestamp, roundNumber: XCHAIN_ROUND })
    await priceSnapshotHelper.seedSnapshot({ coinPair: global.COIN_CODE + '/USD', price: COIN_USD, blockTimestamp, roundNumber: COIN_ROUND })
    _lastSeedMs = now
    console.log('nativeFeeHelper: seeded oracle prices XCHAIN/USD=' + XCHAIN_USD +
        ' ' + global.COIN_CODE + '/USD=' + COIN_USD + ' (block_time=' + blockTimestamp + ')')
}

// Feeschedule-readiness retry budget for fee chains . On a freshly
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

module.exports = { resolveFeeDestination, discoverFeeMode, seedGlobalPrices, getNativeFeeOutput, FLAT_FEE_SATS }
