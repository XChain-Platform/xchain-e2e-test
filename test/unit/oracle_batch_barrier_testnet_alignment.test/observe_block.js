'use strict';

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
 **********************************************************************
 * Part of test/unit/oracle_batch_barrier_testnet_alignment.test.js
 ********************************************************************/

const assert = require('assert');
const { drill, REAL_PAIRS, WINDOW } = require('./fixtures.js');

// ---------------------------------------------------------------------------
// Wired into the drill, not merely exported
// ---------------------------------------------------------------------------

// Block 67881946 as run 5 really found it: three ATTESTs on three
// transactions, which the node numbered 249-251 and origin numbered
// 654-656. The node's own database answers the actions query; nothing
// opens a socket. The statuses are assigned here, since what is under test
// is which action each verdict is read for, not what the verdict was.
const OBSERVED_HEIGHT = 67881946;
const OBSERVED_PICKED = REAL_PAIRS.filter((p) => p.node.height === OBSERVED_HEIGHT);
const OBSERVED_NODE_STATUS   = { 249: 'valid', 250: 'valid', 251: 'valid' };
const OBSERVED_ORIGIN_STATUS = { 654: 'valid', 655: 'valid', 656: 'invalid' };

function observedConn() {
    return {
        async query(sql) {
            if (/\.actions a JOIN/.test(sql)) {
                return OBSERVED_PICKED.map((p) => ({
                    action_index: p.node.actionIndex, tx_index: p.node.txIndex,
                    tx_vout: p.node.txVout, action: p.node.action, tx_hash: p.node.txHash
                }));
            }
            if (/index_statuses s/.test(sql)) {
                return OBSERVED_PICKED.map((p) => ({
                    action_index: p.node.actionIndex, status: OBSERVED_NODE_STATUS[p.node.actionIndex]
                }));
            }
            return [];
        }
    };
}

function observedOrigin(asked) {
    return {
        async recentActions() { return { rows: WINDOW, error: null, limit: 200 }; },
        async newestRoundAtOrBefore() { return { round: 41, blockTimestamp: 1, rowsScanned: 1 }; },
        async action(i) {
            asked.push(i);
            const status = OBSERVED_ORIGIN_STATUS[i];
            if (status === undefined) {
                // The node's own index reaching this method is the defect
                // itself, so it is made unmistakable rather than silent.
                throw new Error('origin.action was asked for ' + i + ', which is not one of origin\'s indexes');
            }
            return { found: true, status: status, action: null, blockIndex: OBSERVED_HEIGHT, txIndex: null };
        }
    };
}

function observeTheBlock(asked) {
    return drill.observeBlock({
        node: { mirrorDbName: 'AT5_Mirror', hubDbName: 'AT5_Hub', indexerDbName: 'AT5_Indexer' },
        conn: observedConn(),
        origin: observedOrigin(asked),
        tables: ['prices'],
        height: OBSERVED_HEIGHT,
        // The block's own timestamp as origin reports it, seen 18 s later
        // and released one grace after: a live block, held at the barrier.
        blockTime: 1_788_984_029,
        firstSeenAt: 1_788_984_047,
        processedAt: 1_788_988_850,
        deferrals: [],
        originNow: { lag: 0, blockIndex: OBSERVED_HEIGHT },
        maxBlockAgeS: 120,
        originActionPage: 200
    });
}

function registerObserveBlockAsksOrigin() {

    const state = { observation: null, asked: [] };

    before(async function () {
        state.observation = await observeTheBlock(state.asked);
    });

    registerObserveBlockAlignmentChecks(state);
    registerObserveBlockVerdictChecks(state);
}

function registerObserveBlockAlignmentChecks(state) {

    it('fetched origin\'s verdicts by origin\'s indexes and never by the node\'s', function () {
        const asked = state.asked;
        assert.strictEqual(OBSERVED_PICKED.length, 3, 'block 67881946 carried three ATTESTs');
        assert.deepStrictEqual(asked.slice().sort((a, b) => a - b), [654, 655, 656]);
        for (const nodeIndex of [249, 250, 251]) {
            assert.ok(!asked.includes(nodeIndex),
                'the node\'s own action_index ' + nodeIndex + ' must never be sent to origin');
        }
    });

    it('aligned all three and recorded both coordinates', function () {
        const observation = state.observation;
        assert.strictEqual(observation.actions.length, 3);
        for (const r of observation.actions) {
            assert.strictEqual(r.coordinateAligned, true, r.action + ' at ' + r.actionIndex + ' must align');
            assert.strictEqual(r.alignment, 'aligned');
            assert.ok(r.txHash, 'the chain coordinate is in the record');
            assert.notStrictEqual(r.originActionIndex, r.actionIndex,
                'the two counters differ, and both are recorded');
        }
        assert.deepStrictEqual(observation.alignmentReasons, { aligned: 3 });
    });
}

function registerObserveBlockVerdictChecks(state) {

    it('scored two agreements and one divergence, with the rounds beside it', function () {
        const observation = state.observation;
        assert.strictEqual(observation.verdictAgreements, 2);
        assert.strictEqual(observation.verdictDisagreements.length, 1);
        const d = observation.verdictDisagreements[0];
        assert.strictEqual(d.actionIndex, 251);
        assert.strictEqual(d.originActionIndex, 656);
        assert.strictEqual(d.nodeStatus, 'valid');
        assert.strictEqual(d.originStatus, 'invalid');
        assert.strictEqual(d.originPricedAgainstRound, 41);
    });

    it('feeds comparedVerdicts, so the run\'s parity stop condition sees them', function () {
        const observation = state.observation;
        assert.strictEqual(observation.usable, true, 'the block arrived live, so it is graded');
        assert.strictEqual(drill.comparedVerdicts([observation]), 3);
        assert.strictEqual(drill.summarize({ observations: [observation] }).verdictsCompared, 3);
    });

    it('records the window each comparison was made against', function () {
        const observation = state.observation;
        assert.strictEqual(observation.originActions.rowsRead, WINDOW.length);
        assert.strictEqual(observation.originActions.coversThisBlock, true);
        assert.strictEqual(observation.originActions.error, null);
    });
}

function registerEmptyBlockStopsNothing() {

    it('grades the block, compares nothing, and does not call origin at all', async function () {
        const observation = await drill.observeBlock({
            node: { mirrorDbName: 'AT5_Mirror', hubDbName: 'AT5_Hub', indexerDbName: 'AT5_Indexer' },
            conn: { async query() { return []; } },
            origin: {
                async recentActions() { throw new Error('a block with no action must not read origin\'s window'); },
                async newestRoundAtOrBefore() { return { round: null, blockTimestamp: null, rowsScanned: 0 }; },
                async action() { throw new Error('origin.action must not be reached'); }
            },
            tables: [],
            height: 67882090,
            blockTime: 1_788_987_800,
            firstSeenAt: 1_788_987_810,
            processedAt: 1_788_992_700,
            deferrals: [],
            originNow: { lag: 0, blockIndex: 67882090 },
            maxBlockAgeS: 120,
            originActionPage: 200
        });
        assert.strictEqual(observation.actions.length, 0);
        assert.strictEqual(drill.comparedVerdicts([observation]), 0,
            'which is what the insufficient-parity-traffic exit is for');
        assert.deepStrictEqual(observation.alignmentReasons, {});
    });
}

module.exports = { registerObserveBlockAsksOrigin, registerEmptyBlockStopsNothing };
