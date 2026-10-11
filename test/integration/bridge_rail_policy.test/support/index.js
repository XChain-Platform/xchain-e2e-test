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
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const mariadb = require('mariadb');
const path = require('path');

const bridgeRailVenue = require('../../../helpers/bridgeRailVenue');
const { policyBridgeRailVenue } = require('./policy_venue');
// Bind the shared drive factory to the policy venue subclass only while the factory loads.
function loadPolicyDriveFactory() {
    const inherited = bridgeRailVenue.BridgeRailVenue;
    bridgeRailVenue.BridgeRailVenue = policyBridgeRailVenue(inherited);
    try { return require('../../bridge_rail_token.test/support').createRailDrive; }
    finally { bridgeRailVenue.BridgeRailVenue = inherited; }
}
const createRailDrive = loadPolicyDriveFactory();
const chainRail = require('../../../helpers/chainRail');
const cryptoHelper = require('../../../helpers/core/cryptoHelper');
const gasHelper = require('../../../helpers/gasHelper');
const nativeFeeHelper = require('../../../helpers/nativeFeeHelper');
const sendHelper = require('../../../helpers/sendHelper');
const stakeHelper = require('../../../helpers/stakeHelper');
const stakeTeardown = require('../../../helpers/stakeTeardown');
const { resolveDogeFeeDestination } = require('../../../helpers/rail_preflight/policy_fee_destination');
const { requireHealthyHub } = require('../../../helpers/rail_preflight/hub_health_gate');
const fixture = require('../../../attestMirror/helpers/mirrorDrillFixture');
const { settleReleaseBatch, waitForCapabilityBaseline } = require('./release_batch');
const { checkBootstrapGas } = require('./gas_budget');
const { installStandingHubConnector } = require('./standing_hub');
const {
    resolveVenueQuorum,
    withMiningPaused,
} = bridgeRailVenue;
const policy = require('./policy');

const BOOTSTRAP_MIN_STAKE = 5000;
const BOOTSTRAP_MAX_LEADER_GAP = 3;
const BOOTSTRAP_CONCURRENCY = 3;
const BOOTSTRAP_MINE_POLL_MS = 2000;
const BOOTSTRAP_MAX_INDEXER_LAG = 2;
const BOOTSTRAP_NUDGE_MS = 30000;
// Slow action blocks can consume most of the venue indexer's 30 minute block watchdog.
const BOOTSTRAP_SYNC_TIMEOUT_MS = 45 * 60 * 1000;
const BOOTSTRAP_WAIT_EXTENSIONS = 12;
// The release batch needs the same allowance before teardown can prove the restored roster.
const BOOTSTRAP_RELEASE_BUDGET_MS = 45 * 60 * 1000;
const DOGE_CADENCE_MS = 15000;
const POLICY_DOGE_DB = 'XChain_AM_MVH_bridgerailpolicydoge_Rpl_Ixr0';
const bootstrapSeeds = new Map();
const inheritedKnownSignerSeeds = fixture['_knownSignerSeeds'];
let dogeCadenceTimer = null;
let dogeCadenceWork = null;
let dogeCadenceStopped = false;
let dogeRailPrepared = false;
let bootstrapPriceSeed = Promise.resolve();
let bootstrapDonorSend = Promise.resolve();
let bootstrapDonorLedger = null;
let bootstrapStakeSend = Promise.resolve();
let bootstrapDogeRail = null;
let bootstrapBlocksSinceDoge = 0;
let bootstrapBtcMiner = null;
let bootstrapTeardownInstalled = false;
let bootstrapReleaseBatch = null;
let lastMiningHoldLog = 0;
const bootstrapStakerAddresses = new Set();

