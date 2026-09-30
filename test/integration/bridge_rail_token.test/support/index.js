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
const fs = require('fs');
const { execFileSync } = require('child_process');
const axios = require('axios');

const XChainHubConnector = require('../../../../src/XChainHubConnector');
const chainRail         = require('../../../helpers/chainRail');
const stakeTeardown     = require('../../../helpers/stakeTeardown');
const cryptoHelper      = require('../../../cryptoHelper');
const transactionHelper = require('../../../transactionHelper');
const issueHelper       = require('../../../helpers/issueHelper');
const fixture           = require('../../../attestMirror/mirrorDrillFixture');
const { checkFullDriveReady } = require('../../../helpers/rail_preflight/full_drive_ready');
const { requireHealthyHub } = require('../../../helpers/rail_preflight/hub_health_gate');
const {
    ancestorPids,
    launchParentIsAttached,
} = require('../../../helpers/rail_preflight/rail_drive_processes');
const { withDogeFeeSchedule } = require('../../../helpers/rail_preflight/token_doge_fee');
const { caseJournalEntry } = require('../../../helpers/rail_preflight/case_journal_entry');
const { evidenceJson } = require('../../../helpers/rail_preflight/evidence_json');
const {
    BridgeRailVenue,
    resolveVenueQuorum,
    minimalQuorumSigners,
    journalCase,
    withMiningPaused,
} = require('../../../helpers/bridgeRailVenue');
const token = require('./token');
const { ensureBridgeRailQuorum, releaseBridgeRailQuorum } = require('./quorum');
const {
    DEFAULT_BUDGET_MS,
    miningNodeTipReaders,
    readTipAdvance,
    minerStallReason,
} = require('./miner_liveness');
const { DOGE_INDEXER_CANDIDATE_PORTS, resolveIndexerPort, tcpAccepts } = require('./rail_ports');
const { dropStaleReplayBeforeVenue } = require('./stale_replay');

const RAIL_WAIT_ATTEMPTS = 120;
const RAIL_WAIT_MS = 60 * 1000;
const LAUNCH_MONITOR_MS = 5 * 1000;

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// The standing hub connector, published on the global when nothing set one, so every
// later reader of global.hubConnector in the drive (policy or token) sees the same hub
// the preflight verified. A connector the caller already selected is kept.
function driveHubConnector() {
    if (!global.hubConnector || !Array.isArray(global.hubConnector.urls) || !global.hubConnector.urls.length)
        global.hubConnector = new XChainHubConnector(XChainHubConnector.parseEndpoints());
    return global.hubConnector;
}

async function fullDrivePreflight(connector) {
    const endpoint = connector && Array.isArray(connector.urls) ? connector.urls[0] : null;
    let pingStatusCode = 0;
    let pingBodyText = '';
    if (endpoint) {
        try {
            const response = await axios.post(endpoint, {
                jsonrpc: '2.0', method: 'ping', id: 1,
            }, {
                timeout: 5000,
                validateStatus: () => true,
                transformResponse: [(body) => body],
            });
            pingStatusCode = response.status;
            pingBodyText = response.data;
        } catch (error) {
            pingBodyText = JSON.stringify({ error: { code: error.code || 'unreachable' } });
        }
    }
    const psText = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' });
    return Object.assign({ hubStatusCode: pingStatusCode }, checkFullDriveReady({
        pingStatusCode,
        pingBodyText,
        psText,
        ownPids: ancestorPids(psText, process.pid),
    }));
}
async function pingDriveHub(connector) {
    const response = await axios.post(connector.urls[0], {
        jsonrpc: '2.0',
        method: 'ping',
        id: 1,
    }, {
        timeout: 5000,
        validateStatus: () => true,
        transformResponse: [(body) => body],
    });
    return { statusCode: response.status, bodyText: response.data };
}

