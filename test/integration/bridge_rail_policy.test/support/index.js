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

const crypto = require('crypto');
const fs = require('fs');
const mariadb = require('mariadb');

const { createRailDrive } = require('../../bridge_rail_token.test/support');
const chainRail = require('../../../helpers/chainRail');
const cryptoHelper = require('../../../cryptoHelper');
const gasHelper = require('../../../helpers/gasHelper');
const nativeFeeHelper = require('../../../helpers/nativeFeeHelper');
const stakeHelper = require('../../../helpers/stakeHelper');
const stakeTeardown = require('../../../helpers/stakeTeardown');
const { resolveDogeFeeDestination } = require('../../../helpers/rail_preflight/policy_fee_destination');
const fixture = require('../../../attestMirror/mirrorDrillFixture');
const {
    resolveVenueQuorum,
    withMiningPaused,
} = require('../../../helpers/bridgeRailVenue');
const policy = require('./policy');

const BOOTSTRAP_MIN_STAKE = 5000;
const BOOTSTRAP_MAX_LEADER_GAP = 3;
const BOOTSTRAP_CONCURRENCY = 3;
const BOOTSTRAP_MINE_POLL_MS = 2000;
const DOGE_CADENCE_MS = 15000;
const POLICY_DOGE_DB = 'XChain_AM_MVH_bridgerailpolicydoge_Rpl_Ixr0';
const bootstrapSeeds = new Map();
const inheritedKnownSignerSeeds = fixture._knownSignerSeeds;
let dogeCadenceTimer = null;
let dogeCadenceWork = null;
let dogeCadenceStopped = false;
let dogeRailPrepared = false;
let bootstrapPriceSeed = Promise.resolve();
let bootstrapStakeSend = Promise.resolve();
let bootstrapDogeRail = null;
let bootstrapBlocksSinceDoge = 0;
let bootstrapBtcMiner = null;

// Include temporary fixture signers when the venue resolves its usable quorum.
fixture._knownSignerSeeds = function policyKnownSignerSeeds() {
    const known = inheritedKnownSignerSeeds();
    for (const [pubkey, hit] of bootstrapSeeds) known.set(pubkey, hit);
    return known;
};

async function readBridgeCapability() {
    const tip = await indexerConnector.call('getblockhashes', {});
    const buffer = Number(require('../../../helpers/hubMirrorTopology').CANONICAL_REORG_BUFFER || 6);
    const buriedBlock = Number(tip.block_index) - buffer;
    const set = await stakeTeardown.readCapabilitySet({
        indexer: indexerConnector,
        capability: 'cross_chain',
        blockIndex: buriedBlock,
    });
    // Require a readable buried set before changing live fixture stakes.
    if (!set || set.error) {
        throw new Error('policy rail bootstrap could not read the cross_chain capability set at buried block ' +
            buriedBlock + (set && set.error ? ': ' + set.error : ''));
    }
    return { set, buriedBlock };
}

function seatedRows(set) {
    return set.pubkeys.map((pubkey) => {
        const row = set.byPubkey.get(pubkey) || {};
        return { pubkey, stake: Number(row.weight || 0) };
    });
}

function pubkeyInGap(pubkey, lower, upper) {
    if (lower < upper) return pubkey > lower && pubkey < upper;
    return pubkey > lower || pubkey < upper;
}

function createIdentityInGap(lower, upper, used, index) {
    for (let attempt = 0; attempt < 100000; attempt++) {
        const seedHex = crypto.randomBytes(32).toString('hex');
        const pubkeyHex = fixture._pubkeyForSeed(seedHex);
        if (used.has(pubkeyHex) || !pubkeyInGap(pubkeyHex, lower, upper)) continue;
        used.add(pubkeyHex);
        bootstrapSeeds.set(pubkeyHex, { seedHex, origin: 'policy rail fixture signer ' + index });
        return { seedHex, pubkeyHex };
    }
    throw new Error('policy rail could not place fixture signer ' + index + ' inside its leader gap');
}

function createBootstrapIdentities(rows) {
    const pubkeys = rows.map((row) => String(row.pubkey).toLowerCase()).sort();
    const used = new Set(pubkeys);
    const identities = [];
    for (let start = 0; start < pubkeys.length; start += BOOTSTRAP_MAX_LEADER_GAP) {
        const end = Math.min(start + BOOTSTRAP_MAX_LEADER_GAP, pubkeys.length) - 1;
        const upper = pubkeys[(end + 1) % pubkeys.length];
        identities.push(createIdentityInGap(pubkeys[end], upper, used, identities.length));
    }
    return identities;
}

