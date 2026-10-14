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
 **********************************************************************/

// The BTC tip the hubs are fed for the life of the drill.

const assert = require('assert')

const { jsonSafe } = require('../helpers/mirrorDrillWaits')
const { TIP_FEED_MS } = require('./config.test.js')


/**
 * Push the node's CURRENT BTC tip (height and block time) to every venue hub.
 * Returns the per-hub results (null where a hub refused or was unreachable),
 * with `.tip` set to the height pushed. `XChainHubConnector` exposes `_call(body)`
 * over a full JSON-RPC body and returns the RESULT, or null when every endpoint
 * failed or the hub answered with an error. There is no `.call`:
 * `hub.connector.call is not a function` was this drill's first line past its
 * venue boot on 2026-09-05, the same shape the federation capture documents.
 */
async function pushLiveTipToAllHubs (ctx) {
    // THE BTC NODE CAPTURED BEFORE ANY RAIL SWITCH, never the global. `chainRail.withRail`
    // swaps `global.nodeConnector` (and its siblings) to the DOGE rail for the duration
    // of every DOGE nudge, and this runs on a timer: pass 9 (2026-09-05) read the
    // DOGE height through the global mid-swap and pushed it as the BTC tip, so every
    // hub's batch anchor became the DOGE height (4236, 4252, ...).
    const tip = Number(await ctx.btcNode.getBlockCount())
    const block = await ctx.btcNode.getBlock(await ctx.btcNode.getBlockHash(tip))
    const results = []
    for (const hub of ctx.venue.hubs) {
        // `coin` is the hub's chain TICKER: `validateChain` admits BTC, LTC and
        // DOGE and nothing else, and a refused push comes back as a RESULT
        // object carrying `error`, not as a JSON-RPC error and not as null.
        // Passes 6 and 7 (2026-09-05) sent `bitcoin`, were refused on every hub
        // every time, and read the refusal as success through a null check;
        // the followers then held no chain_tips row and refused to co-sign every
        // window (`tip unresolved: no BTC chain_tips row exists`).
        const res = await hub.connector['_call']({
            jsonrpc: '2.0', id: Date.now(), method: 'pushchaintip',
            params: { coin: 'BTC', network: ctx.venue.network, block_height: tip, block_time: Number(block.time) },
        }).catch((e) => ({ error: String(e && e.message) }))
        results.push(res && !res.error && String(res.status) === 'success' ? res : { error: jsonSafe(res) })
    }
    results.tip = tip
    return results
}

/** Push once, assert every hub took it, then keep pushing on a timer. */
async function startTipFeed (ctx) {
    // THE ANCHOR. Without a BTC chain tip every hub defers every window with a
    // latched warning and publishes nothing, which reads exactly like a publisher
    // that is broken. Pushed to every hub, since any of them may be elected.
    //
    // AND KEPT LIVE, NOT PINNED. The same `chain_tips` row is the FIRST source
    // `XChainHub.resolveBtcLatestBlock` consults for every attestation round
    // (consensus/pbft.js), preferred over the live indexer while its block_time is
    // younger than MAX_TIP_AGE_S (default twice the oracle round interval, 20
    // min). Pass 6 (2026-09-05) pushed the tip ONCE at 7405: the responsible
    // hubs then measured every request against a height the 6 s miner left
    // behind within seconds, saw it as unconfirmed, and executed nothing; the
    // 60-block deadline (about 6 min) expired long before the row went stale,
    // so 0 of 5 hubs ever held a finalized row. A co-located indexer re-pushes on
    // every block in production; the venue's hubs have no such feeder, so this
    // drill is one, for its whole life, cleared in the after-hook.
    const first = await pushLiveTipToAllHubs(ctx)
    for (const [i, res] of first.entries()) {
        assert.ok(!res.error,
            'hub ' + i + ' refused the chain tip push (or was unreachable), so it will defer ' +
            'every window and co-sign none: ' + res.error + '; last failures: ' +
            JSON.stringify(ctx.venue.hubs[i].connector.lastFailures || []))
    }
    console.log('AT5: pushed BTC tip ' + first.tip + ' to all ' + ctx.venue.hubs.length + ' hubs (status success on each); ' +
        'feeding the live tip every ' + (TIP_FEED_MS / 1000) + ' s from here on')
    let feedFailuresReported = 0
    ctx.tipFeeder = setInterval(() => {
        if (ctx.tipFeedBusy) return
        ctx.tipFeedBusy = true
        pushLiveTipToAllHubs(ctx).then((r) => {
            const bad = r.map((x, i) => (x.error ? 'hub ' + i + ': ' + x.error : null)).filter(Boolean)
            // Said once, not every 3 s: a refusal that starts mid-drill is the
            // thing to read, and a wall of the same line hides it.
            if (bad.length && feedFailuresReported++ === 0) console.log('AT5: tip feed refused: ' + bad.join('; '))
        }).catch(() => null).then(() => { ctx.tipFeedBusy = false })
    }, TIP_FEED_MS)
}

module.exports = { pushLiveTipToAllHubs, startTipFeed }
