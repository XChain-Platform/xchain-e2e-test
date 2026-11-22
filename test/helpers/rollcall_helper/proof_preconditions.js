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
const crypto = require('crypto')
const fs = require('fs')
const chainRail = require('../chainRail')
const {
    ROLLCALL_REGTEST_ARMING_ENV,
    indexerModule,
    internalResolveSiblingIfPresent,
    rca,
} = require('./sibling_resolution')

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// The DOGE peer's own report of its vendored action-manifest hash. This is the
// fifth and least obvious `unknown` condition in RollcallProofClient: a peer that
// cannot name its manifest can never match ours, so EVERY close defers forever,
// with no signal anywhere except a stalled indexer.
//
// Measured on the venue 2026-08-30: the DOGE regtest indexer answers
// manifest_hash null, because xchain-indexer's Dockerfile copies only src/,
// data/genesis and the package files, so test/fixtures/action-manifest.json is
// absent from the running image on BOTH sides.
async function assertDogePeerManifest(dogeConn, network){
    const res = await dogeConn.call('getrollcallsigners', {
        network: network, epoch_height: 0, max_block_time: 0, pubkeys: [], publishers: [],
    })
    assert.ok(res && !res.error,
        'ROLLCALL precondition: the DOGE indexer refused getrollcallsigners: ' + JSON.stringify(res && res.error) +
        '. That read is a FEDERATION_READ_METHOD; set DOGE_INDEXER_API_KEY / INDEXER_API_KEY or run the DOGE ' +
        'venue with INDEXER_ALLOW_UNAUTHENTICATED=true.')

    assert.ok(/^[0-9a-f]{64}$/.test(String(res.manifest_hash || '')),
        'ROLLCALL precondition FAILED: the DOGE indexer reports manifest_hash=' + JSON.stringify(res.manifest_hash) +
        ' rather than a sha256. RollcallProofClient condition (5) compares that value against the BTC ' +
        'indexer\'s own vendored test/fixtures/action-manifest.json and DEFERS on any difference, and a null ' +
        'can never match, so every epoch close would stall forever with no other symptom.\n' +
        'Cause on a containerized venue: xchain-indexer/Dockerfile copies src/, data/genesis and the package ' +
        'files only, so test/fixtures/action-manifest.json is not in the image. Ship that fixture into both ' +
        'indexer images (or bind-mount it) before driving any close.')

    // The BTC side's copy is not readable over any RPC, so this is the closest
    // check available: the local sibling checkout's fixture, which is what a
    // correctly built image carries. A difference is reported rather than
    // asserted, because a legitimately newer venue may lead the checkout.
    //
    // ABSENCE is detected, never caught. Wrapping the read in try/catch would
    // also swallow a sibling that is present but unreadable, and the suite would
    // go green having compared nothing - the false-green shape the repo's own
    // vmFalseGreen guard exists to refuse.
    let localHash = null
    const localManifest = internalResolveSiblingIfPresent('xchain-indexer', 'test/fixtures/action-manifest.json')
    if (localManifest){
        localHash = crypto.createHash('sha256').update(fs.readFileSync(localManifest)).digest('hex')
    }
    if (localHash && localHash !== String(res.manifest_hash)){
        console.warn('    [rollcall] DOGE peer manifest_hash ' + String(res.manifest_hash).slice(0, 16) +
                     '... differs from this checkout\'s ' + localHash.slice(0, 16) + '...; the BTC indexer must ' +
                     'carry the SAME fixture as the DOGE indexer or every close defers on condition (5).')
    }
    return { manifestHash: String(res.manifest_hash), hcut: res.hcut, tip: res.tip_block_index }
}

