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
 *
 * Fixture-stake teardown policy.
 *
 * WHY THIS EXISTS. A fixture STAKE is not scratch state. It joins the REAL
 * capability set the venue's hubs and indexers resolve quorum against, and
 * nothing in the suite ever took it back out. On the shared BTC
 * regtest the oracle_publish set had grown from 18 members to 61 (one orphan
 * staked at 250000 XCHAIN) purely from fixture runs; the operator hub's weight
 * share fell from 69.9% to 9.1% and checkpoint quorum became permanently
 * unreachable. Nothing failed at the time - each run passed, and the venue got
 * a little more unusable.
 *
 * THE POLICY, in one line: a fixture run leaves the capability set no larger
 * than it found it.
 *
 * Three mechanisms carry it, and all three live here:
 *
 *   1. A LEDGER. Every stake a fixture creates through stakeHelper registers
 *      here; every full UNSTAKE deregisters. What is left at the end of a run
 *      is exactly the debt that run took on.
 *   2. A RELEASE. The root afterAll sweeps that debt: one UNSTAKE per
 *      outstanding stake, from the source that owns it, then enough blocks for
 *      the deactivation to take effect (UNSTAKE stamps deactivation_block =
 *      block + ACTIVATION_DELAY_BLOCKS, so the key stays effective until it is
 *      buried; mining is part of the release, not a nicety).
 *   3. A CHECK. The set is read at bootstrap and again after the release,
 *      through the same source-keyed view the epoch close uses
 *      (`getstakeweightsbycapability`), and any pubkey the run added and did
 *      not take back is named. Loud by default, fatal under
 *      E2E_STAKE_TEARDOWN_STRICT=1.
 *
 * THE ESCAPE HATCH is a DEDICATED STAKING VENUE. A venue whose whole purpose
 * is to hold a seeded federation (the ROLLCALL acceptance venue, seeded by
 * test/tools/rollcallSeedFederation.test.js) must NOT have its stakes swept at
 * the end of the run that created them. Those venues set
 * E2E_STAKE_TEARDOWN=off, and they declare themselves in
 * xchain-documentation/components/e2e-test/staking-venue-policy.md. Off is a
 * declaration, not a default: a run that turns teardown off says so in its
 * output.
 *
 * Everything here is injectable. The unit tier drives it with fakes; nothing
 * in this file reaches for a global.
 *
 ********************************************************************/

const DEFAULT_CAPABILITY = 'oracle_publish'

// Blocks mined after the release UNSTAKEs so the deactivation is both in
// effect (ACTIVATION_DELAY_BLOCKS, 6 on BTC) and buried past the canonical
// reorg buffer (another 6) at which capability snapshots resolve. Same
// arithmetic as stakeHelper.ATTESTATION_STAKE_VISIBLE_BLOCKS, kept here so the
// teardown does not depend on a constant named for the attestation path.
const RELEASE_SETTLE_BLOCKS = 14

// Whole-sweep budget. A release that cannot finish inside it stops and reports
// what it did not get to, rather than hanging a suite's teardown forever.
//
// RAISED from ten minutes on 2026-09-04, deliberately, because the two sides of
// this trade are not symmetric. A teardown that runs long costs ONE run some
// wall clock. A teardown that runs out costs EVERY FUTURE DRAW on the venue: the
// unstakes it never broadcast leave keys seated in a shared capability set, and
// if the process then exits, their signing keys are gone with it. Measured that
// night: a wedged indexer ate the budget, three unstakes timed out and two were
// never sent, and five keys were left in `oracle_publish`. The budget is the last
// thing standing between a failed drill and permanent roster contamination, so it
// gets room.
const DEFAULT_BUDGET_MS = 20 * 60 * 1000

// The one stall shape whose remedy this file knows, spelled the same way the
// attest-mirror drills spell it so the two cannot drift.
const ROLLCALL_STALL_REASON = 'rollcall_proof_unavailable'

