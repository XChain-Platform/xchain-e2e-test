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
const path = require('path');

const chainRail = require('../../../helpers/chainRail');
const cryptoHelper = require('../../../cryptoHelper');
const gasHelper = require('../../../helpers/gasHelper');
const nativeFeeHelper = require('../../../helpers/nativeFeeHelper');
const sendHelper = require('../../../helpers/sendHelper');
const stakeHelper = require('../../../helpers/stakeHelper');
const stakeTeardown = require('../../../helpers/stakeTeardown');
const fixture = require('../../../attestMirror/mirrorDrillFixture');
const { restoreRecordedStaker } = require('../../../attestMirror/restoreRecordedStaker');
const { resolveVenueQuorum } = require('../../../helpers/bridgeRailVenue');
const { planBootstrapFunding, recordedSignerSeeds } = require('./quorum_funding');

const BOOTSTRAP_MIN_STAKE = 5000;
const BOOTSTRAP_MAX_LEADER_GAP = 3;
const BOOTSTRAP_CONCURRENCY = 3;
const BOOTSTRAP_MINE_POLL_MS = 2000;
const bootstrapSeeds = new Map();
const inheritedKnownSignerSeeds = fixture._knownSignerSeeds;
let bootstrapPriceSeed = Promise.resolve();
let bootstrapStakeSend = Promise.resolve();
let bootstrapDogeRail = null;
let bootstrapBlocksSinceDoge = 0;
let bootstrapBtcMiner = null;
let bootstrapLabel = null;

let recordedSeeds = null;