// The BTC indexer must be wired to a DOGE indexer (DOGE_INDEXER_API_URL), or the
// proof client's condition (1) makes every close throw
// RollcallProofUnavailableError and the block is retried forever.
//
// Nothing on the indexer's RPC surface reports its own env, so this measures the
// two observable consequences instead:
//   (a) a stalled tip: the indexer sitting below the node with its next block
//       being an epoch close is the exact signature of a deferring close;
//   (b) a silent close: every close height already at or below the indexed tip
//       must have written a `rollcalls` row, because the close writes one on
//       every path it can reach, including the unrolled ones.
// Measured on the venue 2026-08-30: `printenv | grep '^DOGE'` on the BTC indexer
// container returned nothing.
async function assertBtcProofWiring(nodeConn, idxConn, idxQuery, network){
    const tipRes = await idxConn.call('getblockhashes', {})
    // Reassigned by the DOGE-lag recovery below, which advances it on purpose.
    let idxTip = Number(tipRes.block_index)
    const nodeTip = Number(await nodeConn.getBlockCount())

    const r = rca()
    const nextClose = (() => {
        for (let h = idxTip + 1; h <= idxTip + 1 + r.ROLLCALL_INTERVAL_BLOCKS[network]; h++)
            if (r.rollcallEpochClosingAt(h, network) !== null) return h
        return null
    })()

    if (nodeTip > idxTip && nextClose === idxTip + 1){
        // A STALL AT A CLOSE BLOCK HAS TWO CAUSES, AND NAMING ONLY THE WRONG ONE
        // COSTS HOURS. Missing DOGE wiring is permanent and needs an operator; a
        // DOGE tip that has not yet passed the BTC window-end stamp is ORDINARY
        // and clears by mining DOGE, because regtest DOGE blocks are stamped at
        // wall clock. The benign case is also the common one between runs: any
        // BTC-only mining (a seeding run, another lane's suite) can walk the
        // indexer onto a close whose epoch nobody has driven, and it then sits
        // there until some DOGE block is mined. It cost three bring-ups on
        // 2026-09-03, each reported as "set DOGE_INDEXER_API_URL" on a venue
        // whose DOGE_INDEXER_API_URL was set and correct.
        //
        // So clear the benign one HERE rather than describing it: mine DOGE, give
        // the indexer a moment, and re-read. Only a tip that STILL will not move
        // is the operator's problem, and the message then carries both causes.
        console.log('    [rollcall] BTC indexer parked at ' + idxTip + ' with node at ' + nodeTip +
                    '; block ' + (idxTip + 1) + ' closes epoch ' + r.rollcallEpochClosingAt(idxTip + 1, network) +
                    '. Mining DOGE so the close can decide.')
        let cleared = false, dogeErr = null
        try {
            const rail = await chainRail.createRail('dogecoin', network)
            for (let attempt = 0; attempt < 3 && !cleared; attempt++){
                await rail.globals.regtestMinerConnector.generateBlocks(4)
                for (let poll = 0; poll < 10 && !cleared; poll++){
                    await sleep(3000)
                    const now = Number((await idxConn.call('getblockhashes', {})).block_index)
                    if (now > idxTip){ cleared = true; idxTip = now }
                }
            }
        } catch (e) { dogeErr = (e && e.message) || String(e) }

        if (!cleared){
            throw new Error(
                'ROLLCALL precondition FAILED: the BTC indexer is stalled at ' + idxTip + ' while the node is at ' +
                nodeTip + ', and its next block ' + (idxTip + 1) + ' is the close of epoch ' +
                r.rollcallEpochClosingAt(idxTip + 1, network) + '. That is a DEFERRING epoch close, and mining ' +
                'DOGE did not clear it' + (dogeErr ? ' (the DOGE rail itself failed: ' + dogeErr + ')' : '') +
                '. Two causes, in the order worth checking:\n' +
                '  1. The BTC indexer has no DOGE peer to ask, so RollcallProofClient returns unknown and the ' +
                'block is retried forever. Set DOGE_INDEXER_API_URL (and DOGE_INDEXER_API_KEY if the DOGE ' +
                'indexer is keyed) on the BTC indexer and restart it. Check this first: it is the permanent one.\n' +
                '  2. The DOGE peer is reachable but its answer is still undecidable - its tip has not passed the ' +
                'BTC window-end stamp, or the cut is not buried by ROLLCALL_DOGE_MATURITY, or its vendored ' +
                'manifest_hash does not match. The first two clear by mining DOGE, which is what just failed here, ' +
                'so read the BTC indexer log for the exact `ROLLCALL PROOF UNAVAILABLE` reason.')
        }
        console.log('    [rollcall] cleared: the BTC indexer advanced to ' + idxTip)
    }

    // Every close at or below the indexed tip wrote a row, or the close is not
    // running on this indexer at all.
    const due = []
    for (let h = 0; h <= idxTip; h++) if (r.rollcallEpochClosingAt(h, network) !== null) due.push(h)
    if (due.length > 0){
        let rows
        try {
            rows = await idxQuery('SELECT close_block FROM rollcalls WHERE close_block <= ?', [idxTip])
        } catch (e) {
            throw new Error(
                'ROLLCALL precondition FAILED: the BTC indexer DB has no readable `rollcalls` table (' +
                (e && e.message) + '). Apply src/sql/migrations/2026-08-30-rollcall-tables.sql to the indexer ' +
                'database before driving any close.')
        }
        const have = new Set(rows.map(x => Number(x.close_block)))
        const gaps = due.filter(h => !have.has(h))
        assert.strictEqual(gaps.length, 0,
            'ROLLCALL precondition FAILED: the BTC indexer has indexed past close block(s) ' +
            gaps.join(', ') + ' but wrote no `rollcalls` row for them. Either this indexer predates ' +
            'src/consensus/rollcall_close.js, or those blocks were indexed while ROLLCALL was inert on IT. The ' +
            'deployed indexer needs ' + ROLLCALL_REGTEST_ARMING_ENV + '=armed in its own environment ' +
            '(this harness sets that variable only for itself, and the activation map is read once at ' +
            'startup) as well as DOGE_INDEXER_API_URL. Set both, restart, and reindex from below block ' +
            gaps[0] + ' before driving the acceptance tests, or every verdict below is read from a rail ' +
            'that never ran.')
    }
    return { idxTip, nodeTip, nextClose }
}