// The run's outstanding fixture stakes, keyed so a v2 top-up of a stake this
// run already created does not enqueue a second UNSTAKE for the same pubkey
// (UNSTAKE v0 sweeps every active row for the pubkey; a second one rejects).
const ledger = new Map()

function truthy(v){
    if(v === undefined || v === null) return false
    const s = String(v).trim().toLowerCase()
    return s === '1' || s === 'true' || s === 'on' || s === 'yes'
}

function falsy(v){
    if(v === undefined || v === null) return false
    const s = String(v).trim().toLowerCase()
    return s === '0' || s === 'false' || s === 'off' || s === 'no'
}

// Resolve the run's teardown policy from the environment. Pure: takes the env
// as an argument so the unit tier can assert every branch without touching
// process.env.
function policy(env){
    const e = env || {}
    const explicitOff = falsy(e.E2E_STAKE_TEARDOWN)
    const explicitOn  = truthy(e.E2E_STAKE_TEARDOWN)

    let reason = 'default: fixture stakes are released at the end of the run'
    if(explicitOff) reason = 'E2E_STAKE_TEARDOWN=off: this venue keeps its fixture stakes (dedicated staking venue)'
    else if(explicitOn) reason = 'E2E_STAKE_TEARDOWN=on'

    const settle = parseInt(e.E2E_STAKE_TEARDOWN_SETTLE_BLOCKS, 10)
    const budget = parseInt(e.E2E_STAKE_TEARDOWN_BUDGET_MS, 10)

    return {
        release:      !explicitOff,
        check:        !explicitOff,
        strict:       truthy(e.E2E_STAKE_TEARDOWN_STRICT),
        capability:   e.E2E_STAKE_TEARDOWN_CAPABILITY || DEFAULT_CAPABILITY,
        settleBlocks: (Number.isFinite(settle) && settle >= 0) ? settle : RELEASE_SETTLE_BLOCKS,
        budgetMs:     (Number.isFinite(budget) && budget > 0)  ? budget : DEFAULT_BUDGET_MS,
        reason:       reason
    }
}

function entryKey(spec){
    if(spec.contractIndex !== undefined && spec.contractIndex !== null)
        return 'c:' + spec.contractIndex + ':' + String(spec.tick) + ':' + String(spec.signingPubkey).toLowerCase()
    return 's:' + String(spec.signingPubkey).toLowerCase()
}

// Record a stake this run created. Called by stakeHelper on every STAKE that
// indexed at status=valid; an intentionally-rejected stake never becomes a
// member of anything and is not registered.
function registerStake(spec){
    if(!spec || !spec.signingPubkey || !spec.addressInfo) return null
    const key = entryKey(spec)
    const existing = ledger.get(key)
    if(existing){
        // A v2 top-up (or a re-stake after a release) revives the same debt:
        // one UNSTAKE still discharges it.
        existing.released = false
        existing.amounts.push(String(spec.amount))
        return existing
    }
    const entry = {
        key:           key,
        addressInfo:   spec.addressInfo,
        source:        spec.addressInfo.address,
        signingPubkey: spec.signingPubkey,
        contractIndex: (spec.contractIndex === undefined) ? null : spec.contractIndex,
        tick:          (spec.tick === undefined) ? null : spec.tick,
        amounts:       [String(spec.amount)],
        released:      false
    }
    ledger.set(key, entry)
    return entry
}

// Record that a stake left the set under its own test's control. Only a FULL
// sweep discharges the debt: a partial UNSTAKE re-stakes the residual, so the
// pubkey is still a member and the run still owes the release.
function noteUnstake(spec){
    if(!spec || !spec.signingPubkey) return null
    if(spec.amount !== undefined && spec.amount !== null) return null
    const entry = ledger.get(entryKey(spec))
    if(!entry) return null
    entry.released = true
    return entry
}

