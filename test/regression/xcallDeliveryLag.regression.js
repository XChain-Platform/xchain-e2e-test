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
 * Regression: cross-chain call relay must not fork a LIVE node from a
 * REPLAYING node under hub delivery lag.
 *
 * The bug: a relayed cross_chain_calls row gates injection on
 * `effective_time <= block_time`. A replaying node always has the row when it
 * reaches the first eligible block, so it injects the XEXEC/callback there. A
 * LIVE node only has the row once the hub has written + delivered it; if that
 * lands even one block after the eligible block, the live node injects later,
 * permanently shifting its action-index counter (EMITTER_ACTION_INDEX is in the
 * call_id preimage) and desynchronizing every subsequent call. The full-stack
 * cross-chain e2e suites cannot see this: they run single-process with ZERO
 * delivery lag, so live and replay coincide and the suite is structurally
 * false-green for this class.
 *
 * The fix: the hub stamps `effective_time` a relay margin into the FUTURE of
 * every chain's tip, so the row is present everywhere before any chain reaches
 * its eligible block, making row-arrival timing irrelevant. This test models
 * the deterministic injection rule with a synthetic delivery lag and asserts
 * that, using the REAL hub margin, the live and replay paths inject at the SAME
 * block (identical call_id). It also documents that with margin 0 they diverge.
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const crypto     = require('crypto');
const path       = require('path');

// Resolve the real hub CrossChainCallEngine so this test tracks the actual margin
// policy (not a copy that could drift). Honors XCHAIN_HUB_PATH like the multi-hub
// integration suite; skips cleanly if the hub source isn't reachable.
function loadEngine(){
    const candidates = [
        process.env.XCHAIN_HUB_PATH && path.join(process.env.XCHAIN_HUB_PATH, 'src/CrossChainCallEngine.js'),
        path.join(__dirname, '../../../xchain-hub/src/CrossChainCallEngine.js'),
        path.join(__dirname, '../../xchain-hub/src/CrossChainCallEngine.js')
    ].filter(Boolean);
    for(const c of candidates){
        try { return require(c); } catch(e){ /* try next */ }
    }
    return null;
}

// Minimal hub stub: the engine constructor only reads these; it opens nothing.
function makeEngine(CrossChainCallEngine){
    const hub = {
        db: { async doQuery(){ return []; } },
        p2pConfig: {},
        hubDbBroadcaster: null,
        capabilitySnapshot: null,
        getPeerManager: () => null,
        getIdentity: () => null
    };
    const engine = new CrossChainCallEngine(hub);
    engine.consensus = { propose: async () => {}, start(){}, stop(){}, on(){} };
    return engine;
}

// The deterministic injection rule, modeled per node: inject at the FIRST block
// whose block_time >= effective_time AND for which the node already holds the row.
// `rowVisibleAt` is the wall-clock second the row becomes visible to this node
// (replay: -Infinity = always; live: the hub finalize/deliver instant). A block at
// height h has block_time = t0 + h*interval and is processed at wall-clock ~= its
// block_time at the live tip.
function injectionBlock({ effectiveTime, rowVisibleAt, t0, interval, maxBlocks }){
    for(let h = 0; h < maxBlocks; h++){
        const blockTime = t0 + h * interval;
        if(blockTime < effectiveTime) continue;          // not yet eligible
        if(blockTime < rowVisibleAt)  continue;           // row not present when this block was processed
        return h;
    }
    return null;
}

// call_id is preimage-bound to the action index allocated at the injecting block,
// so a different injection block produces a different call_id. Model that linkage.
const callId = (injBlock) =>
    crypto.createHash('sha256').update('XCALL|inj@' + injBlock).digest('hex');

describe('[regression:p0] XCALL relay: live/replay determinism under hub delivery lag', function(){

    const CrossChainCallEngine = loadEngine();
    before(function(){
        if(!CrossChainCallEngine) this.skip();           // hub source not reachable in this env
    });

    // DOGE target chain: 60s blocks. The hub finalizes the relay row at wall-clock
    // `finalizeT`; a one-block delivery lag means the live node first sees it 60s later.
    const INTERVAL    = 60;
    const T0          = 1_781_226_000;     // block 0 wall-clock (the live evidence window)
    const FINALIZE_T  = T0 + 113;          // hub writes the row ~here (mirrors the 2026-06-12 run)
    const DELIVERY_LAG = INTERVAL;         // live node sees the row one block late

    it('WITHOUT a margin (effective_time = finalize instant) the live node forks from replay', function(){
        // This is the pre-fix behavior, asserted here so the test documents exactly
        // what the fix prevents (and would catch a regression that zeroed the margin).
        const effectiveTime = FINALIZE_T;                          // no margin
        const replay = injectionBlock({ effectiveTime, rowVisibleAt: -Infinity, t0: T0, interval: INTERVAL, maxBlocks: 500 });
        const live   = injectionBlock({ effectiveTime, rowVisibleAt: FINALIZE_T + DELIVERY_LAG, t0: T0, interval: INTERVAL, maxBlocks: 500 });
        expect(live).to.not.equal(replay);                         // injection blocks diverge...
        expect(callId(live)).to.not.equal(callId(replay));         // ...so call_id diverges -> fork
    });

    it('WITH the real hub relay margin, live and replay inject at the same block (same call_id)', function(){
        const engine = makeEngine(CrossChainCallEngine);
        // The fix: effective_time = finalize instant + a DOGE-sized margin into the future.
        const margin = engine._relayEffectiveTime('DOGE') - Math.floor(Date.now() / 1000);
        expect(margin).to.be.greaterThan(0);                       // the margin must be real
        const effectiveTime = FINALIZE_T + margin;

        const replay = injectionBlock({ effectiveTime, rowVisibleAt: -Infinity, t0: T0, interval: INTERVAL, maxBlocks: 1000 });
        const live   = injectionBlock({ effectiveTime, rowVisibleAt: FINALIZE_T + DELIVERY_LAG, t0: T0, interval: INTERVAL, maxBlocks: 1000 });

        // The margin pushes the eligible block past the row's delivery, so BOTH nodes
        // first see an eligible block that already holds the row -> identical injection.
        expect(live).to.equal(replay);
        expect(callId(live)).to.equal(callId(replay));
    });

    it('the margin exceeds a realistic one-block delivery lag for every chain', function(){
        const engine = makeEngine(CrossChainCallEngine);
        const now = Math.floor(Date.now() / 1000);
        // Margin (seconds) must comfortably exceed a single block interval of the
        // gating chain, which is the lag the live evidence showed forking the federation.
        expect(engine._relayEffectiveTime('DOGE') - now).to.be.greaterThan(60);
        expect(engine._relayEffectiveTime('LTC')  - now).to.be.greaterThan(150);
        expect(engine._relayEffectiveTime('BTC')  - now).to.be.greaterThan(600);
    });
});
