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
 * THE FEDERATION-FREE HALF OF THE ACCEPTANCE DRIVE, on real DOGE regtest.
 *
 * WHAT IS IN HERE AND WHY IT IS A SEPARATE FILE. Three of the acceptance claims are
 * decisions ONE indexer makes about ONE broadcast action, with no transfer, no PBFT
 * round and no mirror anywhere in them:
 *
 *   - AT6 and AT7's supply-path closure: a broadcast `ISSUE XCHAIN` on a non-BTC chain
 *     is refused `invalid: TICK (BTC-only)`, unconditionally, from every source and on
 *     every network including regtest (base spec D62, D63).
 *   - the controller-guarded `ORDER`, `SEND` and `DISPENSER` a source holding no XCHAIN
 *     broadcasts on DOGE carry a recognised verdict at all, which is the instrument AT9
 *     is built out of.
 *
 * None of those needs a quorum, so none of them should inherit the venue mesh's
 * blocker (bridgeRailBase.rail.test.js documents it). They still cannot be driven
 * against the STANDING DOGE indexer, which runs `1bbc68ae` and predates every one of
 * these rules, so they run against a venue DOGE indexer spawned from this tree.
 *
 * THIS SUITE NO LONGER SUPPLIES AT9'S BEFORE-HALF, and the reason is a measured one.
 * This venue's DOGE indexer is seeded by CLONING the standing node, so its ledger already
 * carries the pre-D62 XCHAIN row (supply 613400): the verdicts it records are the ones a
 * chain WITH XCHAIN carries. The base suite's venue REPLAYS instead and holds no such row,
 * so comparing one suite's reading against the other measures the difference between two
 * ledgers rather than the arrival of the bridge. Drive 7 did exactly that and failed AT9
 * with `insufficient funds` against `TICK (unknown)`. Both halves of AT9 are now taken on
 * the base suite's own ledger, through the SAME `driveVerdictWitness` exported here, which
 * is what keeps one definition of what is being witnessed.
 *
 * ── HOW TO RUN IT, on the regtest rail host, from this repository root ──────────────
 *
 *   nohup ~/scratch/xc-meta/doge-loop.sh >/dev/null 2>&1 & echo $! > ~/scratch/xc-meta/doge-loop.pid
 *   COIN=bitcoin NETWORK=regtest NODE_PATH=<the chunked module directory> \
 *     npx mocha --timeout 0 --exit --require ./test/initialCheck.test.js \
 *     test/integration/bridgeRailDogeGuards.rail.test.js
 *   kill $(cat ~/scratch/xc-meta/doge-loop.pid)
 *
 * Spec: the base bridge spec, section 15 (AT6, AT7, AT9); D62, D63.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');

const chainRail         = require('../helpers/chainRail');
const cryptoHelper      = require('../cryptoHelper');
const transactionHelper = require('../transactionHelper');
const issueHelper       = require('../helpers/issueHelper');
const {
    startDogeVenue,
    verdictOf,
    driveVerdictWitness,
    WITNESS_VERDICTS,
    fundUnderBudget,
    nodeDiagnosis,
    journalCase,
} = require('../helpers/bridgeRailVenue');

const GAS_TICK = 'XCHAIN';

// The verdict the closure must write, quoted from xchain-indexer/src/actions/issue.js.
// A literal rather than an import: the point of an acceptance assertion is that the
// STRING the chain persisted is this one, and importing the constant the handler also
// defines would let a rename pass both sides at once.
const BTC_ONLY = 'invalid: TICK (BTC-only)';