function outstanding(){
    return Array.from(ledger.values()).filter(e => !e.released)
}

function reset(){
    ledger.clear()
}

// The capability's effective signer set at a block, read through the same
// source-keyed view the epoch close resolves R(E) with. Returns null (never
// throws) when the venue cannot answer: an off-BTC chain with no mirrored
// snapshot, or an indexer too old to carry the method. A run that cannot read
// the set says so rather than inventing a baseline of zero, which would make
// every later comparison a false leak.
async function readCapabilitySet(opts){
    const indexer    = opts.indexer
    const capability = opts.capability || DEFAULT_CAPABILITY
    let blockIndex   = opts.blockIndex

    try {
        if(blockIndex === undefined || blockIndex === null){
            const tip = await indexer.call('getblockhashes', {})
            if(!tip || tip.block_index === undefined || tip.block_index === null) return null
            blockIndex = Number(tip.block_index)
        }
        const res = await indexer.call('getstakeweightsbycapability', {
            capability:  capability,
            block_index: blockIndex
        })
        if(!res) return null
        const validators = res.validators || []
        return {
            capability: capability,
            blockIndex: blockIndex,
            pubkeys:    validators.map(v => String(v.pubkey).toLowerCase()),
            sources:    Array.from(new Set(validators.map(v => String(v.source)))),
            byPubkey:   new Map(validators.map(v => [String(v.pubkey).toLowerCase(), v]))
        }
    } catch (err){
        return { error: (err && err.message) ? err.message : String(err), capability: capability }
    }
}

// Pubkeys present now that were not present at bootstrap. Members the run
// REMOVED are not an error: shrinking the set is the direction the policy
// cares about.
function diffAgainstBaseline(baseline, current){
    if(!baseline || baseline.error || !current || current.error) return null
    const before = new Set(baseline.pubkeys)
    const added  = current.pubkeys.filter(p => !before.has(p))
    const removed = baseline.pubkeys.filter(p => !current.pubkeys.includes(p))
    return {
        added:       added,
        removed:     removed,
        beforeCount: baseline.pubkeys.length,
        afterCount:  current.pubkeys.length,
        grew:        current.pubkeys.length > baseline.pubkeys.length || added.length > 0
    }
}

/**
 * Clear the roll-call wedge, if that is what is stopping this teardown, and say
 * whether it did.
 *
 * WHY A TEARDOWN NEEDS THIS AT ALL, which is the whole finding of 2026-09-04. The
 * wedge does not merely fail a drill, IT MANUFACTURES LEAKS. When the BTC indexer
 * parks because the other chain's tip has not passed the roll-call window end,
 * nothing confirms at `status=valid`, so every UNSTAKE broadcast here times out
 * and the ones behind it are never sent. A failed drill that releases cleanly
 * costs one run; a failed drill that cannot release costs every future draw on the
 * venue. So this is the HIGHEST-value place for the clear, not the lowest.
 *
 * INERT WHERE IT DOES NOT APPLY, and that is a hard requirement rather than
 * politeness: this file is a shared root hook for every suite in this tree, not
 * only the attest drills. A single-coin venue, or one with no second rail, must
 * not have its teardown try to mine a chain that is not there, and must NEVER
 * fail a teardown because a clear was impossible. Everything below is wrapped and
 * every unavailable dependency reads as "no clear available" rather than an error.
 *
 * THE PREDICATE IS THE NARROW ONE, both conditions required: behind its own
 * decoder AND the stall reason is the roll-call one. A node stuck for any other
 * reason is a finding to report, not something to mine at, and a clear that
 * swallowed every stall would hide the defect a suite exists to find.
 */
