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
 * XChain Platform E2E - Chunked DEPLOY reorg drill
 *
 * Proves the chunked-DEPLOY reorg-safety property the handler relies on
 * (deploy/index.js): "assembly never consumes a chunk that does not precede it ->
 * any reorg dropping a chunk also drops the dependent DEPLOY, so rollback
 * needs no bespoke logic." A v2 assembling DEPLOY reads only VALID v4 chunk
 * carriers at a LOWER action_index, so the carriers are strictly below the
 * contract in block order. Orphaning the FIRST chunk's block therefore orphans
 * every chunk AND the dependent contract.
 *
 * The drill:
 *   1. Chunk-deploys a large contract (DEPLOY v4 carriers + assembling DEPLOY v2)
 *      inside a BOUNDED block window, so the contract is live with constructor state.
 *   2. Orphans the block carrying the FIRST chunk carrier by building an EMPTY
 *      competing chain (auto-mining held, generateBlock(addr, []) using the same
 *      mechanism as reorgBalances.test.js / xcallSourceReorgDrill), and asserts
 *      rollback.js cascaded the removal: NO deploy_chunks rows, NO contracts row,
 *      and NO contract_state for that code_hash survive on the orphan branch.
 *      Then, in the SAME test, REPLAYS the orphaned window onto the new branch
 *      block by block, each block carrying exactly the transactions it carried
 *      before the reorg and in the same order (see the contract below).
 *   3. Asserts the contract reassembles DETERMINISTICALLY (same code_hash,
 *      byte-identical constructor state) and still runs - proving an
 *      order-preserving reorg cannot corrupt a chunk-assembled contract.
 *
 * REORG CONTRACT. Leg 3 could hang for 240s with the contract never
 * reappearing. Four assumptions were wrong; all four are enforced here:
 *
 *   a) DEPTH. A reorg is not free: the utxo-tracker aborts and HALTS (fail-closed)
 *      once a rollback passes its UNDO_BLOCKS=12 spent-output recovery window, and
 *      the decoder does the same at DISPENSER_EXPIRE_SAFE_DEPTH=126. A halted tracker
 *      wedges the whole venue until an operator resync, which is what "leg 3 never
 *      finishes" actually looked like. The drill therefore holds the auto-miner for
 *      the whole deploy and mines exactly one block per action, so the window it
 *      orphans is a handful of blocks, and it refuses to invalidate at all beyond
 *      ORPHAN_DEPTH_LIMIT.
 *   b) ORDER, NOT JUST PRESENCE. Getting the transactions back is necessary and not
 *      sufficient. A chunked deploy is order-dependent: the assembling DEPLOY v2 is
 *      evaluated at ITS position and needs every carrier already indexed, so carriers
 *      must precede it in (block, tx) order. Nothing in the mempool preserves that.
 *      The carriers and the assembler are funded from separate UTXOs of the deployer,
 *      not chained parent-to-child, so consensus imposes NO order between them; when
 *      the auto-miner drained the resurrected mempool it packed all three actions into
 *      one block by ancestor-feerate and put the ASSEMBLER FIRST. Measured on a BTC
 *      regtest venue: after the reorg the carriers re-indexed valid at
 *      action_index 450/451 (chunk 1 before chunk 0) with the assembler ahead of both
 *      at 449 - it assembled against zero carriers, went invalid, and is never retried,
 *      so the contract simply never came back and leg 3 burned its whole 240s. The node
 *      also gives back less than it took (Bitcoin Core only resurrects disconnected
 *      transactions for the first TEN blocks it disconnects - validation.cpp
 *      InvalidateBlock: `fAddToMempool = (++disconnected <= 10)`), so relying on the
 *      mempool is doubly wrong. The drill therefore snapshots the raw hex of every
 *      transaction it is about to orphan GROUPED BY BLOCK, in position, and replays the
 *      window with generateblock(payout, [rawhex...]) one block per original block.
 *      That takes raw hex and ignores the mempool, so it re-injects and orders in one
 *      step. What this proves is the real invariant: a reorg that preserves transaction
 *      order cannot change WHAT gets built, only WHERE.
 *
 *      REORDERING IS THE OTHER CASE, and it is the one DEPLOY_DEFERRED_ASSEMBLY
 *      exists for. PRE-activation an assembler a reorg pushed ahead of its carriers
 *      is legitimately invalid and the deployer must re-send it, which is why this
 *      drill preserves order rather than asserting determinism across a reorder.
 *      POST-activation the group deploys at whichever piece lands LAST, so the same
 *      reordered window rebuilds the same contract at a different action_index -
 *      that is chunkedDeployDeferred.sdk.test.js (AT5), not this drill, which keeps
 *      pinning the order-preserving invariant on both sides of the flag day.
 *   c) IDENTITY. The source carries a per-run marker, so the code_hash - and therefore
 *      the deploy_chunks group this drill resolves - belongs to THIS run. The source
 *      had a fixed value, so on any stack that had run the drill before,
 *      MIN(block_index) resolved to a chunk row from an EARLIER run and the drill
 *      invalidated thousands of blocks deep, tripping (a) and (b) every time.
 *   d) NO TEST BOUNDARY BETWEEN THE REORG AND THE REPLAY. This is what actually
 *      broke the drill, and it is a harness fact, not a node fact: initialCheck's root
 *      afterEach quiesces the stack via utxoTrackerConnector.quiesce(), which mines a
 *      block through the regtest miner whenever mempool_size > 0 (an explicit
 *      generate_blocks, so pauseMining does NOT hold it). Every reorg leaves the
 *      disconnected transactions sitting in the mempool, so the hook fired between the
 *      old leg 2 and leg 3 and mined the entire orphaned window into ONE block in
 *      mempool order - which is how the assembler ended up ahead of its carriers per
 *      (b). Measured on the BTC regtest venue: leg 2 ended with mempool=6 and the miner
 *      at 4372 blocks, leg 3 opened with mempool=0, an 8-tx tip block, and the miner at
 *      4373, still flagged paused. The reorg and the replay therefore live in ONE `it`,
 *      and that test hands back a mempool with nothing of this drill's in it.
 *   e) SHARED VENUE. Closing (d) is not enough on a stack another suite may be using:
 *      that suite's own quiesce hook drains OUR resurrected window just as happily
 *      (observed mid-run: a second harness started, and the window got mined while this
 *      drill sat in its rollback wait). So the replay does not assume the window is
 *      still unconfirmed - it EVICTS any block that has already swallowed part of it
 *      (invalidateblock, which puts those txs back in the mempool) and then places the
 *      window itself, retrying, and verifying each tx landed in the block the drill
 *      built for it. Evicting is safe here and only here: these blocks sit above the
 *      fork this drill already created, well inside the depth budget in (a).
 *
 * There is deliberately no pre-reorg EXECUTE: it would cost blocks against (a), and
 * its wire params name the contract's PRE-reorg action_index, which is a local MAX()+1
 * counter (db.js createActionIndex) that a reorg may renumber. Leg 3 proves the
 * reassembled contract still runs with a FRESH EXECUTE against the new index instead.
 *
 * VENUE: BTC (or LTC) regtest stack stood up by initialCheck. Uses the same
 * stack globals as xcallSourceReorgDrill (nodeConnector / regtestMinerConnector /
 * indexerDatabase). DOGE regtest is skipped (fast-chain mining model). Needs
 * Node 22 (real isolated-vm via the indexer DB layer).
 *
 * Run (host with regtest stack + Node 22):
 *     COIN=bitcoin NETWORK=regtest npm run test:sdk:chunked-reorg
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const cryptoHelper = require('../../cryptoHelper');
const { makeSdk, submit, fundedGasAddress, mine, submitOpts, uniqueTick } = require('../sdkHelper');
const { snapshotWindow, replayWindowInOrder } = require('../helpers/rawHexBlocks');
const { chunkHelper } = require('xchain-sdk');

