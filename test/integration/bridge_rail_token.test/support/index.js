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
 *********************************************************************/

'use strict';

const assert = require('assert');

const chainRail         = require('../../../helpers/chainRail');
const stakeTeardown     = require('../../../helpers/stakeTeardown');
const cryptoHelper      = require('../../../cryptoHelper');
const transactionHelper = require('../../../transactionHelper');
const issueHelper       = require('../../../helpers/issueHelper');
const fixture           = require('../../../attestMirror/mirrorDrillFixture');
const {
    BridgeRailVenue,
    resolveVenueQuorum,
    minimalQuorumSigners,
    journalCase,
} = require('../../../helpers/bridgeRailVenue');
const token = require('./token');

// The venue bring-up, the per-case hooks and the suite registration, in the shape of
// `bridge_rail_base.test/support` (the same quorum gate, the same replayed DOGE ledger, the
// same price clock and journal) with three differences that are the token drive's own:
//   the venue LABEL and PORT BASE are its own, so its clone, replay, mirror and hub
//     databases never collide with a base drive's and a token run never inherits a
//     base run's DOGE ledger;
//   the journal names this suite;
//   the state carries the token records the legs share (see ./token).
// The bring-up is not imported from the base support because that module keeps its
// hooks private to its own outer suite; the reorg suite carries its own copy for the
// same reason.
//
// ONE FACTORY, TWO DRIVES. The policy rail suite (`bridge_rail_policy.test`) runs on the
// same venue shape with the same token helpers, so the bring-up is built per drive by
// `createRailDrive` rather than copied a third time: each call owns its own state, its own
// outer suite and its own venue label, and the token drive below is the call with the
// values this file always had.

// The token drive's identity: its own databases, ports, suite title and journal name.
const TOKEN_DRIVE = {
    label: 'bridgerailtoken',
    basePort: 45000,
    outerTitle: 'XBRIDGE token acceptance drive on the BTC/DOGE regtest rail (token AT1 to AT8)',
    journalSuite: 'bridgeRailToken',
    logTag: 'TOKEN RAIL',
    readoutTitle: 'token rail drive readouts',
    // BTC at 2, not the rail's pinned 1 (token rail drive 25): at depth 1 the hub can stamp a
    // snapshot_block below the lock's own block and the DOGE escrow proof then refuses a
    // correct lock (hub finding 1 of 2026-09-17_pb-v020-rail-token.md).
    confirmations: { BTC: 2, DOGE: 1 },
};

/**
 * Build one rail drive: its state, its venue bring-up, its hooks and its suite registration.
 *
 * @param {object} cfg  `TOKEN_DRIVE`'s shape; `records` optionally adds per-drive records
 *                      to the state beside the token records every drive's helpers read
 * @returns {object} the exports a leg file destructures
 */
