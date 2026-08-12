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
 * P3(b): LIVE multi-chain parity: per-chain driver + digest capture.
 *
 * Runs against ONE live regtest stack (the coin currently installed), drives
 * the chain-agnostic corpus through the FULL pipeline deterministically, and
 * writes a digest artifact to PARITY_OUT_DIR/digest-<COIN>.json. The
 * orchestration runbook (run-multichain-parity.sh) invokes this once per coin
 * (BTC/LTC/DOGE), then compare.js asserts parity across the three artifacts.
 *
 * Determinism (see parityCorpus.js header for the full contract):
 *   1. Fund + gas-seed roles with AUTO-MINE ON (native funding is invisible to
 *      the indexer ledger; gas MINT is driven later, inside the pinned phase).
 *   2. Disable auto-mine, mine every chain to the SAME baseline height.
 *   3. Drive gas MINTs + corpus ONE ACTION PER BLOCK with explicit mining, so
 *      each action lands at an identical absolute block_index on every chain.
 *
 * Run (per chain, after `npm run test:sdk` env is set up):
 *   PARITY_OUT_DIR=/tmp/parity \
 *   ./node_modules/.bin/mocha --timeout 0 \
 *     --require ./test/initialCheck.test.js test/parity/multichain-parity.test.js
 *********************************************************************/

'use strict';

const path = require('path');
const { expect } = require('chai');
const { makeSdk, GAS_TICK, submitOpts } = require('../sdk/sdkHelper');
const { buildRoles, corpus, resolveParams, PIN_T0 } = require('./parityCorpus');
const { captureLiveDigest, writeDigest } = require('./digest');

// Baseline height every chain is mined to before the pinned corpus. Must be
// ABOVE any fresh regtest install's post-funding height AND identical across
// chains. Raise it (and re-run all three) if the assertion below ever trips.
const BASELINE_HEIGHT = parseInt(process.env.PARITY_BASELINE || '1000', 10);
const OUT_DIR = process.env.PARITY_OUT_DIR || path.join('/tmp', 'parity');

// This driver needs the explicit generateBlocks(1) to be the ONLY block source,
// so before() takes the miner's real pause barrier (see the call site below).
// It used to buy that with a mining-timer of 3600000ms instead, which was never
// a barrier and had already misfired once: the miner CAPS timers at
// MAX_MINING_TIME (3600000ms / 1h), so a larger value (the old 10**9) was
// REJECTED outright and left the auto-miner ACTIVE at its default 30s/5s mempool
// debounce, racing the explicit per-action mine and scattering actions across
// empty/double blocks (BTC got away with it because its node always beat the
// debounce; the slower DOGE stack did not).