async function clearWedgeIfPresent(log){
    let waits = null
    try {
        // Lazily required, and tolerated absent. The remedy lives beside the
        // attest-mirror drills because that is where it was measured; a tree
        // without that module still tears down normally.
        waits = require('../attestMirror/mirrorDrillWaits')
    } catch (e) {
        return { cleared: false, reason: 'no wedge-clear module in this tree' }
    }
    if(!waits || typeof waits.standingTipProbe !== 'function' || typeof waits.mineDogeBlocks !== 'function'){
        return { cleared: false, reason: 'wedge-clear module has no probe or miner' }
    }

    let sample = null
    try { sample = await waits.standingTipProbe()() } catch (e) { sample = null }
    if(!sample) return { cleared: false, reason: 'the indexer did not answer, so no verdict' }

    const height  = Number(sample.height)
    const decoder = Number(sample.decoder)
    if(!Number.isFinite(height) || !Number.isFinite(decoder)){
        return { cleared: false, reason: 'no height or decoder reading' }
    }
    if(!(height < decoder)){
        return { cleared: false, reason: 'level with its decoder at ' + height + ', so not wedged' }
    }
    const reason = String(sample.reason || '')
    if(reason !== ROLLCALL_STALL_REASON){
        return { cleared: false,
                 finding: true,
                 reason: 'STUCK at ' + height + ' behind its decoder at ' + decoder + ' on ' +
                         (reason || 'no stated reason') + ', which is not the wedge this remedy is for' }
    }

    try {
        const tip = await waits.mineDogeBlocks(waits.DOGE_NUDGE_BLOCKS)
        log('[stake teardown] the indexer was wedged at ' + height + ' behind its decoder at ' + decoder +
            ' on ' + reason + '. That is what stops an UNSTAKE confirming, and it is ordinary on this ' +
            'venue: mined the other chain to ' + tip + ' and retrying.')
        return { cleared: true, reason: reason, dogeTip: tip }
    } catch (e) {
        return { cleared: false, reason: 'the other chain could not be mined: ' + (e && e.message) }
    }
}

// Sweep the run's outstanding stakes. `unstake` is the broadcast+wait callback
// (stakeHelper's sendUnstakeV0 / sendUnstakeV1 shape); `mine` mines the settle
// blocks. Never throws: a stake that cannot be released is a reported failure,
// not a reason to lose the rest of the sweep or the suite's own results.
async function releaseStakes(opts){
    const o        = opts || {}
    const pending  = outstanding()
    const log      = o.log || console.log
    const budgetMs = (o.budgetMs === undefined) ? DEFAULT_BUDGET_MS : o.budgetMs
    const deadline = Date.now() + budgetMs
    const result   = { attempted: 0, released: [], failed: [], skipped: [], mined: 0 }

    if(!pending.length) return result

    log('[stake teardown] releasing ' + pending.length + ' fixture stake(s) so the capability set ' +
        'is left no larger than this run found it')

    for(const entry of pending){
        if(Date.now() > deadline){
            result.skipped.push({ entry: entry, reason: 'teardown budget exhausted' })
            continue
        }
        result.attempted++
        try {
            await o.unstake(entry)
            entry.released = true
            result.released.push(entry)
        } catch (err){
            // ONE retry, and only behind the wedge verdict. The first failure is
            // usually not about this stake at all: a wedged indexer confirms
            // nothing, so the broadcast times out waiting for a status it cannot
            // reach. Clearing between operations and trying once more is what turns
            // a manufactured leak back into a release.
            let clear = { cleared: false, reason: 'not attempted' }
            try { clear = await clearWedgeIfPresent(log) } catch (e) { /* never fail teardown on the clear */ }
            if(clear.finding) log('[stake teardown] ' + clear.reason + ', so nothing was mined for it')
            if(clear.cleared){
                try {
                    await o.unstake(entry)
                    entry.released = true
                    entry.releasedAfterClear = true
                    result.released.push(entry)
                    result.clearedWedges = (result.clearedWedges || 0) + 1
                    continue
                } catch (err2){
                    result.failed.push({ entry: entry, afterClear: true,
                        error: (err2 && err2.message) ? err2.message : String(err2) })
                    continue
                }
            }
            result.failed.push({ entry: entry, clearReason: clear.reason,
                error: (err && err.message) ? err.message : String(err) })
        }
    }

    // Mining is part of the release. UNSTAKE only STAMPS deactivation_block;
    // the key stays in the effective set until that block is reached and
    // buried, so a sweep that stops at broadcast has changed nothing a
    // capability read can see.
    if(result.released.length && o.mine && o.settleBlocks){
        try {
            await o.mine(o.settleBlocks)
            result.mined = o.settleBlocks
            if(o.waitForSync) await o.waitForSync()
        } catch (err){
            result.mineError = (err && err.message) ? err.message : String(err)
        }
    }

    return result
}