fixture._knownSignerSeeds = function bridgeRailKnownSignerSeeds() {
    const known = inheritedKnownSignerSeeds();
    if (!recordedSeeds) recordedSeeds = readRecordedSignerSeeds();
    for (const [pubkey, hit] of recordedSeeds) if (!known.has(pubkey)) known.set(pubkey, hit);
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
    if (!set || set.error) {
        throw new Error(bootstrapLabel + ' could not read the cross_chain capability set at buried block ' +
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
        bootstrapSeeds.set(pubkeyHex, { seedHex, origin: bootstrapLabel + ' fixture signer ' + index });
        return { seedHex, pubkeyHex };
    }
    throw new Error(bootstrapLabel + ' could not place fixture signer ' + index + ' inside its leader gap');
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

function dogeMiningPaused() {
    const file = process.env.BRIDGE_RAIL_DOGE_MINER_PAUSE_FILE;
    return Boolean(file && fs.existsSync(file));
}

async function mineBootstrapDoge() {
    if (dogeMiningPaused()) return;
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
    throw new Error(bootstrapLabel + ' indexer stayed behind the node: ' + indexed + '/' + node);
}

async function mintBootstrapGas(address, amount) {
    let left = BigInt(String(amount));
    const limit = BigInt(gasHelper.GAS_MAX_MINT);
    while (left > 0n) {
        const chunk = left < limit ? left : limit;
        const seed = bootstrapPriceSeed.then(() => nativeFeeHelper.seedGlobalPrices(false));
        bootstrapPriceSeed = seed.catch(() => {});
        await seed;
        await mineBootstrapWork(() => gasHelper.mintGas(address, String(chunk)));
        left -= chunk;
    }
}

// The rail is shared by every checkout of the repository, so XCHAIN that an earlier run
// left on its bootstrap addresses sits in the drill-keys of whichever checkout ran it:
// this one, the main one, or a sibling lane checkout.
function bootstrapKeyDirs() {
    const repoRoot = path.resolve(fixture.DRILL_KEYS_DIR, '..');
    const container = path.dirname(repoRoot);
    const lanesDir = path.basename(path.dirname(container)) === 'lanes'
        ? path.dirname(container)
        : path.join(container, 'tmp', 'lanes');
    const dirs = [fixture.DRILL_KEYS_DIR];
    const main = path.join(container, path.basename(repoRoot), 'drill-keys');
    if (!dirs.includes(main)) dirs.push(main);
    if (!fs.existsSync(lanesDir)) return dirs;
    for (const lane of fs.readdirSync(lanesDir).sort()) {
        const dir = path.join(lanesDir, lane, path.basename(repoRoot), 'drill-keys');
        if (!dirs.includes(dir)) dirs.push(dir);
    }
    return dirs;
}

function readRecordedBootstrapEntries() {
    const recorded = [];
    for (const dir of bootstrapKeyDirs()) {
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir)
            .filter((name) => /^bridge-rail-(?:token|policy)\.json$/.test(name)).sort();
        for (const name of files) {
            let entries;
            try { entries = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch (e) { continue; }
            if (Array.isArray(entries)) recorded.push(...entries);
        }
    }
    return recorded;
}

function readRecordedSignerSeeds() {
    return recordedSignerSeeds(readRecordedBootstrapEntries(), (seedHex) => fixture._pubkeyForSeed(seedHex));
}

function readBootstrapDonors(currentAddresses) {
    const byAddress = new Map();
    for (const entry of readRecordedBootstrapEntries()) {
        const address = entry && String(entry.address || '');
        if (!address || currentAddresses.has(address) || !entry.mnemonic || !entry.staker) continue;
        byAddress.set(address, entry);
    }
    return [...byAddress.values()];
}

async function readBootstrapFunding(entries) {
    const conn = await indexerDatabase.getConnection();
    try {
        const tokens = await conn.query(`SELECT tk.supply, tk.max_supply
            FROM tokens tk INNER JOIN index_tickers ti ON ti.id=tk.tick_id
            WHERE ti.tick='XCHAIN' LIMIT 1`);
        if (!tokens.length) throw new Error('bridge rail bootstrap could not read the XCHAIN supply');
        const balances = new Map();
        if (entries.length) {
            const addresses = entries.map((entry) => String(entry.address));
            const placeholders = addresses.map(() => '?').join(',');
            const rows = await conn.query(`SELECT ia.address, b.amount FROM balances b
                INNER JOIN index_addresses ia ON ia.id=b.address_id
                INNER JOIN index_tickers ti ON ti.id=b.tick_id
                WHERE ti.tick='XCHAIN' AND ia.address IN (` + placeholders + ')', addresses);
            for (const row of rows) balances.set(String(row.address), String(row.amount));
        }
        return {
            token: { supply: String(tokens[0].supply), maxSupply: String(tokens[0].max_supply) },
            donors: entries.map((entry) => ({
                address: String(entry.address),
                balance: balances.get(String(entry.address)) || '0',
            })),
        };
    } finally {
        await conn.release();
    }
}

async function fundBootstrapStakers(addresses, required) {
    const currentAddresses = new Set(addresses.map((address) => String(address.address)));
    const entries = readBootstrapDonors(currentAddresses);
    const reading = await readBootstrapFunding(entries);
    const entryByAddress = new Map(entries.map((entry) => [String(entry.address), entry]));
    const restore = async (entry) => {
        try {
            return await restoreRecordedStaker(entry, {
                cryptoHelper,
                wallets: global.wallets,
                coin: COIN,
                network: NETWORK,
            });
        } catch (e) {
            return { refused: 'restore failed: ' + e.message };
        }
    };
    const requests = addresses.map((address) => ({ address: address.address, amount: required }));
    let donors = reading.donors;
    let plan = planBootstrapFunding(requests, donors, reading.token);
    const usable = new Set();
    for (;;) {
        const refused = [];
        for (const address of new Set(plan.transfers.map((transfer) => transfer.donorAddress))) {
            if (usable.has(address)) continue;
            const restored = await restore(entryByAddress.get(address));
            if (restored.refused) {
                console.log(bootstrapLabel.toUpperCase() + ': skipping donor ' + address + ': ' + restored.refused);
                refused.push(address);
            } else {
                usable.add(address);
            }
        }
        if (!refused.length) break;
        donors = donors.filter((donor) => !refused.includes(donor.address));
        plan = planBootstrapFunding(requests, donors, reading.token);
    }

    for (const transfer of plan.transfers) {
        const entry = entryByAddress.get(transfer.donorAddress);
        const restored = await restore(entry);
        if (restored.refused) {
            throw new Error(bootstrapLabel + ' donor restore refused for ' + transfer.donorAddress +
                ': ' + restored.refused);
        }
        await fixture.withWedgeClear('donor funding for ' + bootstrapLabel, () => mineBootstrapWork(() =>
            sendHelper.sendSendV0(restored.restored, 'XCHAIN', transfer.amount, transfer.destination, '')));
    }

    const mintByAddress = new Map(plan.mints.map((mint) => [mint.address, mint.amount]));
    console.log(bootstrapLabel.toUpperCase() + ': reused ' + plan.transfers.length +
        ' donor transfer(s); mint shortfall ' + plan.mintTotal + ' of ' + plan.headroom + ' headroom');
    return mintByAddress;
}

async function prepareBootstrapStaker(identity, index, stake) {
    const label = bootstrapLabel + '-quorum-' + index;
    const mintCount = Math.ceil((stake + 1000) / gasHelper.GAS_MAX_MINT);
    const nativeCoins = Number((0.02 + mintCount * 0.001).toFixed(8));
    const address = await fixture.withWedgeClear('funding ' + label, () => mineBootstrapWork(() =>
        cryptoHelper.getNewFundedAddress(label, COIN, NETWORK, null, 'legacy', 0, nativeCoins)));
    await mineBootstrapBlocks(2);
    await fixture.settleStack();
    const wallet = await cryptoHelper.getWallet(label);
    fixture.recordStakerKey(bootstrapLabel, {
        staker: label,
        address: address.address,
        signingPubkey: identity.pubkeyHex,
        signingSeed: identity.seedHex,
        mnemonic: wallet && wallet.mnemonic,
        stakedAt: new Date().toISOString(),
    });
    return address;
}

async function stakeBootstrapIdentity(identity, index, stake, address, mintAmount) {
    if (BigInt(String(mintAmount || 0)) > 0n) {
        await fixture.withWedgeClear('gas mint for ' + bootstrapLabel + '-quorum-' + index, () =>
            mintBootstrapGas(address, String(mintAmount)));
    }
    const send = bootstrapStakeSend.then(async () => {
        await fixture.clearWedgeBefore('stake for ' + bootstrapLabel + '-quorum-' + index);
        return mineBootstrapWork(() =>
            stakeHelper.sendStakeV1(address, String(stake), identity.pubkeyHex));
    });
    bootstrapStakeSend = send.catch(() => {});
    const result = await send;
    if (!result.stake || result.stake.status !== 'valid') {
        throw new Error(bootstrapLabel + ' bootstrap stake ' + index + ' was not valid');
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
        if (wanted.every((pubkey) => Number((reading.set.byPubkey.get(pubkey) || {}).weight) >= stake)) {
            return reading;
        }
    }
    const missing = wanted.filter((pubkey) =>
        !(Number((reading && reading.set.byPubkey.get(pubkey) || {}).weight) >= stake));
    throw new Error(bootstrapLabel + ' bootstrap signers did not reach full weight: ' +
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

async function ensureBridgeRailQuorum(stakerLabel) {
    bootstrapLabel = stakerLabel;
    bootstrapBtcMiner = regtestMinerConnector;
    await mineBootstrapBlocks(fixture.stakeVisibilityBlocks(COIN, NETWORK));
    await fixture.settleStack();
    await waitForBootstrapIndexer(120000);
    const opening = await readBridgeCapability();
    const rows = seatedRows(opening.set);
    const existing = resolveVenueQuorum(rows, fixture._knownSignerSeeds());
    if (existing.ok) return;
    installBootstrapTeardown(opening);
    const totalStake = rows.reduce((sum, row) => sum + row.stake, 0);
    const identities = createBootstrapIdentities(rows);
    const stake = Math.max(BOOTSTRAP_MIN_STAKE,
        Math.floor((2 * totalStake) / identities.length) + BOOTSTRAP_MIN_STAKE);
    const addresses = [];
    for (let i = 0; i < identities.length; i++) {
        addresses.push(await prepareBootstrapStaker(identities[i], i, stake));
    }
    const mintByAddress = await fundBootstrapStakers(addresses, String(stake + 1000));
    for (let start = 0; start < identities.length; start += BOOTSTRAP_CONCURRENCY) {
        const batch = identities.slice(start, start + BOOTSTRAP_CONCURRENCY);
        await Promise.all(batch.map((identity, offset) => {
            const index = start + offset;
            return stakeBootstrapIdentity(identity, index, stake, addresses[index],
                mintByAddress.get(String(addresses[index].address)) || '0');
        }));
    }
    const closing = await waitForBootstrapVisibility(identities, stake);
    const quorum = resolveVenueQuorum(seatedRows(closing.set), fixture._knownSignerSeeds());
    if (!quorum.ok) throw new Error(bootstrapLabel + ' bootstrap did not produce a quorum: ' + quorum.reason);
    console.log(bootstrapLabel.toUpperCase() + ': bootstrapped ' + identities.length +
        ' temporary signer(s) at buried block ' + closing.buriedBlock);
}

async function releaseBridgeRailQuorum() {
    if (!global.stakeTeardownBaseline) return;
    if (bootstrapBtcMiner) global.regtestMinerConnector = bootstrapBtcMiner;
    await waitForBootstrapIndexer(120000);
    await stakeTeardown.runTeardown({
        policy: Object.assign({}, global.stakeTeardownPolicy, { capability: 'cross_chain', strict: true }),
        baseline: global.stakeTeardownBaseline,
        indexer: global.indexerConnector,
        unstake: async (entry) => {
            await stakeHelper.sendUnstakeV0(entry.addressInfo, entry.signingPubkey);
        },
        mine: mineBootstrapSettlement,
        requireSync: async () => { await global.utxoTrackerConnector.requireSync(); },
    });
}

module.exports = { ensureBridgeRailQuorum, releaseBridgeRailQuorum };