function createRailDrive(cfg) {
    const state = {
        venue: null,
        quorum: null,
        dogeRail: null,
        baseline: null,     // the XCHAIN chain halves after the drain: AT8's control reading
        blocked: null,      // non-null: the measured reason no federated case can run
        priceBeforeCase: null,
        evidence: {},       // every readout this drive took, printed at the end
        tokens: token.records(),
    };
    if (typeof cfg.records === 'function') Object.assign(state, cfg.records());

    async function recordSourceContext() {
        // Which tree this drive is actually running, recorded rather than assumed (the base
        // support says why: the venue spawns out of BRIDGE_RAIL_REPO_ROOT while the test
        // process loads indexer modules of its own).
        state.evidence.repoRoot = process.env.BRIDGE_RAIL_REPO_ROOT || null;
        state.evidence.indexerModulesLoaded = Object.keys(require.cache)
            .filter((p) => /xchain-indexer[\\/]src[\\/]/.test(String(p))).sort();
        state.dogeRail = await chainRail.createRail('dogecoin', NETWORK);
    }

    async function prepareQuorum() {
        // The quorum gate, read off the LIVE chain: the seated set is what it is at drive time.
        const tip = await indexerConnector.call('getblockhashes', {});
        const buried = Number(tip.block_index) -
            Number(require('../../../helpers/hubMirrorTopology').CANONICAL_REORG_BUFFER || 6);
        const set = await stakeTeardown.readCapabilitySet({
            indexer: indexerConnector, capability: 'cross_chain', blockIndex: buried,
        });
        assert.ok(set && !set.error,
            'the cross_chain capability set could not be read at buried block ' + buried +
            '. That is an INSTRUMENT failure and says nothing about the rail.');
        const seated = set.pubkeys.map((pk) => {
            const row = set.byPubkey.get(pk) || {};
            return { pubkey: pk, stake: Number(row.weight || 0) };
        });
        state.quorum = resolveVenueQuorum(seated, fixture._knownSignerSeeds());
        state.evidence.seated = seated.map((s) => s.pubkey.slice(0, 16) + '@' + s.stake).join(', ');
        state.evidence.buriedBlock = buried;
        state.evidence.btcTip = Number(tip.block_index);
        if (!state.quorum.ok) {
            state.blocked = state.quorum.reason;
            console.log('\n' + cfg.logTag + ': no federation can be built here.\n  ' + state.blocked +
                '\n  seated at block ' + buried + ': ' + state.evidence.seated + '\n');
            return null;
        }
        // The minimum quorum, not every adopted key: at the minimum every signature is
        // load-bearing (base support).
        const mesh = minimalQuorumSigners(state.quorum.signers.adopted, state.quorum.signers.totalStake);
        assert.ok(mesh.length, 'no subset of the adopted keys clears the supermajority, which ' +
            'resolveVenueQuorum should already have refused');
        state.evidence.meshSize = mesh.length;
        state.evidence.meshStake = mesh.reduce((n, a) => n + Number(a.stake || 0), 0) +
            ' of ' + state.quorum.signers.totalStake;
        return mesh;
    }

    async function startVenue(mesh) {
        state.venue = new BridgeRailVenue({
            label: cfg.label,
            basePort: cfg.basePort,
            identities: mesh.map((a) => ({ pubkeyHex: a.pubkeyHex, privkeyHex: a.seedHex })),
            dogeRail: state.dogeRail,
            // The rail's pinned depth. AT5 raises it through the ORIGIN ROW (MIN_DEPTH), never
            // here: the claim is that a token's own opt-in outranks the platform pin.
            confirmations: cfg.confirmations,
            // The venue DOGE indexer REPLAYS the standing chain under this tree's bridge code
            // (base dq 5, ruled a): a cloned ledger could already carry a BTC root row from
            // a base drive, and the T0 precondition asserts a fact rather than a hope.
            dogeReplayChain: true,
            // The engine stays unarmed until T0 has read the ledger it is a claim about.
            deferBridgeWiring: true,
        });
        const up = await state.venue.start();
        if (!up) {
            state.blocked = 'the venue could not be built: ' + state.venue.unavailable;
            console.log('\n' + cfg.logTag + ': ' + state.blocked + '\n');
            return;
        }
        await fixture.waitForVenueIndexersAtTip(state.venue.btcVenue);
        // The DOGE side replays from genesis: hours on the first pass, minutes on a resume
        // (base support), so the barrier is sized for the first pass.
        await chainRail.withRail(state.dogeRail, () => fixture.waitForVenueIndexersAtTip(
            state.venue.dogeVenue, { timeoutMs: 300 * 60 * 1000 }));
    }

    async function prepareDrive() {
        await recordSourceContext();
        const mesh = await prepareQuorum();
        if (!mesh) return;
        await startVenue(mesh);
    }

    // Every case's verdict, written as it ends: a mocha failure message exists only in the
    // epilogue and an interrupted drive never prints one (the base support's drive 13).
    function recordCase() {
        const test = this.currentTest || {};
        const err = test.err || null;
        journalCase({
            suite: cfg.journalSuite,
            title: String(test.title || ''),
            state: String(test.state || 'unfinished'),
            durationMs: Number(test.duration || 0),
            error: err ? String(err.message).slice(0, 4000) : null,
        });
    }

    async function finishDrive() {
        this.timeout(0);
        if (state.venue) await state.venue.stop();
        console.log('\n=== ' + cfg.readoutTitle + ' ===\n' + JSON.stringify(state.evidence, null, 2) + '\n');
        journalCase({ suite: cfg.journalSuite, title: '=== readouts ===', state: 'evidence',
            evidence: state.evidence });
        // A leg that reorgs the SHARED BTC regtest chain must not leave it shorter than it
        // found it: that damages a fixture it does not own (reorg suite).
        if (state.evidence.btcTip !== undefined && !state.blocked) {
            const tip = Number((await indexerConnector.call('getblockhashes', {})).block_index);
            state.evidence.endTip = tip;
            assert.ok(tip >= Number(state.evidence.btcTip),
                'this drive left the SHARED BTC regtest chain at height ' + tip + ' having found it at ' +
                state.evidence.btcTip);
        }
    }

    // The fixture's price clock, held still before EVERY case and MEASURED on the mirror first
    // so a clock refusal can be told from a pricing-code refusal (base support, in full). Every
    // ISSUE a drive broadcasts is priced, so the reseed is the hook and not a call in front of
    // the cases known to need it.
    async function refreshPrices() {
        this.timeout(0);
        if (!state.venue || state.blocked) return;
        const title = this.currentTest ? String(this.currentTest.title).slice(0, 70) : null;
        state.priceBeforeCase = await state.venue.readMirrorPrice('DOGE', 'DOGE/USD');
        const hubBefore = await state.venue.readVenuePrice('DOGE/USD');
        state.evidence.priceClock = state.evidence.priceClock || [];
        const clock = { case: title,
            mirror: state.priceBeforeCase ? { ageSeconds: state.priceBeforeCase.ageSeconds,
                stale: state.priceBeforeCase.stale, round: state.priceBeforeCase.round,
                price: state.priceBeforeCase.price } : null,
            hub: hubBefore ? { ageSeconds: hubBefore.ageSeconds, stale: hubBefore.stale,
                round: hubBefore.round, price: hubBefore.price } : null };
        const reseed = await state.venue.refreshVenuePrices();
        clock.reseed = reseed ? { round: reseed.round, hubsSeeded: reseed.hubsSeeded,
            mirrors: reseed.mirrors } : null;
        state.evidence.priceClock.push(clock);
        const took = reseed && Object.keys(reseed.mirrors).every((c) => reseed.mirrors[c].confirmed);
        console.log('  price reseed before "' + title + '": round ' + (reseed ? reseed.round : 'none') +
            (reseed ? ', mirrors ' + Object.keys(reseed.mirrors).map((c) => c + (reseed.mirrors[c].confirmed
                ? ' confirmed after ' + reseed.mirrors[c].afterMs + 'ms'
                : ' NOT CONFIRMED (' + (reseed.mirrors[c].lastError || 'row absent') + ')')).join(', ') : '') +
            (took ? '' : '  <-- the reseed did not take'));
    }

    /**
     * Skip THIS case with the measured blocker, naming the AT that goes unproven.
     */
    function needsFederation(ctx, at) {
        if (!state.blocked) return false;
        console.log('  ' + at + ' NOT DRIVEN: ' + state.blocked);
        ctx.skip();
        return true;
    }

    let outerSuite = null;

    function registerHooks() {
        before(async function () {
            this.timeout(0);
            await prepareDrive();
        });
        afterEach(recordCase);
        after(finishDrive);
        beforeEach(refreshPrices);
    }

    // One outer suite in many files: each part registers its cases here and they run in the
    // command-line order, root first, then the `0N_` parts, all under one bring-up.
    function bridgeRailSuite(title, callback) {
        if (!outerSuite) {
            outerSuite = describe(cfg.outerTitle, function () {
                registerHooks();
            });
        }
        const child = describe(title, callback);
        const rootSuite = child.parent;
        rootSuite.suites.splice(rootSuite.suites.indexOf(child), 1);
        outerSuite.addSuite(child);
    }

    return Object.assign({
        assert,
        chainRail,
        cryptoHelper,
        transactionHelper,
        issueHelper,
        state,
        needsFederation,
        bridgeRailSuite,
    }, token.bind(state));
}

// Requiring this module builds the token drive and nothing else: `describe` is only called
// on a leg's first `bridgeRailSuite`, so a policy run that reaches `createRailDrive` through
// here registers no token suite.
module.exports = Object.assign(createRailDrive(TOKEN_DRIVE), { createRailDrive, TOKEN_DRIVE });