// Include temporary fixture signers when the venue resolves its usable quorum.
fixture['_knownSignerSeeds'] = function policyKnownSignerSeeds() {
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
        const pubkeyHex = fixture['_pubkeyForSeed'](seedHex);
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

function noteMiningHold(indexed, node) {
    if (Date.now() - lastMiningHoldLog < 60000) return;
    lastMiningHoldLog = Date.now();
    console.log('POLICY RAIL: mining held, indexer at ' + indexed + ' and node at ' + node);
}

async function mineBootstrapWork(work) {
    let settled = false;
    const result = Promise.resolve(work()).finally(() => { settled = true; });
    const miner = (async () => {
        while (!settled) {
            await new Promise((resolve) => setTimeout(resolve, BOOTSTRAP_MINE_POLL_MS));
            if (settled) break;
            try {
                const tip = await indexerConnector.call('getblockhashes', {});
                const indexed = Number(tip && tip.block_index);
                const node = Number(await nodeConnector.getBlockCount());
                if (!Number.isFinite(indexed) || !Number.isFinite(node) || indexed < node - BOOTSTRAP_MAX_INDEXER_LAG) {
                    noteMiningHold(indexed, node);
                    continue;
                }
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

async function paceBootstrapDoge(count) {
    bootstrapBlocksSinceDoge += Number(count);
    if (bootstrapBlocksSinceDoge < 5) return;
    bootstrapBlocksSinceDoge %= 5;
    await mineBootstrapDoge();
}

async function mineBootstrapBlocks(count) {
    await bootstrapBtcMiner.generateBlocks(count);
    await paceBootstrapDoge(count);
}

async function mineBootstrapSettlement(count) {
    let left = Number(count);
    while (left > 0) {
        const chunk = Math.min(left, 5);
        await mineBootstrapBlocks(chunk);
        left -= chunk;
    }
    await waitForBootstrapIndexer(BOOTSTRAP_SYNC_TIMEOUT_MS);
}

function indexerPoolClosed() {
    const pool = global.indexerDatabase && global.indexerDatabase.pool;
    return !pool || pool.closed === true;
}

// Refresh prices and mine one block when the indexer stops advancing behind the tip.
// The refresh is best effort: a closed database pool must not replace the stall
// error the wait itself reports.
async function nudgeBootstrapIndexer(indexed, node) {
    if (!indexerPoolClosed()) await seedBootstrapPrices(true).catch(() => {});
    if (indexed >= node - BOOTSTRAP_MAX_INDEXER_LAG) await mineBootstrapBlocks(1);
}

async function waitForBootstrapIndexer(timeoutMs) {
    const deadline = Date.now() + Number(timeoutMs || BOOTSTRAP_SYNC_TIMEOUT_MS);
    let indexed = null;
    let node = null;
    let movedAt = Date.now();
    while (Date.now() < deadline) {
        const tip = await indexerConnector.call('getblockhashes', {});
        const reading = Number(tip && tip.block_index);
        if (reading !== indexed) movedAt = Date.now();
        indexed = reading;
        node = Number(await nodeConnector.getBlockCount());
        if (Number.isFinite(indexed) && Number.isFinite(node) && indexed >= node - 1) return;
        if (Date.now() - movedAt >= BOOTSTRAP_NUDGE_MS) {
            await nudgeBootstrapIndexer(indexed, node);
            movedAt = Date.now();
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error('policy rail bootstrap indexer stayed behind the node: ' + indexed + '/' + node);
}

function readBootstrapDonorFile(name) {
    const file = path.join(fixture.DRILL_KEYS_DIR, name);
    try {
        const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(rows) ? rows : [];
    } catch (e) {
        if (e && e.code === 'ENOENT') return [];
        throw e;
    }
}

function recordedBootstrapEntries() {
    const rows = readBootstrapDonorFile('bridge-rail-policy-donors.json')
        .concat(readBootstrapDonorFile('bridge-rail-policy.json'));
    const seen = new Set();
    return rows.filter((entry) => {
        if (!entry || !entry.address || !entry.mnemonic || seen.has(entry.address)) return false;
        seen.add(entry.address);
        return true;
    });
}

async function loadBootstrapDonorLedger() {
    const rows = [];
    for (const entry of recordedBootstrapEntries()) {
        if (bootstrapStakerAddresses.has(entry.address)) continue;
        const balance = BigInt(await indexerDatabase.getBalance({ address: entry.address, tick: 'XCHAIN' }) || '0');
        if (balance > 10n) rows.push({ entry, available: balance - 10n });
    }
    // Draw the largest donors first so each staker needs the fewest SEND rounds.
    return rows.sort((x, y) => (x.available === y.available ? 0 : (x.available > y.available ? -1 : 1)));
}

async function sendDonorGas(row, destination, left) {
    const { entry } = row;
    const amount = row.available < left ? row.available : left;
    const started = Date.now();
    const donor = await cryptoHelper.getNewFundedAddress('policy-rail-donor-' + entry.address,
        COIN, NETWORK, entry.mnemonic, 'legacy', 0, 0.01, false);
    await paceBootstrapDoge(1);
    if (donor.address !== entry.address) {
        row.available = 0n;
        return 0n;
    }
    const result = await mineBootstrapWork(() =>
        sendHelper.sendSendV0(donor, 'XCHAIN', String(amount), destination.address, ''));
    if (!result.send || result.send.status !== 'valid') {
        row.available = 0n;
        return 0n;
    }
    row.available -= amount;
    console.log('POLICY RAIL: donor SEND moved ' + amount + ' XCHAIN to a bootstrap staker in ' +
        Math.round((Date.now() - started) / 1000) + 's');
    return amount;
}

async function drawBootstrapDonors(address, amount) {
    if (!bootstrapDonorLedger) bootstrapDonorLedger = await loadBootstrapDonorLedger();
    let left = BigInt(String(amount));
    for (const row of bootstrapDonorLedger) {
        if (left <= 0n) break;
        if (row.available > 0n) left -= await sendDonorGas(row, address, left);
    }
    return left;
}

function seedBootstrapPrices(force) {
    // Serialize shared price refreshes while independent transactions run in parallel.
    const seed = bootstrapPriceSeed.then(() => nativeFeeHelper.seedGlobalPrices(force));
    bootstrapPriceSeed = seed.catch(() => {});
    return seed;
}

async function mintBootstrapGas(address, amount) {
    const donor = bootstrapDonorSend.then(() => drawBootstrapDonors(address, amount));
    bootstrapDonorSend = donor.catch(() => {});
    let left = await donor;
    const limit = BigInt(gasHelper.GAS_MAX_MINT);
    while (left > 0n) {
        // Chunked so one faucet holder can cover each grant; fundGas sends from the faucet
        // first and mints only while MAX_SUPPLY has room.
        const chunk = left < limit ? left : limit;
        await seedBootstrapPrices(false);
        await mineBootstrapWork(() => gasHelper.fundGas(address, String(chunk)));
        left -= chunk;
    }
}

// Refuse before any stake is funded when donors, faucet and MINT headroom cannot cover them.
async function requireBootstrapGas(need) {
    const donors = (await loadBootstrapDonorLedger()).map((row) => row.available);
    const budget = await checkBootstrapGas({ db: indexerDatabase, need, donors });
    if (!budget.ok) throw new Error(budget.reason);
    console.log('POLICY RAIL: gas budget ' + budget.summary);
}

async function prepareBootstrapStaker(identity, index, stake) {
    const label = 'policy-rail-quorum-' + index;
    const mintCount = Math.ceil((stake + 1000) / gasHelper.GAS_MAX_MINT);
    const nativeCoins = Number((0.02 + mintCount * 0.001).toFixed(8));
    // Cover every mint's native fee output plus its transaction fee before the stake is sent.
    const address = await fixture.withWedgeClear('funding ' + label, () =>
        cryptoHelper.getNewFundedAddress(label, COIN, NETWORK, null, 'legacy', 0, nativeCoins, false));
    await fixture.withWedgeClear('gas seed for ' + label, () => mineBootstrapWork(() =>
        gasHelper.ensureGasBalance(address, 100)));
    await paceBootstrapDoge(1);
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
    bootstrapStakerAddresses.add(address.address);
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
        await waitForBootstrapIndexer(BOOTSTRAP_SYNC_TIMEOUT_MS);
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

function seatedRecordedEntries(set) {
    const seated = new Set(set.pubkeys);
    return recordedBootstrapEntries().filter((entry) =>
        entry.signingPubkey && seated.has(String(entry.signingPubkey).toLowerCase()));
}

async function restoreRecordedStaker(entry) {
    const restored = await cryptoHelper.getNewFundedAddress('policy-rail-release-' + entry.address,
        COIN, NETWORK, entry.mnemonic, 'legacy', 0, 0.01, false);
    if (restored.address !== entry.address) {
        throw new Error('policy rail could not restore a recorded bootstrap staker');
    }
    return restored;
}

function seedRecordedSigners() {
    for (const entry of recordedBootstrapEntries()) {
        if (!entry.signingSeed || !entry.signingPubkey) continue;
        const pubkey = String(entry.signingPubkey).toLowerCase();
        // Trust a recorded seed only when it still derives the pubkey it was filed under.
        if (fixture['_pubkeyForSeed'](entry.signingSeed) !== pubkey) continue;
        bootstrapSeeds.set(pubkey, { seedHex: entry.signingSeed, origin: 'policy rail recorded signer' });
    }
}

function baselineWithout(set, entries) {
    const drop = new Set(entries.map((entry) => String(entry.signingPubkey).toLowerCase()));
    const pubkeys = set.pubkeys.filter((pubkey) => !drop.has(pubkey));
    const byPubkey = new Map(pubkeys.map((pubkey) => [pubkey, set.byPubkey.get(pubkey)]));
    return Object.assign({}, set, { pubkeys, byPubkey });
}

function registerRecordedSigners(entries) {
    for (const entry of entries) {
        stakeTeardown.registerStake({
            signingPubkey: entry.signingPubkey,
            amount: '0',
            addressInfo: { address: entry.address, recordedEntry: entry },
        });
    }
}

async function reuseRecordedSigners() {
    const opening = await readBridgeCapability();
    const recorded = seatedRecordedEntries(opening.set);
    if (!recorded.length) return false;
    if (!resolveVenueQuorum(seatedRows(opening.set), fixture['_knownSignerSeeds']()).ok) return false;
    // Teardown owns the release, so the roster it restores excludes the reused signers.
    installBootstrapTeardown({ set: baselineWithout(opening.set, recorded) });
    registerRecordedSigners(recorded);
    console.log('POLICY RAIL: reusing ' + recorded.length + ' recorded signer(s) already seated');
    return true;
}

async function unstakeRecordedEntry(entry) {
    const restored = await restoreRecordedStaker(entry);
    await paceBootstrapDoge(1);
    await fixture.clearWedgeBefore('recorded policy bootstrap unstake');
    await mineBootstrapWork(() => stakeHelper.sendUnstakeV0(restored, entry.signingPubkey));
}

async function releaseRecordedBootstrapStakes() {
    const opening = await readBridgeCapability();
    const entries = seatedRecordedEntries(opening.set);
    if (!entries.length) return;
    for (const entry of entries) await unstakeRecordedEntry(entry);
    await mineBootstrapSettlement(stakeTeardown.RELEASE_SETTLE_BLOCKS);
    const closing = await readBridgeCapability();
    const left = entries.filter((entry) => closing.set.pubkeys.includes(String(entry.signingPubkey).toLowerCase()));
    if (left.length) throw new Error('policy rail recorded bootstrap stakers remained seated after release');
    console.log('POLICY RAIL: released ' + entries.length + ' recorded bootstrap signer(s)');
}

function installBootstrapTeardown(opening) {
    const teardownPolicy = stakeTeardown.policy(process.env);
    global.stakeTeardownPolicy = Object.assign({}, teardownPolicy, {
        capability: 'cross_chain',
        settleBlocks: Math.max(Number(teardownPolicy.settleBlocks || 0), 20),
        budgetMs: Math.max(Number(teardownPolicy.budgetMs || 0), BOOTSTRAP_RELEASE_BUDGET_MS),
        strict: false,
    });
    global.stakeTeardownBaseline = opening.set;
    bootstrapTeardownInstalled = true;
}

async function stakeBootstrapBatch(batch, start, stake, addresses) {
    const results = await Promise.allSettled(batch.map((identity, offset) => {
        const index = start + offset;
        return stakeBootstrapIdentity(identity, index, stake, addresses[index]);
    }));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
}

async function ensurePolicyQuorum() {
    bootstrapBtcMiner = regtestMinerConnector;
    await waitForBootstrapIndexer(BOOTSTRAP_SYNC_TIMEOUT_MS);
    seedRecordedSigners();
    if (await reuseRecordedSigners()) return;
    await releaseRecordedBootstrapStakes();
    await mineBootstrapBlocks(fixture.stakeVisibilityBlocks(COIN, NETWORK));
    await fixture.settleStack();
    await waitForBootstrapIndexer(BOOTSTRAP_SYNC_TIMEOUT_MS);
    if (await reuseRecordedSigners()) return;
    const opening = await readBridgeCapability();
    const rows = seatedRows(opening.set);
    const existing = resolveVenueQuorum(rows, fixture['_knownSignerSeeds']());
    // Preserve an already-signable venue without adding redundant fixture stakes.
    if (existing.ok) return;
    // Make the root stake teardown restore and prove the capability this bootstrap changes.
    const recorded = seatedRecordedEntries(opening.set);
    installBootstrapTeardown({ set: baselineWithout(opening.set, recorded) });
    registerRecordedSigners(recorded);
    const totalStake = rows.reduce((sum, row) => sum + row.stake, 0);
    const identities = createBootstrapIdentities(rows);
    const stake = Math.max(BOOTSTRAP_MIN_STAKE,
        Math.floor((2 * totalStake) / identities.length) + BOOTSTRAP_MIN_STAKE);
    await requireBootstrapGas(identities.length * (stake + 1000));
    const addresses = [];
    for (let i = 0; i < identities.length; i++) {
        addresses.push(await prepareBootstrapStaker(identities[i], i, stake));
    }
    for (let start = 0; start < identities.length; start += BOOTSTRAP_CONCURRENCY) {
        const batch = identities.slice(start, start + BOOTSTRAP_CONCURRENCY);
        await stakeBootstrapBatch(batch, start, stake, addresses);
    }
    const closing = await waitForBootstrapVisibility(identities, stake);
    const quorum = resolveVenueQuorum(seatedRows(closing.set), fixture['_knownSignerSeeds']());
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

async function prepareBootstrapUnstake(entry) {
    const recorded = entry.addressInfo.recordedEntry;
    if (!recorded) return entry.addressInfo;
    const restored = await restoreRecordedStaker(recorded);
    await paceBootstrapDoge(1);
    return restored;
}

async function startBootstrapReleaseBatch() {
    const entries = stakeTeardown.outstanding();
    const addresses = await Promise.all(entries.map(prepareBootstrapUnstake));
    await fixture.clearWedgeBefore('policy bootstrap unstake batch');
    const settled = await settleReleaseBatch({
        entries,
        node: nodeConnector,
        send: (entry, index) => stakeHelper.sendUnstakeV0(addresses[index], entry.signingPubkey),
        mine: mineBootstrapBlocks,
    });
    return new Map(entries.map((entry, index) => [entry.key, settled[index]]));
}

async function releaseBootstrapEntry(entry) {
    if (!bootstrapReleaseBatch) bootstrapReleaseBatch = startBootstrapReleaseBatch();
    const result = (await bootstrapReleaseBatch).get(entry.key);
    if (!result) throw new Error('policy rail bootstrap release did not include its signer');
    if (result.status === 'rejected') throw result.reason;
}

async function releaseBootstrapStakes() {
    if (!bootstrapTeardownInstalled || !global.stakeTeardownBaseline) return;
    await withPolicyMiningPaused(async () => {
        const policy = Object.assign({}, global.stakeTeardownPolicy, { check: false, strict: false });
        await waitForBootstrapIndexer(BOOTSTRAP_SYNC_TIMEOUT_MS);
        const deadline = Date.now() + policy.budgetMs;
        await stakeTeardown.runTeardown({
            policy,
            baseline: global.stakeTeardownBaseline,
            indexer: global.indexerConnector,
            unstake: releaseBootstrapEntry,
            mine: mineBootstrapSettlement,
            requireSync: async () => { await global.utxoTrackerConnector.requireSync(); },
        });
        const current = await waitForCapabilityBaseline({
            baseline: global.stakeTeardownBaseline,
            timeoutMs: Math.max(0, deadline - Date.now()),
            read: async () => (await readBridgeCapability()).set,
            advance: async (leftMs) => {
                await mineBootstrapBlocks(1);
                await waitForBootstrapIndexer(Math.min(leftMs, BOOTSTRAP_SYNC_TIMEOUT_MS));
            },
        });
        console.log('[stake teardown] cross_chain: ' + global.stakeTeardownBaseline.pubkeys.length +
            ' -> ' + current.pubkeys.length + ' member(s)');
    });
}

async function preparePolicyDogeRail(state) {
    // Wait for the suite bring-up and configure the rail only once.
    if (dogeRailPrepared || !state.dogeRail || !state.venue) return;
    let destination = null;
    await state.venue.waitUntil('the policy DOGE fee schedule to name its destination', async () => {
        try {
            const fees = await state.venue.indexerRpc('DOGE', 'feeschedule', {});
            destination = resolveDogeFeeDestination(fees);
        } catch (e) { destination = null; }
        return !!destination;
    }, { timeoutMs: 2 * 60 * 1000, everyMs: 2000 });
    // Resolve the destination from this venue's indexed schedule before any DOGE send.
    state.dogeRail.env.FEE_DESTINATION = destination;
    dogeRailPrepared = true;
}

async function withPolicyMiningPaused(work) {
    const key = 'BRIDGE_RAIL_DOGE_MINER_PAUSE_FILE';
    const dogePauseFile = process.env[key];
    const alreadyPaused = Boolean(dogePauseFile && fs.existsSync(dogePauseFile));
    indexerDatabase.WAIT_MAX_EXTENSIONS = Math.max(
        Number(indexerDatabase.WAIT_MAX_EXTENSIONS || 0), BOOTSTRAP_WAIT_EXTENSIONS);
    if (!alreadyPaused) delete process.env[key];
    try {
        return await withMiningPaused(regtestMinerConnector, work,
            { pauseFile: process.env.BRIDGE_RAIL_MINER_PAUSE_FILE || '' });
    } finally {
        if (dogePauseFile === undefined) delete process.env[key];
        else process.env[key] = dogePauseFile;
    }
}

// The highest block one venue indexer has committed, read from its own ledger database.
async function venueIndexerTip(conn, ix) {
    assert.ok(/^[A-Za-z0-9_]+$/.test(String(ix.indexerDbName)), 'unsafe database name ' + ix.indexerDbName);
    const rows = await conn.query('SELECT MAX(block_index) AS hi FROM `' + ix.indexerDbName + '`.blocks');
    return rows.length && rows[0].hi !== null ? Number(rows[0].hi) : null;
}

async function mirrorHolds(conn, ix, snapshotId) {
    assert.ok(/^[A-Za-z0-9_]+$/.test(String(ix.mirrorDbName)), 'unsafe database name ' + ix.mirrorDbName);
    const rows = await conn.query('SELECT 1 FROM `' + ix.mirrorDbName + '`.policy_snapshots WHERE snapshot_id = ? LIMIT 1',
        [snapshotId]);
    return rows.length > 0;
}

/**
 * Put one policy_snapshots row on every venue hub and into every venue follower's mirror,
 * BTC included, with BTC held still from before the write until every mirror holds it.
 *
 * WHY EVERY FOLLOWER AND NOT ONLY DOGE. The BTC venue indexers follow the same hubs as the
 * DOGE one (BTC indexer i follows hub i, the DOGE indexer follows hub 0), and a BTC indexer
 * screens a mirrored policy row too: an origin-chain row is refused terminally and that
 * refusal is anchored to a minted XPOLICY action. A row only hub 0 held reached BTC indexer
 * 0 at its next reconnect and not its three peers, so it alone minted that action, its
 * actions and ledger hashes split from theirs, and hub 0 stopped signing checkpoints and
 * bridge rounds (measured on the xce3 stack 2026-10-11: AT4 seq gap setup and AT5 never
 * finalized a lock). Writing to every hub is not enough on its own either: a BTC indexer
 * parses its next block on its own clock, so one that parses before its reconnect delivers
 * the row refuses it a block later than its peers. So BTC stops first, every BTC venue
 * indexer reaches the same tip, the row goes to every hub and every follower re-pages, and
 * BTC moves again only once every mirror holds it: all four then screen it in one block.
 *
 * A row the mirror fences at ingest (foreign network or btc_chain_id) never reaches a
 * mirror and mints nothing anywhere; pass `{fenced: true}` and only the write and the
 * re-page are done.
 *
 * @param {object} row  a signed policy_snapshots row (HUB.signRecord output)
 * @param {{fenced?: boolean, timeoutMs?: number}} [opts]
 * @returns {Promise<{tip: number, written: Array}>}
 */
async function injectPolicyRowEverywhere(row, opts) {
    const o = opts || {};
    const venue = drive.state.venue;
    assert.ok(venue && venue.btcVenue && venue.dogeVenue && venue.hubDb, 'the policy venue is not started');
    const btc = venue.btcVenue.indexers;
    const followers = btc.concat(venue.dogeVenue.indexers);
    const db = venue.hubDb;
    const deadlineFor = () => Date.now() + Number(o.timeoutMs || 5 * 60 * 1000);
    const conn = await mariadb.createConnection({ host: db.host, port: parseInt(db.port, 10),
        user: db.user, password: db.pass, connectTimeout: 10000 });
    try {
        return await withPolicyMiningPaused(async () => {
            let tip = null;
            let deadline = deadlineFor();
            for (;;) {
                const tips = [];
                for (const ix of btc) tips.push(await venueIndexerTip(conn, ix));
                if (tips.every((t) => t !== null && t === tips[0])) {
                    // Equal twice across a pause: nothing was in flight between the reads.
                    await new Promise((r) => setTimeout(r, 3000));
                    const again = [];
                    for (const ix of btc) again.push(await venueIndexerTip(conn, ix));
                    if (again.every((t) => t === tips[0])) { tip = tips[0]; break; }
                }
                assert.ok(Date.now() < deadline, 'the BTC venue indexers never met at one tip with BTC paused: ' +
                    JSON.stringify(tips));
                await new Promise((r) => setTimeout(r, 2000));
            }
            const written = await venue.dogeVenue.injectMirrorRow(row, { table: 'policy_snapshots',
                key: ['snapshot_id'], hubs: venue.hubs.map((h) => h.index) });
            for (const ix of btc) if (ix.mirrorProxy) ix.mirrorProxy.dropSockets();
            if (o.fenced) return { tip, written };
            deadline = deadlineFor();
            for (;;) {
                const missing = [];
                for (const ix of followers) {
                    if (!await mirrorHolds(conn, ix, row.snapshot_id)) missing.push(ix.mirrorDbName);
                }
                if (!missing.length) break;
                assert.ok(Date.now() < deadline, 'policy row ' + String(row.snapshot_id).slice(0, 16) +
                    ' never reached these venue mirrors: ' + missing.join(', '));
                await new Promise((r) => setTimeout(r, 2000));
            }
            return { tip, written };
        });
    } finally {
        await conn.end().catch(() => {});
    }
}

async function waitForStandingHub() {
    const deadline = Date.now() + BOOTSTRAP_SYNC_TIMEOUT_MS;
    const connector = installStandingHubConnector();
    let last = null;
    while (Date.now() < deadline) {
        try {
            await requireHealthyHub(async () => {
                const response = await axios.post(connector.urls[0],
                    { jsonrpc: '2.0', method: 'ping', id: 1 }, {
                        timeout: 5000,
                        validateStatus: () => true,
                        transformResponse: [(body) => body],
                    });
                return { statusCode: response.status, bodyText: response.data };
            }, { attempts: 1, waitMs: 0 });
            return;
        } catch (e) { last = e && e.message; }
        await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    throw new Error('policy rail standing hub stayed unhealthy: ' + JSON.stringify(last).slice(0, 240));
}

async function bringUpPolicyQuorum() {
    await withPolicyMiningPaused(ensurePolicyQuorum);
    await waitForStandingHub();
}

before(async function () {
    this.timeout(0);
    await resetAppliedPolicyLedger();
    await bringUpPolicyQuorum();
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

module.exports = Object.assign({ POLICY_DRIVE, injectPolicyRowEverywhere }, drive, policy.bind(drive.state, drive));