// A contract too large for a single DEPLOY: a ~7 KB string literal pads the source
// past the base64 single-action budget, forcing >=2 chunks. The string survives (it is
// code, not a comment); `padlen` proves byte-exact reassembly and `increment` proves
// the assembled contract runs. RUN makes the source (and so the code_hash) unique per
// run - see reorg contract (c). No xchain.* calls in module scope so readManifest is
// clean and the constructor initializes state.
const PAD = 'x'.repeat(7000);
const RUN = uniqueTick('CR');
const SRC = [
    'var PAD = "' + PAD + '";',
    'var RUN = "' + RUN + '";',
    'module.exports = {',
    "  meta: { name: 'Chunked Counter Reorg', description: 'Per-run padded counter whose chunked DEPLOY group is reorged.', version: '1.0.0' },",
    '  initialize: function (xchain) {',
    '    var start = xchain.getInputParam(0);',
    '    xchain.state.set("count", String(parseInt(start) || 0));',
    '    xchain.state.set("padlen", String(PAD.length));',
    '    xchain.state.set("run", RUN);',
    '  },',
    '  increment: function() {',
    '    xchain.state.set("count", String(parseInt(xchain.state.get("count")) + 1));',
    '  }',
    '};'
].join('\n');

const GAS_LIMIT = 400000;
const START     = 5;

// Hard ceiling on how deep this drill may orphan - see reorg contract (a). The
// utxo-tracker's UNDO_BLOCKS recovery window is 12 blocks and it halts fail-closed
// past it (the decoder's own ceiling is 126), so exceeding this does not just fail the
// drill, it wedges the venue for every other suite. The bounded deploy below normally
// spends 3-5 blocks; the guard fires before any invalidateblock, so a venue too busy
// for the drill fails it cleanly instead of taking the stack down.
const ORPHAN_DEPTH_LIMIT = 12;

function haveConnectors() {
    return global.nodeConnector && global.regtestMinerConnector && global.indexerDatabase;
}

// Indexer DB reads against the primary stack's global pool (initialCheck), exactly
// like xcallSourceReorgDrill's btcIdx helper.
async function idxQuery(sql, params) {
    const conn = await global.indexerDatabase.getConnection();
    try { return await conn.query(sql, params); } finally { await conn.release(); }
}
async function idxCount(sql, params) { return Number((await idxQuery(sql, params))[0].n); }

async function readState(sdk, contractIndex, key) {
    const state = await sdk.getContractState(contractIndex, key);
    const rows = (state && state.data) || [];
    const row = rows.find(r => r.state_key === key);
    return row ? JSON.parse(row.state_value) : undefined;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Poll until `fn()` is truthy. Nudges a block every 15s: with the auto-miner held, a
// tx that missed its block would otherwise never confirm. Throws (rather than
// returning false) so the caller's failure names the step, not a later assertion.
async function waitUntil(fn, what, timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs;
    let polls = 0;
    while (Date.now() < deadline) {
        const got = await fn();
        if (got) return got;
        if (++polls % 15 === 0) await mine(1);
        await sleep(1000);
    }
    throw new Error('timed out after ' + (timeoutMs / 1000) + 's waiting for ' + what);
}

module.exports = {
    expect, cryptoHelper, makeSdk, submit, fundedGasAddress, mine, submitOpts, snapshotWindow,
    replayWindowInOrder, chunkHelper, PAD, RUN, SRC, GAS_LIMIT, START, ORPHAN_DEPTH_LIMIT,
    haveConnectors, idxQuery, idxCount, readState, sleep, waitUntil,
};