// getrollcalls / getrollcallabsences are the two PLAIN PUBLIC reads the AT list
// quotes. Their DB half (db.js getRollcalls / getRollcallAbsencesBySource) is
// landed; the RPC half was still in flight when this harness was written, and
// is absent from the BTC regtest indexer as measured 2026-08-30. A suite that
// asserted on them without checking would fail with "Method not found" halfway
// through a twenty-minute drive.
async function probePublicRollcallReads(conn){
    const out = {}
    for (const m of ['getrollcalls', 'getrollcallabsences']){
        try {
            const params = m === 'getrollcalls' ? { limit: 1 } : { source: 'rollcall-probe-unknown-source', limit: 1 }
            const res = await conn.call(m, params)
            out[m] = (res && res.error) ? { present: true, error: res.error } : { present: true, sample: res }
        } catch (e) {
            out[m] = { present: false, why: String((e && e.message) || e) }
        }
    }
    return out
}

function assertPublicRollcallRead(probe, method){
    assert.ok(probe[method] && probe[method].present,
        'ROLLCALL precondition FAILED: the BTC indexer does not serve `' + method + '` (' +
        (probe[method] && probe[method].why) + '). Its DB half is landed (xchain-indexer src/db/rollcalls.js ' +
        (method === 'getrollcalls' ? 'getRollcalls' : 'getRollcallAbsencesBySource') + ') but the JSON-RPC ' +
        'method is not deployed on this indexer. Deploy the public-read push, or run with ' +
        'XC_ROLLCALL_SKIP_PUBLIC_READS=1 to assert the same facts from the indexer DB only.')
}