describe('P3(b) multi-chain parity: live driver + digest capture', function () {
    this.timeout(0);

    let sdk, roles, coin, pool;
    const heights = {}; // step label -> block_index (for the report)

    function pid() { return global.indexerDatabase.pool; }

    // The chain tip, read from the indexer DB. The indexer creates a blocks row
    // for EVERY height (incl. empty), so once it has caught up (mempool drained,
    // tracker ready) MAX(block_index) == the node tip. This keeps the driver
    // dependent ONLY on published services (indexer DB + tracker + miner +
    // encoder via the SDK), with no direct node RPC (which some installs don't
    // host-publish for the coin node).
    async function indexerHeight() {
        const rows = await pid().query('SELECT MAX(block_index) AS h FROM blocks');
        return rows[0] && rows[0].h != null ? Number(rows[0].h) : null;
    }

    // Wait until the indexer has created a blocks row at >= target height.
    async function waitIndexerHeight(target, timeoutMs = 120000) {
        const end = Date.now() + timeoutMs;
        while (Date.now() < end) {
            const h = await indexerHeight();
            if (h != null && h >= target) return h;
            await new Promise(r => setTimeout(r, 500));
        }
        throw new Error('indexer never reached height ' + target + ' (stuck at ' + (await indexerHeight()) + ')');
    }

    // Settle: wait until the utxo-tracker reports quiescent (mempool drained AND
    // tracker synced to the node tip). The tracker's is_quiescent endpoint knows
    // the node height internally, so we need no direct node access. No miner is
    // passed: auto-mine is off and we mine explicitly per action.
    async function settle(timeoutMs = 30000) {
        const status = await global.utxoTrackerConnector.quiesce({ timeoutMs, pollMs: 250 });
        return status;
    }

    // The TRUE node tip, from the tracker's is_quiescent payload (node_height).
    // Mining and per-action targeting must key off the node tip, NOT the
    // indexer height. The indexer LAGS the node during fast bulk mining, so
    // computing block counts from indexerHeight over-mines (non-deterministic
    // baseline). settle() first so the reported tip is post-mempool-drain.
    async function tip() {
        const s = await settle();
        if (s && s.node_height != null) return Number(s.node_height);
        return (await indexerHeight()) || 0;
    }

    // Drive one corpus action: settle -> broadcast (no indexer wait) -> mine ONE
    // block -> wait for the indexer to record that height -> ASSERT the action
    // actually confirmed there. Returns the action's confirming block_index.
    //
    // Encoding is forced to MULTISIGN (single-phase, data in bare multisig
    // outputs): auto-selection picks P2SH for >80-byte strings (ORDER/DISPENSER),
    // and P2SH is TWO transactions where phase 2 (the data reveal) spends
    // phase 1's unconfirmed output. Bitcoin regtest mines both in one block, but
    // Dogecoin v1.14 defers the chained phase 2 to the NEXT block, so the data
    // tx lands one height late on DOGE only, silently breaking the
    // one-action-per-block cross-chain height contract. MULTISIGN is one tx on
    // every chain; the encoding choice itself never reaches the indexer state.
    async function driveAction(step) {
        const role = roles[step.role];
        const params = resolveParams(step.params, roles);
        // Key off the TRUE node tip (tip() settles first), so the action lands
        // at a deterministic absolute height identical across chains.
        const before = await tip();
        // Pin the block timestamp when the step carries one (the corpus phase).
        // Set the node's mock clock (through the miner: the driver is node-RPC-
        // free) to the step's FIXED time so the block this step mines is stamped
        // at exactly that value on every chain. The step times increase by
        // PIN_STEP, always above the tip's median-time-past, so bitcoind stamps
        // the block at the requested time verbatim. This is what makes the
        // time-based ORDER_EXPIRE fire at an identical absolute block_index
        // cross-chain; block_time itself is excluded from the Tier-2 diff.
        if (step.time != null) await global.regtestMinerConnector.setMockTime(step.time);
        await sdk.submitAction(
            { action: step.action, params, version: step.version },
            { pubkey: role.address, change: role.address, unconfirmed: false,
              encoding: 'MULTISIGN', compressedPubKey: role.publicKeyHex,
              // MULTISIGN txs are larger than the encoder's fee default covers:
              // BTC regtest's 1000 sat/kB minrelaytxfee rejected them ("min relay
              // fee not met, 546 < 820"). DOGE/LTC regtest floors are relaxed in
              // their conf. The native miner fee never reaches indexer state or
              // the consensus hash, so a generous pinned rate is parity-safe.
              feePerKb: 10000 },
            submitOpts({ wif: role.wif, waitForIndexer: false })
        );
        await global.regtestMinerConnector.generateBlocks(1);
        const target = before + 1;
        await waitIndexerHeight(target);
        // Height alone is NOT confirmation: the indexer writes a blocks row for
        // EMPTY blocks too, so a rejected/unmined action still "reaches" the
        // height. Require this step's tx to exist at exactly its pinned height.
        // This is what turns a silently-dropped action into a loud failure.
        const txs = await pid().query(
            'SELECT data FROM transactions WHERE block_index = ?', [target]);
        const found = txs.filter(t => String(t.data).startsWith(step.action + '|'));
        if (found.length !== 1) {
            throw new Error('action "' + step.label + '" did not confirm at pinned height ' +
                target + ' (found ' + found.length + ' matching tx, ' + txs.length +
                ' total at that height)');
        }
        heights[step.label] = target;
        return target;
    }

    before(async function () {
        coin = (global.COIN || process.env.COIN || 'BTC').toUpperCase().replace(/^[TR]/, '');
        // Normalise the coin symbol the SDK/explorer expect (BTC/LTC/DOGE).
        if (/BITCOIN|^[TR]?BTC/.test(coin)) coin = 'BTC';
        else if (/LITE|LTC/.test(coin)) coin = 'LTC';
        else if (/DOGE/.test(coin)) coin = 'DOGE';
        sdk = makeSdk();
        roles = buildRoles(sdk);
        pool = pid();

        // 1. Fund the fixed role addresses with native coin (auto-mine ON).
        // Native funding is invisible to the indexer ledger, so it may mine
        // freely; the protocol gas MINTs are driven later, inside the pinned
        // phase. The fixed role keys are reused on every chain (see parityCorpus).
        await global.regtestMinerConnector.setDefaultMiningTime();
        // Pre-mine so the miner's coinbase matures. A fresh post-reset chain
        // has no spendable coins until ~100 blocks confirm. These are empty
        // XChain blocks (chain-agnostic hash) below the pinned baseline.
        await global.regtestMinerConnector.generateBlocks(110);
        for (const name of ['A', 'B', 'C']) {
            const r = roles[name];
            // sendFunds broadcasts; auto-mine (default mining time) confirms it.
            // We wait on the tracker (published) rather than the node (may be
            // unpublished) to see the funding UTXO land.
            await global.regtestMinerConnector.sendFunds(r.address, 10);
            let ok = false;
            for (let i = 0; i < 8 && !ok; i++) {
                try { ok = await global.utxoTrackerConnector.waitForUtxos(r.address, 20000); }
                catch (e) { ok = false; }
                if (!ok) { try { await global.regtestMinerConnector.generateBlocks(1); } catch (e) {} }
            }
            if (!ok) throw new Error('role ' + name + ' never funded');
        }

        // 2. Disable auto-mine, then mine every chain to the SAME baseline
        // height. Mine the EXACT deficit off the true node tip (tip()), so the
        // baseline is deterministic with no indexer-lag overshoot.
        // pauseMining, not a NO_AUTO_MINE cadence. setMiningTime only assigns the
        // two duration fields on the miner: keepMining stays true and an already
        // in-flight generation is not awaited, so a block started just before this
        // call can still land and put the baseline off by one. pauseMining clears
        // keepMining AND awaits the mine queue, which is the barrier that makes
        // the explicit generateBlocks below the only block source. after()
        // resumes.
        await global.regtestMinerConnector.pauseMining();
        let nh = await tip();
        expect(nh, 'install mined past PARITY_BASELINE=' + BASELINE_HEIGHT + ': raise it and re-run all chains')
            .to.be.at.most(BASELINE_HEIGHT);
        if (nh < BASELINE_HEIGHT) await global.regtestMinerConnector.generateBlocks(BASELINE_HEIGHT - nh);
        await waitIndexerHeight(BASELINE_HEIGHT);
        nh = await tip();
        expect(nh, 'baseline overshoot: node tip past baseline').to.equal(BASELINE_HEIGHT);

        // Staleness guard for the pinned-time schedule: the corpus mines its
        // blocks at PIN_T0 + i*PIN_STEP, a forward jump off the real-time
        // baseline. If wall-clock has caught up to PIN_T0 the jump would no longer
        // be forward (bitcoind would reject the non-increasing timestamp), so fail
        // loudly here with the fix (bump PIN_T0/FAR_FUTURE in parityCorpus.js)
        // rather than deadlock later inside driveAction.
        const baseRow = await pool.query('SELECT block_time AS t FROM blocks WHERE block_index = ?', [BASELINE_HEIGHT]);
        const baseTime = baseRow[0] && baseRow[0].t != null ? Number(baseRow[0].t) : 0;
        expect(PIN_T0, 'pinned-time base PIN_T0 has fallen at/below real wall-clock (' + baseTime +
            '): bump PIN_T0 and FAR_FUTURE in parityCorpus.js and re-run all chains')
            .to.be.greaterThan(baseTime);

        // 3a. Genesis: role A ISSUEs the XCHAIN gas token. This is the
        // fee-EXEMPT gas bootstrap (issue.js gasBootstrap), and regtest lets
        // any address issue GAS, so it is deterministic and chain-agnostic.
        // Driven as a PINNED action (not initialCheck's timing-dependent
        // auto-genesis) so it is part of the parity set, not a hash-chain fork.
        await driveAction({ role: 'A', label: 'ISSUE XCHAIN (gas genesis)', action: 'ISSUE',
            params: { tick: GAS_TICK, maxSupply: 100000000, maxMint: 100000, decimals: 0,
                      description: 'XChain GAS Token', mintSupply: 0 } });
        // 3b. Gas MINT to each role, one per block (XCHAIN now exists).
        for (const name of ['A', 'B', 'C']) {
            await driveAction({ role: name, label: 'GAS MINT ' + name, action: 'MINT',
                params: { tick: GAS_TICK, amount: 100000, destination: '@' + name } });
        }
        // 3c. The corpus, one action per block.
        for (const step of corpus(coin)) await driveAction(step);
    });

    after(async function () {
        // Release the node's mock clock and restore the normal mine cadence so
        // the shared regtest node is not left time-frozen. Best-effort: a failed
        // run must not mask its own error with a teardown throw. Guarded because
        // a before()-hook failure can leave the miner connector unset.
        try { if (global.regtestMinerConnector) await global.regtestMinerConnector.setMockTime(0); } catch (e) { /* best effort */ }
        try { if (global.regtestMinerConnector) await global.regtestMinerConnector.setDefaultMiningTime(); } catch (e) { /* best effort */ }
        // Un-park counterpart of the pauseMining in before(). setDefaultMiningTime
        // above only restores the cadence; only continue_mining restores
        // keepMining, and without it this run hands the shared regtest node to
        // every later suite still paused.
        try { if (global.regtestMinerConnector) await global.regtestMinerConnector.resumeMining(); } catch (e) { /* best effort */ }
    });

    it('emitted a deterministic ORDER_EXPIRE from the pinned time-based expiry', async function () {
        // The unmatchable order (corpus step 8) must have expired at the MINT
        // block (step 10) whose pinned block_time crossed ORDER_EXPIRE_AT. Assert
        // the ORDER_EXPIRE action exists so the time-based coverage is not vacuous
        // (mirrors scenario 14's guard). Its identical block_index cross-chain is
        // what compare.js's Tier-1 hash chain proves.
        const rows = await pid().query(
            "SELECT COUNT(*) AS n FROM actions a " +
            "JOIN index_actions ia ON ia.id = a.action_id " +
            "WHERE ia.action = 'ORDER_EXPIRE'");
        expect(Number(rows[0].n), 'the pinned unmatchable order never produced exactly one ORDER_EXPIRE').to.equal(1);
    });

    it('drove the corpus deterministically and the indexer is consistent', async function () {
        // After the final action + settle, the tracker is quiescent (synced to
        // the node tip) and the indexer is at the expected pinned height.
        await settle();
        const ih = await indexerHeight();
        const actionCount = 1 /* XCHAIN genesis */ + 3 /* gas MINTs */ + corpus(coin).length;
        const expected = BASELINE_HEIGHT + actionCount;
        expect(ih, 'indexer tip is not at the pinned corpus end height').to.equal(expected);
        // Every driven action must exist as a confirmed tx. A height match with
        // missing txs means actions were silently dropped (driveAction asserts
        // per-action too; this is the belt-and-braces total).
        const n = await pid().query('SELECT COUNT(*) AS n FROM transactions');
        expect(Number(n[0].n), 'confirmed action tx count').to.equal(actionCount);
    });

    it('writes the per-chain digest artifact', async function () {
        const baselineFirst = await pool.query('SELECT MIN(block_index) AS m FROM blocks');
        const digest = await captureLiveDigest(pool, {
            coin,
            network: global.NETWORK || process.env.NETWORK || 'regtest',
            baselineHeight: BASELINE_HEIGHT,
            firstDecoderBlock: baselineFirst[0] && Number(baselineFirst[0].m),
            corpusHeights: heights,
        });
        const out = path.join(OUT_DIR, 'digest-' + coin + '.json');
        writeDigest(digest, out);
        console.log('    [parity] wrote digest for ' + coin + ' -> ' + out +
            ' (' + Object.keys(digest.tables).length + ' tables, ' +
            digest.hashChain.length + ' blocks in hash chain)');
        expect(digest.hashChain.length).to.be.greaterThan(0);
    });
});