// One human-readable block covering the whole policy outcome. Written to be
// diagnosable from a CI log alone: what the run staked, what it gave back, and
// which pubkey is still sitting in the shared venue's quorum arithmetic.
function formatReport(state){
    const lines = []
    const cap   = (state.policy && state.policy.capability) || DEFAULT_CAPABILITY
    lines.push('[stake teardown] capability=' + cap + ' policy=' + (state.policy ? state.policy.reason : 'unknown'))

    if(state.release){
        const r = state.release
        lines.push('[stake teardown] released ' + r.released.length + '/' + (r.released.length + r.failed.length + r.skipped.length) +
                   ' fixture stake(s)' + (r.mined ? ', mined ' + r.mined + ' settle block(s)' : ''))
        for(const f of r.failed)
            lines.push('[stake teardown]   FAILED  ' + f.entry.source + ' / ' + String(f.entry.signingPubkey).slice(0, 16) + '...: ' + f.error)
        for(const s of r.skipped)
            lines.push('[stake teardown]   SKIPPED ' + s.entry.source + ' / ' + String(s.entry.signingPubkey).slice(0, 16) + '...: ' + s.reason)
        if(r.mineError)
            lines.push('[stake teardown]   settle blocks were not mined: ' + r.mineError)
    }

    if(state.baseline && state.baseline.error)
        lines.push('[stake teardown] baseline unreadable (' + state.baseline.error + '): the leak check did not run')
    else if(!state.baseline)
        lines.push('[stake teardown] no baseline was captured: the leak check did not run')
    else if(state.current && state.current.error)
        lines.push('[stake teardown] final read failed (' + state.current.error + '): the leak check did not run')
    else if(state.diff){
        lines.push('[stake teardown] ' + cap + ': ' + state.diff.beforeCount + ' -> ' + state.diff.afterCount + ' member(s)')
        if(state.diff.grew){
            // CLASSIFIED, because three different situations put a key in this list
            // and only one of them is a loss. A bare count cannot tell them apart,
            // and the two that are not losses are the common ones. The distinction
            // is what a reader needs:
            //
            //   UNSTAKE NOT SENT  the release never went out, so the key IS seated
            //                     and stays seated until someone sends one.
            //   NOT YET SETTLED   it went out and was accepted; an UNSTAKE only
            //                     STAMPS deactivation_block, and the key leaves the
            //                     effective set once that block is reached AND
            //                     buried past the reorg buffer the snapshot reads
            //                     at. So this is a timing statement, not a loss.
            //   LEAKED            neither of the above: seated, with no explanation
            //                     this file can offer.
            //
            // Every line carries the block the read was taken at, because a claim
            // about membership without a height is not checkable.
            const at = ' (read at block ' + state.current.blockIndex + ')'
            const rel = state.release || { released: [], failed: [], skipped: [] }
            const sentFor = new Set((rel.released || [])
                .map(e => String(e.signingPubkey).toLowerCase()))
            const notSentFor = new Map()
            for(const f of (rel.failed || []))
                notSentFor.set(String(f.entry.signingPubkey).toLowerCase(), f.error)
            for(const s of (rel.skipped || []))
                notSentFor.set(String(s.entry.signingPubkey).toLowerCase(), s.reason)

            const notSent = [], notSettled = [], leaked = []
            for(const p of state.diff.added){
                const key = String(p).toLowerCase()
                if(notSentFor.has(key))   notSent.push({ pubkey: p, why: notSentFor.get(key) })
                else if(sentFor.has(key)) notSettled.push(p)
                else                      leaked.push(p)
            }

            if(notSent.length){
                lines.push('[stake teardown] UNSTAKE NOT SENT for ' + notSent.length + ' key(s)' + at +
                           ': these are seated because no release was broadcast for them, and they stay ' +
                           'seated until one is. The recorded keys make that possible.')
                for(const n of notSent)
                    lines.push('[stake teardown]   NOT SENT  ' + n.pubkey + ': ' + n.why)
            }
            if(notSettled.length){
                lines.push('[stake teardown] NOT YET SETTLED for ' + notSettled.length + ' key(s)' + at +
                           ': the UNSTAKE was accepted, and the key leaves the effective set once its ' +
                           'deactivation block is reached and buried. This is arithmetic, not a leak; ' +
                           'mine further and re-read before reporting loss.')
                for(const p of notSettled)
                    lines.push('[stake teardown]   NOT SETTLED  ' + p)
            }
            if(leaked.length){
                lines.push('[stake teardown] LEAK: this run left ' + leaked.length + ' key(s) in the shared ' +
                           cap + ' set' + at + '. Every one of them dilutes the operator hub\'s weight share ' +
                           'and moves the venue toward an unreachable quorum.')
                for(const p of leaked)
                    lines.push('[stake teardown]   LEAKED  ' + p)
            }
        }
    }

    return lines.join('\n')
}