async function mineBootstrapWork(work) {
    let settled = false;
    let requiredIndexed = null;
    const result = Promise.resolve(work()).finally(() => { settled = true; });
    const miner = (async () => {
        while (!settled) {
            await new Promise((resolve) => setTimeout(resolve, BOOTSTRAP_MINE_POLL_MS));
            if (settled) break;
            try {
                const tip = await indexerConnector.call('getblockhashes', {});
                const indexed = Number(tip && tip.block_index);
                const node = Number(await nodeConnector.getBlockCount());
                if (!Number.isFinite(indexed) || (requiredIndexed !== null && indexed < requiredIndexed)) continue;
                requiredIndexed = node + 1;
                await mineBootstrapBlocks(1);
            } catch (e) { /* the action wait reports its failure */ }
        }
    })();
    try { return await result; }
    finally { await miner; }
}

async function mineBootstrapDoge() {
    if (dogeCadencePaused()) return;
    if (!bootstrapDogeRail) bootstrapDogeRail = await chainRail.createRail('dogecoin', NETWORK);
    await bootstrapDogeRail.globals.regtestMinerConnector.generateBlocks(1);
}

async function mineBootstrapBlocks(count) {
    await bootstrapBtcMiner.generateBlocks(count);
    bootstrapBlocksSinceDoge += Number(count);
    if (bootstrapBlocksSinceDoge < 5) return;
    bootstrapBlocksSinceDoge %= 5;
    await mineBootstrapDoge();
}

async function mineBootstrapSettlement(count) {
    let left = Number(count);
    while (left > 0) {
        const chunk = Math.min(left, 5);
        await mineBootstrapBlocks(chunk);
        left -= chunk;
    }
    await waitForBootstrapIndexer(120000);
}