// AT1 asserts the idle source is NOT evicted after its first driven epoch,
// which is only true if that epoch is its FIRST rolled absence. The K-streak
// walks the last 2K ROLLED epochs and skips unrolled ones (D39), so a venue that
// has ever rolled an epoch with this source absent carries a head start that no
// amount of driving can undo.
//
// Measured on the venue: epoch 240 rolled with the idle source absent, epochs
// 270-390 all closed unrolled and were skipped, and the very first epoch this
// suite drove completed K=2 and evicted immediately. The protocol was right; the
// suite was reading a venue with history as if it were clean, and reported a
// correct eviction as a failure.
//
// A FRESH source address has no history by construction, which is the same
// rotation the ledger item forces after an eviction anyway - so the remedy for
// both is one step.
//
// CHECKED FOR EVERY ROSTER SOURCE, not only the idle one. The earlier version
// read the idle source alone and therefore watched the wrong member get evicted:
// AT2 silences a live hub across a rolled epoch, so a signing source with prior
// absences completes K exactly as the idle one does, and on 2026-09-01 hub 2 was
// evicted at epoch 930 with this check green. A signing key's eviction is worse
// than the idle key's, because the signing seeds are the frozen vector's and can
// never be rotated.
// `allowDirtyStreaks` is for a venue run that SILENCES NOBODY. The guard exists
// because a silenced hub completes a streak and the protocol then evicts a frozen
// vector key; a drive with every hub present adds no absence to any roster source,
// so it cannot complete anything, and it is the only way to age a stale absence
// out of the 2K-rolled-epoch window (the remedy this very assertion names). A
// run that passes it must therefore keep silentHubs empty.
async function assertRosterStreaksClean(ctx, allowDirtyStreaks){
    const dirty = []
    let read = 0

    // THE WINDOW, not the whole history. The protocol's streak walks the last
    // ROLLCALL_STREAK_LOOKBACK (2K) ROLLED epochs and skips unrolled ones
    // (getRolledRollcallEpochs), so an absence older than that counts for
    // nothing and a check that flags it is stricter than the rule it protects.
    // That difference is not academic: it made the remedy this assertion itself
    // names - drive 2K rolled epochs with the hub present until the absence ages
    // out - fail to satisfy the assertion afterwards, which is the worst shape a
    // guard can have. Measured 2026-09-03: hub 2's absence at epoch 2160 was
    // still reported after four later rolled epochs had pushed it out of the
    // window and the protocol had long stopped counting it.
    const lookback = Number(rca().ROLLCALL_STREAK_LOOKBACK)
    let window = null
    try {
        const res = await indexerConnector.call('getrollcalls', { limit: 200 })
        if (res && !res.error && Array.isArray(res.rollcalls)){
            const rolled = res.rollcalls
                .filter(r => Number(r.rolled) === 1)
                .map(r => Number(r.epoch_height))
                .sort((a, b) => b - a)
                .slice(0, lookback)
            window = new Set(rolled)
        }
    } catch (e) { window = null }   // the public read is probed separately

    for (const entry of ctx.roster){
        const source = ctx.fed.byPubkey.get(entry.pubkey)
        if (!source) continue
        let res
        try {
            res = await indexerConnector.call('getrollcallabsences', { source: String(source), limit: 50 })
        } catch (e) {
            return null   // the public read is probed separately; do not fail twice on it
        }
        if (!res || res.error) return null
        read++
        // Only absences the protocol would still count: inside the window when
        // one could be computed, and every recorded absence when it could not,
        // because failing closed on an unreadable window is the safe direction.
        const rolled = (res.absences || [])
            .filter(a => Number(a.epoch_height) >= 0)
            .filter(a => window === null || window.has(Number(a.epoch_height)))
        if (rolled.length) dirty.push({ entry, source, rolled })
    }
    if (!dirty.length) return { priorAbsences: 0, sourcesRead: read }

    if (allowDirtyStreaks === true){
        console.warn(
            '\n    [rollcall] ' + dirty.length + ' roster source(s) carry prior absence(s), and this run ' +
            'continues because it silences NOBODY:\n' +
            dirty.map(d => '        [' + d.entry.index + '] ' + d.source + '   ' + d.entry.role +
                           '   epoch(s) ' + d.rolled.map(a => a.epoch_height).join(', ')).join('\n') + '\n' +
            '    Every hub present means no roster source gains an absence, so no streak can complete and no ' +
            'key can be retired. Driving 2K rolled epochs this way is what ages a stale absence out of the ' +
            'window, which is the remedy an acceptance run needs. Keep silentHubs EMPTY for the whole run.\n')
        return { priorAbsences: dirty.length, sourcesRead: read, dirty: dirty.map(d => d.source) }
    }

    assert.fail(
        'ROLLCALL precondition FAILED: ' + dirty.length + ' roster source(s) already carry recorded ' +
        'absence(s) on this venue:\n' +
        dirty.map(d =>
            '    [' + d.entry.index + '] ' + d.source + '   ' + d.entry.role + '   epoch(s) ' +
            d.rolled.map(a => a.epoch_height).join(', ') +
            (d.rolled.some(a => Number(a.evicted) === 1) ? '   ALREADY EVICTED' : '')).join('\n') + '\n' +
        'The K-streak counts ROLLED epochs and skips unrolled ones, so each of these starts with a head ' +
        'start and the first epoch this suite drives may complete K=2 and evict immediately - which AT1 ' +
        'reads as "evicted on a streak of 1" and reports as a protocol failure when the protocol was right. ' +
        'On a SIGNING source it is worse than a bad reading: AT2 silences a live hub on purpose, so the ' +
        'streak completes and the protocol evicts a frozen vector key that can never be staked again.\n' +
        'Remedy for the IDLE source: bump XC_ROLLCALL_IDLE_GENERATION (removing any XC_ROLLCALL_IDLE_SEED ' +
        'pin) and re-run test/tools/rollcall_seed_federation.test.js, which mints a fresh key at a fresh ' +
        'address.\n' +
        'The window here is the last ' + lookback + ' ROLLED epoch(s)' +
        (window ? ': ' + Array.from(window).join(', ') : ' (unreadable, so every recorded absence counts)') + '.\n' +
        'Remedy for a SIGNING source: its address cannot be rotated - STAKE v1 refuses a pubkey that has ' +
        'ever been staked, from any source - so either drive 2K rolled epochs with that hub PRESENT until ' +
        'the old absence ages out of the window, or drive on a fresh chain. A signing key that was actually ' +
        'EVICTED leaves only the fresh chain.')
}

module.exports = {
    assertDogePeerManifest,
    assertBtcProofWiring,
    probePublicRollcallReads,
    assertPublicRollcallRead,
    assertRosterStreaksClean,
}