// The whole policy, end to end, for the root afterAll. Returns the state it
// built so a caller (or a test) can assert on it. Throws ONLY under strict
// mode and only for an actual leak: a teardown that fails a suite for a
// transport hiccup would teach everyone to switch it off.
async function runTeardown(opts){
    const o     = opts || {}
    const pol   = o.policy || policy(process.env)
    const log   = o.log || console.log
    const state = { policy: pol, baseline: o.baseline || null, release: null, current: null, diff: null }

    if(!pol.release){
        const pending = outstanding()
        state.declined = true
        log('[stake teardown] not releasing ' + pending.length + ' fixture stake(s): ' + pol.reason)
        return state
    }

    if(o.unstake){
        state.release = await releaseStakes({
            unstake:      o.unstake,
            mine:         o.mine,
            waitForSync:  o.waitForSync,
            settleBlocks: pol.settleBlocks,
            budgetMs:     pol.budgetMs,
            log:          log
        })
    }

    if(pol.check && o.indexer && state.baseline && !state.baseline.error){
        state.current = await readCapabilitySet({ indexer: o.indexer, capability: pol.capability })
        state.diff    = diffAgainstBaseline(state.baseline, state.current)
    }

    log(formatReport(state))

    if(pol.strict && state.diff && state.diff.grew)
        throw new Error('stake teardown: this run left ' + state.diff.added.length + ' key(s) in the ' +
                        pol.capability + ' set (' + state.diff.beforeCount + ' -> ' + state.diff.afterCount +
                        '); see xchain-documentation/components/e2e-test/staking-venue-policy.md')

    return state
}

module.exports = {
    DEFAULT_CAPABILITY,
    RELEASE_SETTLE_BLOCKS,
    DEFAULT_BUDGET_MS,
    policy,
    registerStake,
    noteUnstake,
    outstanding,
    reset,
    readCapabilitySet,
    captureBaseline: readCapabilitySet,
    diffAgainstBaseline,
    releaseStakes,
    clearWedgeIfPresent,
    ROLLCALL_STALL_REASON,
    formatReport,
    runTeardown
}
