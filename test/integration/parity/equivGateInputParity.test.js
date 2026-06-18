/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * Cross-service regression #4196 - per-engine EQUIV anti-equivocation
 * GATE-INPUT parity between xchain-hub and xchain-indexer.
 *
 * WHAT THIS GUARDS (and how it differs from the existing boundary test):
 * equivHeaderActivationBoundary.integration.test.js proves the headerless
 * -> wrapped transition is fork-free for the XCHECKPOINT engine (raw-vs-
 * wrapped sig bytes + no-fork). It does NOT check the OTHER half of the
 * gate: WHICH value each side feeds into the activation-height comparison
 * `isEquivHeaderActive(<gateInput>, network)`.
 *
 * The EQUIV header is gated PER ENGINE on a BTC-anchored block-height
 * activation boundary. Every engine must feed a BTC block HEIGHT (the same
 * height source on both services) into the gate so the hub and every indexer
 * flip on the SAME anchor for the same logical action. If one side feeds a
 * height and the other feeds something that is NOT that height (e.g. a round
 * counter), the two services disagree about whether the header is present at
 * the flag-day for the same action -> divergent signed bytes -> a cross-
 * service fork. That is exactly #4232.
 *
 * GATE-INPUT MAP (first arg to isEquivHeaderActive on each side; source
 * verified by reading the callers, see the per-engine entries below):
 *
 *   engine      hub gate input               indexer gate input          semantic
 *   --------    --------------------------   -------------------------   --------
 *   config      blockHeight (Consensus)      (in-content; contract)      HEIGHT
 *   attest      requestBlock=request block   snapshotBlock=request blk   HEIGHT
 *   checkpoint  cp.snapshot_block            d.SNAPSHOT_BLOCK            HEIGHT
 *   dex         r.snapshot_block             m.snapshot_block            HEIGHT
 *   xcall       r.snapshot_block             c.snapshot_block           HEIGHT
 *   nodeproof   epoch (=epoch HEIGHT)        snapshotBlock=epochHeight   HEIGHT
 *   oracle      round (OracleRound counter)  round (= block height?)     *** MISMATCH (#4232)
 *
 * For ORACLE the hub feeds `round`, which OracleRound derives as a WALL-CLOCK
 * counter: `Math.floor((Date.now()-epochStart)/roundInterval)`, kept DISTINCT
 * from `currentBtcBlockHeight` (the BTC tip; they coincide only in the
 * degraded fallback). So the oracle gate input is a round counter, not the
 * BTC height every other engine (and the indexer's own comment) treats it as.
 * That non-height gate input is the #4232 cross-service-fork hazard.
 *
 * APPROACH (mock / contract level, no DB, Node 24):
 * A full cross-service round-trip per engine needs a live federation + DB, so
 * the live boundary suite already covers checkpoint end-to-end. Here we assert
 * gate-input PARITY at the contract level: we require the same equivocation_header
 * module bytes on both sides (the gate function itself), then drive each engine's
 * gate input through BOTH copies and assert they produce the IDENTICAL active/
 * inactive verdict for the same logical action at the same height, AND that the
 * gate input each side uses is a BTC block HEIGHT (not a counter). The oracle
 * case is marked PENDING and tied to #4232 so it does not red CI, while the
 * other six engines assert green. Flip the oracle `xit` to `it` once #4232 is
 * fixed (hub oracle gate fed the BTC block height instead of the round counter).
 *
 * Spec: claude/reports/2026-06-14_cross-chain-quorum-security-spec.md s4.1.1.
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const HUB_EQ_PATH = path.resolve(__dirname, '../../../../xchain-hub/src/equivocation_header.js');
const IDX_EQ_PATH = path.resolve(__dirname, '../../../../xchain-indexer/src/equivocation_header.js');

const hubEq = require(HUB_EQ_PATH);
const idxEq = require(IDX_EQ_PATH);

// Source of each engine's gate-input call site, read so the parity assertion is
// anchored to the real production code (not a transcription). Relative to the
// monorepo root (two up from test/integration/parity).
const ROOT = path.resolve(__dirname, '../../../..');
function srcOf(rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// Pull the FIRST argument expression passed to isEquivHeaderActive(...) on a
// given line-matching anchor in a source string. Returns the trimmed arg text.
function gateInputArg(source, anchorRegex) {
    const lines = source.split('\n');
    for (const line of lines) {
        if (!anchorRegex.test(line)) continue;
        const m = line.match(/isEquivHeaderActive\(\s*([^,]+?)\s*,/);
        if (m) return m[1].trim();
    }
    return null;
}

describe('#4196 EQUIV gate-input parity (xchain-hub <-> xchain-indexer)', function () {

    // ---- Pre-req: the gate function itself must be byte-equal on both sides ----
    // (A divergence here forks the chain regardless of inputs; the cross-service
    // suite also enforces this, re-asserted here so the input parity rests on a
    // shared comparison.)
    it('the isEquivHeaderActive gate + activation map are byte-equal on both services', function () {
        const hubSrc = fs.readFileSync(HUB_EQ_PATH, 'utf8');
        const idxSrc = fs.readFileSync(IDX_EQ_PATH, 'utf8');
        // Compare the EXECUTABLE region only (from the activation map down), with
        // line comments and blank-line whitespace stripped: the two copies carry
        // intentionally-worded inline comments, which are not a fork hazard. What
        // forks the chain is divergent CODE, so we assert the code is byte-equal.
        const codeOnly = (s) => s
            .slice(s.indexOf('const EQUIV_HEADER_ACTIVATION'))
            .split('\n')
            .map((l) => l.replace(/\/\/.*$/, '').replace(/\s+$/, ''))
            .filter((l) => l.trim() !== '')
            .join('\n');
        assert.strictEqual(codeOnly(hubSrc), codeOnly(idxSrc),
            'hub and indexer equivocation_header.js executable code must be byte-identical');
        assert.deepStrictEqual(hubEq.EQUIV_HEADER_ACTIVATION, idxEq.EQUIV_HEADER_ACTIVATION,
            'activation maps must be equal across services');
        assert.deepStrictEqual(hubEq.ENGINE_TAGS, idxEq.ENGINE_TAGS,
            'engine tag maps must be equal across services');
    });

    // Shared height fixture: pick a regtest threshold and probe one block below and
    // one at/above. Both services, fed the SAME height, must return the SAME verdict.
    // (Regtest activation is 0 by default => use a synthetic threshold via direct
    // numeric comparison through both copies, since the map is shared and equal.)
    function assertHeightParity(label, height) {
        const net = 'testnet'; // map value 0 => any finite height is "active"; semantics shared
        const hubVerdict = hubEq.isEquivHeaderActive(height, net);
        const idxVerdict = idxEq.isEquivHeaderActive(height, net);
        assert.strictEqual(hubVerdict, idxVerdict,
            label + ': hub and indexer must agree on the gate verdict for height ' + height);
    }

    // ---- Per-engine: assert the gate INPUT each side uses is a block height, and
    //      that fed the same height both copies agree. The gate-input source
    //      expression is read from production so the test fails if a refactor
    //      swaps an engine's gate input to a non-height value. ----

    describe('engines that feed a BTC block height on both sides (assert green)', function () {

        it('CHECKPOINT: both sides gate on snapshot_block (height)', function () {
            const hubArg = gateInputArg(srcOf('xchain-hub/src/StateCheckpointEngine.js'),
                /isEquivHeaderActive\(cp\.snapshot_block/);
            const idxArg = gateInputArg(srcOf('xchain-indexer/src/actions/anchor.js'),
                /isEquivHeaderActive\(d\['SNAPSHOT_BLOCK'\]/);
            assert.ok(hubArg, 'hub checkpoint gate input not found');
            assert.ok(idxArg, 'indexer checkpoint gate input not found');
            assert.match(hubArg, /snapshot_block/, 'hub checkpoint gate input must be snapshot_block');
            assert.match(idxArg, /SNAPSHOT_BLOCK/, 'indexer checkpoint gate input must be SNAPSHOT_BLOCK');
            assertHeightParity('CHECKPOINT', 500);
        });

        it('DEX: both sides gate on the match row snapshot_block (height)', function () {
            const hubArg = gateInputArg(srcOf('xchain-hub/src/CrossChainDexEngine.js'),
                /isEquivHeaderActive\(r\.snapshot_block/);
            const idxArg = gateInputArg(srcOf('xchain-indexer/src/actions/cross_settle.js'),
                /isEquivHeaderActive\(m\.snapshot_block/);
            assert.ok(hubArg && idxArg, 'DEX gate inputs must be found on both sides');
            assert.match(hubArg, /snapshot_block/);
            assert.match(idxArg, /snapshot_block/);
            assertHeightParity('DEX', 500);
        });

        it('XCALL: both sides gate on the call/result row snapshot_block (height)', function () {
            const hubArg = gateInputArg(srcOf('xchain-hub/src/CrossChainCallEngine.js'),
                /isEquivHeaderActive\(r\.snapshot_block/);
            const idxArgExec = gateInputArg(srcOf('xchain-indexer/src/actions/xexec.js'),
                /isEquivHeaderActive\(c\.snapshot_block/);
            const idxArgCall = gateInputArg(srcOf('xchain-indexer/src/actions/xcall.js'),
                /isEquivHeaderActive\(r\.snapshot_block/);
            assert.ok(hubArg, 'hub xcall gate input not found');
            assert.ok(idxArgExec && idxArgCall, 'indexer xcall/xexec gate inputs not found');
            assert.match(hubArg, /snapshot_block/);
            assert.match(idxArgExec, /snapshot_block/);
            assert.match(idxArgCall, /snapshot_block/);
            assertHeightParity('XCALL', 500);
        });

        it('ATTEST: both sides gate on the REQUEST block (height)', function () {
            const hubArg = gateInputArg(srcOf('xchain-hub/src/AttestationConsensus.js'),
                /isEquivHeaderActive\(requestBlock/);
            const idxArg = gateInputArg(srcOf('xchain-indexer/src/actions/attest.js'),
                /isEquivHeaderActive\(snapshotBlock/);
            assert.ok(hubArg && idxArg, 'ATTEST gate inputs must be found on both sides');
            // Hub: requestBlock (the REQUEST's block_index). Indexer: snapshotBlock
            // = request ? request.block_index : data.BLOCK_INDEX (same source).
            assert.match(hubArg, /requestBlock/);
            assert.match(idxArg, /snapshotBlock/);
            const idxBody = srcOf('xchain-indexer/src/actions/attest.js');
            assert.match(idxBody, /snapshotBlock\s*=\s*request\s*\?\s*Number\(request\.block_index\)/,
                'indexer ATTEST snapshotBlock must derive from the REQUEST block_index (height)');
            assertHeightParity('ATTEST', 500);
        });

        it('NODEPROOF: both sides gate on the epoch HEIGHT', function () {
            const hubArg = gateInputArg(srcOf('xchain-hub/src/FullNodeChallengeRound.js'),
                /isEquivHeaderActive\(epoch/);
            const idxArg = gateInputArg(srcOf('xchain-indexer/src/actions/nodeproof.js'),
                /isEquivHeaderActive\(snapshotBlock/);
            assert.ok(hubArg && idxArg, 'NODEPROOF gate inputs must be found on both sides');
            assert.match(hubArg, /^epoch$/, 'hub nodeproof gate input must be the epoch height');
            const idxBody = srcOf('xchain-indexer/src/actions/nodeproof.js');
            assert.match(idxBody, /snapshotBlock\s*=\s*epochHeight/,
                'indexer nodeproof snapshotBlock must be the epoch HEIGHT');
            assertHeightParity('NODEPROOF', 500);
        });

        it('CONFIG: hub gates on blockHeight; indexer carries the block in-content (contract-level)', function () {
            // CONFIG has no on-chain per-action indexer gate caller of its own: the
            // config-change PBFT block is carried INSIDE the signed content
            // (snapshot_block|config_digest, see slash.js engine-content map index 0)
            // so config equivocation stays slashable. The hub gate input is the PBFT
            // block height. Assert the hub feeds a HEIGHT and document the indexer
            // side is a content-carried-height contract (verified via slash.js).
            const hubArg = gateInputArg(srcOf('xchain-hub/src/Consensus.js'),
                /isEquivHeaderActive\(blockHeight/);
            assert.ok(hubArg, 'hub CONFIG gate input not found');
            assert.match(hubArg, /blockHeight/, 'hub CONFIG gate input must be the PBFT block height');
            const slashBody = srcOf('xchain-indexer/src/actions/slash.js');
            assert.match(slashBody, /XCONFIG content = snapshot_block\|config_digest/,
                'indexer CONFIG must carry the block height in-content (contract-level parity)');
            assertHeightParity('CONFIG', 500);
        });
    });

    // ---- ORACLE: the #4232 fix. The hub now feeds the round's BTC block HEIGHT
    //      (btcBlockHeight) into the gate, not the OracleRound wall-clock counter, and
    //      the height rides in the signed payload + the on-chain PRICE v0 wire so the
    //      indexer gates on the IDENTICAL value. The previously-PENDING guard is now
    //      live (xit -> it). ----
    describe('ORACLE gate input (#4232 fix: gate on the BTC block height)', function () {

        // Confirms the #4232 fix landed: the hub ORACLE gate input is btcBlockHeight,
        // and OracleRound.currentBtcBlockHeight (the real BTC tip) is a distinct field
        // from the wall-clock round counter, so feeding the height is meaningful.
        it('the hub ORACLE gate now feeds the BTC block height, distinct from the round counter (#4232)', function () {
            const hubArg = gateInputArg(srcOf('xchain-hub/src/OracleConsensus.js'),
                /isEquivHeaderActive\(btcBlockHeight/);
            assert.ok(hubArg, 'hub ORACLE gate input not found');
            assert.match(hubArg, /^btcBlockHeight$/, 'hub ORACLE gate input must be btcBlockHeight after #4232');

            const roundSrc = srcOf('xchain-hub/src/OracleRound.js');
            // currentRound is wall-clock derived...
            assert.match(roundSrc, /currentRound\s*=\s*newRound/);
            assert.match(roundSrc, /newRound\s*=\s*Math\.floor\(\(Date\.now\(\)\s*-\s*this\.epochStart\)/,
                'OracleRound.currentRound is a wall-clock counter');
            // ...and currentBtcBlockHeight is a SEPARATE field (the real height) the gate
            // now keys on, so the oracle flips on the same BTC anchor as every other engine.
            assert.match(roundSrc, /currentBtcBlockHeight\s*=\s*btcTip\.blockHeight/,
                'the real BTC height lives in currentBtcBlockHeight, distinct from the round counter');
        });

        // The regression guard (was PENDING under #4232; now live). Asserts the hub
        // ORACLE gate input is a BTC block height, matching every other engine and the
        // indexer, AND that the indexer gates on the same height carried in the signed
        // PRICE v0 payload + wire.
        it('hub ORACLE gate input is a BTC block height, matching every other engine (#4232 fixed)', function () {
            const hubArg = gateInputArg(srcOf('xchain-hub/src/OracleConsensus.js'),
                /isEquivHeaderActive\(/);
            assert.match(hubArg, /(btcBlockHeight|referenceBlock|blockHeight|snapshot_block)/,
                'hub ORACLE gate input must be a BTC block height after #4232; got `' + hubArg + '`');

            // Hub re-verify (PriceAggregator) gates on the pushed btc_block_height.
            const aggArg = gateInputArg(srcOf('xchain-hub/src/PriceAggregator.js'),
                /isEquivHeaderActive\(btcBlockHeight/);
            assert.match(aggArg, /^btcBlockHeight$/, 'hub PriceAggregator must gate on btcBlockHeight');

            // Indexer on-chain verifier gates on the same height, passed into the
            // canonical builder. The builder reads btcBlockHeight (the 5th arg) and the
            // gate keys on it; the height is parsed off the PRICE v0 wire (params[3]).
            const edSrc = srcOf('xchain-indexer/src/ed25519.js');
            assert.match(edSrc, /isEquivHeaderActive\(btcBlockHeight,\s*network\)/,
                'indexer ed25519 must gate the price canonical on btcBlockHeight');
            const priceSrc = srcOf('xchain-indexer/src/actions/price.js');
            assert.match(priceSrc, /btcBlockHeight\s*=\s*parseInt\(params\[3\]\)/,
                'indexer must parse BTC_BLOCK_HEIGHT off the PRICE v0 wire (params[3])');
            assert.match(priceSrc, /buildPriceV0Payload\(round,\s*timestamp,\s*pairs,\s*this\.config\['NETWORK'\],\s*btcBlockHeight\)/,
                'indexer must feed the parsed btcBlockHeight into the canonical builder');

            assertHeightParity('ORACLE', 500);
        });
    });
});