async function waitForCompetingDrive(connector) {
    let preflight = null;
    for (let attempt = 1; attempt <= RAIL_WAIT_ATTEMPTS; attempt++) {
        preflight = await fullDrivePreflight(connector);
        if (preflight.reason !== 'other-drive' && preflight.reason !== 'hub+other-drive') return;
        if (attempt === RAIL_WAIT_ATTEMPTS) break;
        console.log('RAIL WAIT: another bridge rail drive is running (' + attempt + '/' +
            RAIL_WAIT_ATTEMPTS + ')');
        await wait(RAIL_WAIT_MS);
    }
    assert.ok(false, 'token rail full-drive preflight timed out waiting for the other drive: ' +
        (preflight && preflight.reason));
}

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
    stakerLabel: 'bridge-rail-token',
    basePort: 45000,
    outerTitle: 'XBRIDGE token acceptance drive on the BTC/DOGE regtest rail (token AT1 to AT8)',
    journalSuite: 'bridgeRailToken',
    logTag: 'TOKEN RAIL',
    readoutTitle: 'token rail drive readouts',
    dropStaleReplay: true,
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
    let driveEnding = false;
    let quorumReleaseRequired = false;
    let launchMonitor = null;
    if (typeof cfg.records === 'function') Object.assign(state, cfg.records());

    async function recordSourceContext() {
        // Which tree this drive is actually running, recorded rather than assumed (the base
        // support says why: the venue spawns out of BRIDGE_RAIL_REPO_ROOT while the test
        // process loads indexer modules of its own).
        state.evidence.repoRoot = process.env.BRIDGE_RAIL_REPO_ROOT || null;
        state.evidence.indexerModulesLoaded = Object.keys(require.cache)
            .filter((p) => /xchain-indexer[\\/]src[\\/]/.test(String(p))).sort();
        const dogeIndexer = await resolveIndexerPort({
            configured: process.env.DOGE_INDEXER_API_PORT,
            candidates: DOGE_INDEXER_CANDIDATE_PORTS,
            accepts: tcpAccepts(process.env.DOGE_SERVICE_HOST || 'localhost', 2000),
        });
        if (dogeIndexer.source === 'probe') process.env.DOGE_INDEXER_API_PORT = String(dogeIndexer.port);
        state.evidence.dogeIndexerPort = dogeIndexer;
        state.dogeRail = await chainRail.createRail('dogecoin', NETWORK);
    }

    async function requireMinersAlive() {
        const watched = await readTipAdvance({
            readers: miningNodeTipReaders({
                btcNode: nodeConnector,
                dogeRail: state.dogeRail,
                withRail: chainRail.withRail,
            }),
            sleep: wait,
            now: Date.now,
        });
        state.evidence.minerLiveness = watched;
        const pauseFilesPresent = [process.env.BRIDGE_RAIL_MINER_PAUSE_FILE,
            process.env.BRIDGE_RAIL_DOGE_MINER_PAUSE_FILE]
            .filter((file) => file && fs.existsSync(file));
        assert.ok(watched.alive, minerStallReason(watched.stalled, DEFAULT_BUDGET_MS, pauseFilesPresent));
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
        if (cfg.dropStaleReplay) await dropStaleReplayBeforeVenue(cfg.label);
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
        const connector = driveHubConnector();
        await waitForCompetingDrive(connector);
        await requireHealthyHub(() => pingDriveHub(connector));
        const preflight = await fullDrivePreflight(connector);
        state.evidence.preflight = preflight;
        assert.ok(preflight.ready, 'token rail full-drive preflight failed: ' + preflight.reason);
        await recordSourceContext();
        await requireMinersAlive();
        // Only a drive that names a staker label brings up this shared quorum. The policy
        // drive names none: it stakes and releases its signers through its own bring-up,
        // which reuses recorded signers and batches its releases.
        if (cfg.stakerLabel) {
            quorumReleaseRequired = true;
            await withMiningPaused(regtestMinerConnector,
                () => ensureBridgeRailQuorum(cfg.stakerLabel),
                { pauseFile: process.env.BRIDGE_RAIL_MINER_PAUSE_FILE || '' });
        }
        const mesh = await prepareQuorum();
        if (!mesh) return;
        await startVenue(mesh);
        if (!state.blocked) state.evidence.drivePrepared = true;
    }

    // Every case's verdict, written as it ends: a mocha failure message exists only in the
    // epilogue and an interrupted drive never prints one (the base support's drive 13).
    function recordCase() {
        journalCase(caseJournalEntry(this.currentTest || {}, cfg.journalSuite, state.blocked));
    }

    async function stopVenueAndReleaseQuorum() {
        try {
            if (state.venue) await state.venue.stop();
        } finally {
            if (quorumReleaseRequired) await releaseBridgeRailQuorum();
        }
    }

    async function finishDrive() {
        this.timeout(0);
        driveEnding = true;
        if (launchMonitor) clearInterval(launchMonitor);
        await stopVenueAndReleaseQuorum();
        console.log('\n=== ' + cfg.readoutTitle + ' ===\n' + evidenceJson(state.evidence, 2) + '\n');
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

    function exitWhenLaunchSessionLeaves() {
        const launchParentPid = process.ppid;
        const leave = (reason) => {
            if (driveEnding) return;
            driveEnding = true;
            if (launchMonitor) clearInterval(launchMonitor);
            journalCase({ suite: cfg.journalSuite, title: '=== drive orphaned ===', state: 'evidence',
                evidence: { reason } });
            Promise.resolve()
                .then(stopVenueAndReleaseQuorum)
                .catch(() => {})
                .then(() => process.exit(2));
        };
        process.stdout.on('error', (err) => {
            if (err && err.code === 'EPIPE') leave('the output pipe closed, so the launching session is gone');
        });
        launchMonitor = setInterval(() => {
            let psText;
            try {
                psText = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' });
            } catch (error) {
                return;
            }
            if (!launchParentIsAttached(psText, process.pid, launchParentPid)) {
                leave('the launch parent is gone, so the launching session is gone');
            }
        }, LAUNCH_MONITOR_MS);
        launchMonitor.unref();
    }

    let outerSuite = null;

    function registerHooks() {
        before(async function () {
            this.timeout(0);
            exitWhenLaunchSessionLeaves();
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
    }, withDogeFeeSchedule(token.bind(state), state));
}

// Requiring this module builds the token drive and nothing else: `describe` is only called
// on a leg's first `bridgeRailSuite`, so a policy run that reaches `createRailDrive` through
// here registers no token suite.
module.exports = Object.assign(createRailDrive(TOKEN_DRIVE), { createRailDrive, TOKEN_DRIVE });