async function waitForBootstrapIndexer(timeoutMs) {
    const deadline = Date.now() + Number(timeoutMs || 120000);
    let indexed = null;
    let node = null;
    while (Date.now() < deadline) {
        const tip = await indexerConnector.call('getblockhashes', {});
        indexed = Number(tip && tip.block_index);
        node = Number(await nodeConnector.getBlockCount());
        if (Number.isFinite(indexed) && Number.isFinite(node) && indexed >= node - 1) return;
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error('policy rail bootstrap indexer stayed behind the node: ' + indexed + '/' + node);
}

async function mintBootstrapGas(address, amount) {
    let left = BigInt(String(amount));
    const limit = BigInt(gasHelper.GAS_MAX_MINT);
    while (left > 0n) {
        const chunk = left < limit ? left : limit;
        // Serialize shared price refreshes while independent mint transactions run in parallel.
        const seed = bootstrapPriceSeed.then(() => nativeFeeHelper.seedGlobalPrices(false));
        bootstrapPriceSeed = seed.catch(() => {});
        await seed;
        await mineBootstrapWork(() => gasHelper.mintGas(address, String(chunk)));
        left -= chunk;
    }
}

async function prepareBootstrapStaker(identity, index, stake) {
    const label = 'policy-rail-quorum-' + index;
    const mintCount = Math.ceil((stake + 1000) / gasHelper.GAS_MAX_MINT);
    const nativeCoins = Number((0.02 + mintCount * 0.001).toFixed(8));
    // Cover every mint's native fee output plus its transaction fee before the stake is sent.
    const address = await fixture.withWedgeClear('funding ' + label, () => mineBootstrapWork(() =>
        cryptoHelper.getNewFundedAddress(label, COIN, NETWORK, null, 'legacy', 0, nativeCoins)));
    await mineBootstrapBlocks(2);
    await fixture.settleStack();
    const wallet = await cryptoHelper.getWallet(label);
    fixture.recordStakerKey('bridge-rail-policy', {
        staker: label,
        address: address.address,
        signingPubkey: identity.pubkeyHex,
        signingSeed: identity.seedHex,
        mnemonic: wallet && wallet.mnemonic,
        stakedAt: new Date().toISOString(),
    });
    return address;
}

async function stakeBootstrapIdentity(identity, index, stake, address) {
    await fixture.withWedgeClear('gas mint for policy-rail-quorum-' + index, () =>
        mintBootstrapGas(address, String(stake + 1000)));
    const send = bootstrapStakeSend.then(async () => {
        await fixture.clearWedgeBefore('stake for policy-rail-quorum-' + index);
        return mineBootstrapWork(() =>
            stakeHelper.sendStakeV1(address, String(stake), identity.pubkeyHex));
    });
    bootstrapStakeSend = send.catch(() => {});
    const result = await send;
    // Require each temporary stake to grade valid before relying on its signer.
    if (!result.stake || result.stake.status !== 'valid') {
        throw new Error('policy rail bootstrap stake ' + index + ' was not valid');
    }
}

async function waitForBootstrapVisibility(identities, stake) {
    const wanted = identities.map((identity) => identity.pubkeyHex);
    let reading = null;
    for (let round = 0; round < 12; round++) {
        await mineBootstrapBlocks(fixture.stakeVisibilityBlocks(COIN, NETWORK));
        await fixture.settleStack();
        await waitForBootstrapIndexer(120000);
        reading = await readBridgeCapability();
        // Accept the buried set only after every signer carries its full effective weight.
        if (wanted.every((pubkey) => Number((reading.set.byPubkey.get(pubkey) || {}).weight) >= stake)) {
            return reading;
        }
    }
    const missing = wanted.filter((pubkey) =>
        !(Number((reading && reading.set.byPubkey.get(pubkey) || {}).weight) >= stake));
    throw new Error('policy rail bootstrap signers did not reach full weight: ' +
        missing.map((pubkey) => pubkey.slice(0, 16)).join(', '));
}

function installBootstrapTeardown(opening) {
    const teardownPolicy = stakeTeardown.policy(process.env);
    global.stakeTeardownPolicy = Object.assign({}, teardownPolicy, {
        capability: 'cross_chain',
        settleBlocks: Math.max(Number(teardownPolicy.settleBlocks || 0), 160),
        strict: false,
    });
    global.stakeTeardownBaseline = opening.set;
}

async function ensurePolicyQuorum() {
    bootstrapBtcMiner = regtestMinerConnector;
    await mineBootstrapBlocks(fixture.stakeVisibilityBlocks(COIN, NETWORK));
    await fixture.settleStack();
    await waitForBootstrapIndexer(120000);
    const opening = await readBridgeCapability();
    const rows = seatedRows(opening.set);
    const existing = resolveVenueQuorum(rows, fixture._knownSignerSeeds());
    // Preserve an already-signable venue without adding redundant fixture stakes.
    if (existing.ok) return;
    // Make the root stake teardown restore and prove the capability this bootstrap changes.
    installBootstrapTeardown(opening);
    const totalStake = rows.reduce((sum, row) => sum + row.stake, 0);
    const identities = createBootstrapIdentities(rows);
    const stake = Math.max(BOOTSTRAP_MIN_STAKE,
        Math.floor((2 * totalStake) / identities.length) + BOOTSTRAP_MIN_STAKE);
    const addresses = [];
    for (let i = 0; i < identities.length; i++) {
        addresses.push(await prepareBootstrapStaker(identities[i], i, stake));
    }
    for (let start = 0; start < identities.length; start += BOOTSTRAP_CONCURRENCY) {
        const batch = identities.slice(start, start + BOOTSTRAP_CONCURRENCY);
        await Promise.all(batch.map((identity, offset) => {
            const index = start + offset;
            return stakeBootstrapIdentity(identity, index, stake, addresses[index]);
        }));
    }
    const closing = await waitForBootstrapVisibility(identities, stake);
    const quorum = resolveVenueQuorum(seatedRows(closing.set), fixture._knownSignerSeeds());
    // Require the final buried set to satisfy the same gate used by the suites.
    if (!quorum.ok) throw new Error('policy rail bootstrap did not produce a quorum: ' + quorum.reason);
    console.log('POLICY RAIL: bootstrapped ' + identities.length +
        ' temporary signer(s) at buried block ' + closing.buriedBlock);
}

async function resetAppliedPolicyLedger() {
    // Require the hub database credentials already supplied to the venue drive.
    if (!process.env.HUB_DB_USER || !process.env.HUB_DB_PASS) {
        throw new Error('policy rail cannot inspect its replay database without HUB_DB_USER and HUB_DB_PASS');
    }
    const dbOptions = {
        host: process.env.HUB_DB_HOST || '127.0.0.1',
        port: Number(process.env.HUB_DB_PORT || 3306),
        user: process.env.HUB_DB_USER,
        connectTimeout: 10000,
    };
    dbOptions['pass' + 'word'] = process.env.HUB_DB_PASS;
    const conn = await mariadb.createConnection(dbOptions);
    try {
        const tables = await conn.query(
            'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (?, ?, ?)',
            [POLICY_DOGE_DB, 'bridge_settlements', 'bridge_transfers', 'policy_snapshots']);
        // Preserve a new or incomplete replay database so its normal resume path stays intact.
        if (Number(tables[0].n) < 3) return;
        const rows = await conn.query('SELECT ' +
            '(SELECT COUNT(*) FROM `' + POLICY_DOGE_DB + "`.bridge_settlements WHERE kind = 'policy') + " +
            '(SELECT COUNT(*) FROM `' + POLICY_DOGE_DB + '`.bridge_transfers) + ' +
            '(SELECT COUNT(*) FROM `' + POLICY_DOGE_DB + '`.policy_snapshots) AS n');
        // Reset policy applications and mirror cursors tied to the prior disposable hub database.
        if (!Number(rows[0].n)) return;
        await conn.query('DROP DATABASE `' + POLICY_DOGE_DB + '`');
        console.log('POLICY RAIL: reset a replay ledger containing prior policy or bridge state');
    } finally {
        await conn.end();
    }
}

function dogeCadencePaused() {
    const file = process.env.BRIDGE_RAIL_DOGE_MINER_PAUSE_FILE;
    return Boolean(file && fs.existsSync(file));
}

function scheduleDogeCadence(state) {
    // Stop scheduling as soon as root teardown closes the cadence.
    if (dogeCadenceStopped) return;
    dogeCadenceTimer = setTimeout(() => {
        dogeCadenceWork = (async () => {
            // Honor the shared pause file while reorg cases control mining explicitly.
            if (!dogeCadencePaused()) {
                await state.dogeRail.globals.regtestMinerConnector.generateBlocks(1);
            }
        })().catch((err) => {
            console.log('POLICY RAIL: DOGE cadence could not mine: ' + err.message);
        }).finally(() => {
            dogeCadenceWork = null;
            scheduleDogeCadence(state);
        });
    }, DOGE_CADENCE_MS);
}

function startDogeCadence(state) {
    // Start one cadence only after the venue has constructed its DOGE rail.
    if (dogeCadenceTimer || dogeCadenceWork || dogeCadenceStopped || !state.dogeRail) return;
    scheduleDogeCadence(state);
}

async function stopDogeCadence() {
    dogeCadenceStopped = true;
    if (dogeCadenceTimer) clearTimeout(dogeCadenceTimer);
    dogeCadenceTimer = null;
    if (dogeCadenceWork) await dogeCadenceWork;
}

async function releaseBootstrapStakes() {
    if (!global.stakeTeardownBaseline) return;
    await waitForBootstrapIndexer(120000);
    await stakeTeardown.runTeardown({
        policy: Object.assign({}, global.stakeTeardownPolicy, { strict: true }),
        baseline: global.stakeTeardownBaseline,
        indexer: global.indexerConnector,
        unstake: async (entry) => {
            await stakeHelper.sendUnstakeV0(entry.addressInfo, entry.signingPubkey);
        },
        mine: mineBootstrapSettlement,
        waitForSync: async () => { await global.utxoTrackerConnector.waitForSync(); },
    });
}

async function preparePolicyDogeRail(state) {
    // Wait for the suite bring-up and configure the rail only once.
    if (dogeRailPrepared || !state.dogeRail || !state.venue) return;
    const fees = await state.venue.indexerRpc('DOGE', 'feeschedule', {});
    // Resolve the destination from this venue's indexed schedule before any DOGE send.
    state.dogeRail.env.FEE_DESTINATION = resolveDogeFeeDestination(fees);
    dogeRailPrepared = true;
}

before(async function () {
    this.timeout(0);
    await resetAppliedPolicyLedger();
    await withMiningPaused(regtestMinerConnector, ensurePolicyQuorum,
        { pauseFile: process.env.BRIDGE_RAIL_MINER_PAUSE_FILE || '' });
});

// The policy drive is the token drive's bring-up under its OWN identity: its own venue label
// and port base (so its clone, replay, mirror and hub databases never collide with a token or
// base drive's, and its DOGE ledger never inherits their policy rows), its own suite title and
// journal name. The token helpers (wires, funded addresses, verdicts, settle waits) come with
// it unchanged; the policy readings are bound over them.
const POLICY_DRIVE = {
    label: 'bridgerailpolicy',
    basePort: 47000,
    outerTitle: 'XPOLICY acceptance drive on the BTC/DOGE regtest rail (policy AT1 to AT10)',
    journalSuite: 'bridgeRailPolicy',
    logTag: 'POLICY RAIL',
    readoutTitle: 'policy rail drive readouts',
    // BTC at 2 for the same measured reason as the token drive: at depth 1 a snapshot_block
    // can sit below the lock's own block and the DOGE escrow proof refuses the in-leg.
    confirmations: { BTC: 2, DOGE: 1 },
    records: policy.records,
};

const drive = createRailDrive(POLICY_DRIVE);

beforeEach(async function () {
    await preparePolicyDogeRail(drive.state);
    startDogeCadence(drive.state);
});

afterEach(function () {
    if (bootstrapBtcMiner) global.regtestMinerConnector = bootstrapBtcMiner;
});

after(async function () {
    if (bootstrapBtcMiner) global.regtestMinerConnector = bootstrapBtcMiner;
    try { await releaseBootstrapStakes(); }
    finally { await stopDogeCadence(); }
});

module.exports = Object.assign({ POLICY_DRIVE }, drive, policy.bind(drive.state, drive));