describe('XBRIDGE acceptance drive, the federation-free legs on DOGE regtest (AT6 and AT7 closure)', function () {

    let venue = null;
    let dogeRail = null;
    let unavailable = null;
    const evidence = {};

    before(async function () {
        this.timeout(0);
        dogeRail = await chainRail.createRail('dogecoin', NETWORK);
        venue = await chainRail.withRail(dogeRail, () => startDogeVenue({ label: 'bridgeguard' }));
        if (!venue) {
            unavailable = 'the DOGE venue indexer could not be built';
            console.log('\nBRIDGE GUARDS: ' + unavailable + '\n');
            return;
        }
        const fixture = require('../attestMirror/mirrorDrillFixture');
        await chainRail.withRail(dogeRail, () => fixture.waitForVenueIndexersAtTip(venue));
        evidence.venueIndexer = venue.indexers[0].apiUrl;
        evidence.venueIndexerDb = venue.indexers[0].indexerDbName;
    });

    // The per-case journal, for the reason the base suite's copy states: a mocha failure
    // message exists only in the epilogue, and an interrupted drive never prints one.
    afterEach(function () {
        const test = this.currentTest || {};
        journalCase({
            suite: 'bridgeRailDogeGuards',
            title: String(test.title || ''),
            state: String(test.state || 'unfinished'),
            durationMs: Number(test.duration || 0),
            error: test.err ? String(test.err.message).slice(0, 4000) : null,
        });
    });

    after(async function () {
        this.timeout(0);
        if (venue) await venue.stop();
        console.log('\n=== bridge guards drive readouts ===\n' + JSON.stringify(evidence, null, 2) + '\n');
        journalCase({ suite: 'bridgeRailDogeGuards', title: '=== readouts ===', state: 'evidence',
            evidence: evidence });
    });

    it('AT6 and AT7: a broadcast ISSUE XCHAIN on DOGE regtest is refused with ' + BTC_ONLY, async function () {
        this.timeout(0);
        if (unavailable) { console.log('  NOT DRIVEN: ' + unavailable); this.skip(); return; }

        const tx = await chainRail.withRail(dogeRail, async () => {
            // UNDER A BUDGET, like every other funding call in the three rail suites: this
            // helper waits on a transaction reaching a block and on the utxo-tracker
            // indexing it, and it loops forever when either never happens. See
            // `fundUnderBudget` for the three drives that ended in that loop.
            const src = await fundUnderBudget('GUARD.ISSUER', () => cryptoHelper.getNewFundedAddress(
                'GUARD.ISSUER', 'dogecoin', NETWORK, null, 'legacy', 0, 1, false),
                { diagnose: (wait) => nodeDiagnosis(wait ? wait.txid : null).then((n) => ({ node: n })) });
            // Raw, not sendIssueV0: the waiting form asserts status=valid and would time
            // out on the refusal this case exists to observe.
            return issueHelper.sendIssueV0Raw(src, GAS_TICK, 100000000, 100000, 0, 'guard drive', 0);
        });
        const got = await verdictOf(venue, 'issues', tx);
        evidence.at6_issueClosure = { tx, verdict: got };
        assert.ok(got, 'the ISSUE was never indexed by the venue DOGE indexer (tx ' + tx + ')');
        assert.strictEqual(got.status, BTC_ONLY,
            'the closure wrote ' + got.status + '. It must be ' + BTC_ONLY + ', and it must be ' +
            'THAT string rather than a clearer one: the verdict is persisted in index_statuses ' +
            'and enters actions_hash, so renaming it re-grades history on replay (D64).');
    });

    it('the STANDING DOGE indexer grades the same transaction identically', async function () {
        this.timeout(0);
        if (unavailable || !evidence.at6_issueClosure) { this.skip(); return; }
        // THE RAIL MOVED UNDER THIS CASE ON 2026-09-12 AND THAT IS WHY IT IS WRITTEN THIS
        // WAY. When the drive started, the standing DOGE indexer ran `1bbc68ae`, predating
        // the bridge, and the case asserted the two indexers DISAGREED, which is what made
        // the venue necessary. Mid-run the fleet redeploy landed `97e7ae1f` and it began
        // writing the bridge verdict, so that assertion went red on a rail that had got
        // BETTER. The durable claim is agreement: the same broadcast, graded the same way
        // by the container the fleet runs and by an indexer spawned from this tree, is
        // what says the deployed code and the landed code are the same rules. A
        // disagreement is then a real finding in either direction, and the message says
        // which reading to trust.
        const tx = evidence.at6_issueClosure.tx;
        const deadline = Date.now() + 300000;
        let status = null;
        while (Date.now() < deadline && status === null) {
            const rows = await chainRail.withRail(dogeRail, async () => {
                // The harness Database exposes a pool, not a query method; every reader in
                // src/db.js takes a connection and releases it, so this does the same.
                const conn = await indexerDatabase.getConnection();
                try {
                    return await conn.query(
                        'SELECT s.status AS status FROM issues i ' +
                        'JOIN actions a ON a.action_index = i.action_index ' +
                        'JOIN transactions t ON t.tx_index = a.tx_index ' +
                        'JOIN index_transactions it ON it.id = t.tx_hash_id ' +
                        'JOIN index_statuses s ON s.id = i.status_id WHERE it.hash = ? LIMIT 1', [tx]);
                } finally { await conn.release(); }
            });
            if (rows.length) status = String(rows[0].status);
            else await new Promise((r) => setTimeout(r, 5000));
        }
        const standingTip = Number((await chainRail.withRail(dogeRail,
            () => indexerConnector.call('getblockhashes', {}))).block_index);
        evidence.at6_standingVerdict = status;
        evidence.at6_standingTip = standingTip;
        console.log('  standing DOGE indexer verdict for ' + tx + ': ' + status +
            ' (standing tip ' + standingTip + ')');

        // An ungraded reading is admitted ONLY as lag, and only when the standing tip is
        // demonstrably below the venue's. Measured 2026-09-12: that container can sit
        // minutes behind its own chain with its block loop parked behind a 598017-row
        // price_snapshots mirror bootstrap after a restart, and reading that silence as
        // agreement would make this case pass while measuring nothing.
        if (status === null) {
            const venueTip = Number((await require('axios').post(venue.indexers[0].apiUrl,
                { jsonrpc: '2.0', id: 1, method: 'getblockhashes', params: {} })).data.result.block_index);
            evidence.at6_venueTip = venueTip;
            assert.fail('the standing DOGE indexer graded nothing for ' + tx + ' within the budget ' +
                '(standing tip ' + standingTip + ', venue tip ' + venueTip + '). If it is behind, ' +
                'it is lag and this case needs a longer budget; if it is level, that container is ' +
                'not applying the rules the tree holds.');
        }
        assert.strictEqual(status, evidence.at6_issueClosure.verdict.status,
            'the standing DOGE indexer wrote ' + status + ' where an indexer spawned from this ' +
            'tree wrote ' + evidence.at6_issueClosure.verdict.status + ' for the same transaction. ' +
            'Read the container\'s xchain.source.commit: the deployed code and the landed code ' +
            'are grading the same action differently, which is a fleet split, not a test fault.');
    });

    it('the controller-guarded ORDER, SEND and DISPENSER carry a recognised verdict on a ledger that holds XCHAIN', async function () {
        this.timeout(0);
        if (unavailable) { console.log('  NOT DRIVEN: ' + unavailable); this.skip(); return; }
        const got = await chainRail.withRail(dogeRail, () => driveVerdictWitness(
            { cryptoHelper, transactionHelper, network: NETWORK, gasTick: GAS_TICK },
            venue, 'AT9.BEFORE'));
        Object.assign(WITNESS_VERDICTS, {
            SEND: got.SEND, ORDER: got.ORDER, DISPENSER: got.DISPENSER,
        });
        evidence.at9_witness = got;
        for (const action of ['SEND', 'ORDER', 'DISPENSER']) {
            assert.ok(got[action],
                'the ' + action + ' from ' + got.source + ' (tx ' + got.txids[action] + ') was never ' +
                'indexed, so no witness verdict exists for it');
            assert.match(got[action], /^(valid|invalid: )/,
                action + ' carried the unrecognised verdict ' + got[action]);
        }
    });
});

