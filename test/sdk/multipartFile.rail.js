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
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
    makeSdk, submit, fundedSdkAddress, fundedGasAddress, uniqueTick, submitOpts,
} = require('./helpers/sdkHelper');
const chainRail = require('../helpers/chainRail');
const { orphanWithEmptyBlocks } = require('../helpers/bridge_rail_venue/reorg_controls');

const REPORT_FILE = path.resolve(process.cwd(), '../tmp/logs/rail-drives/multipart-file-drive.md');
const CARRIER = 'TAPROOT';
const PUBLIC_BYTES = 10_000_000;
const FOUR_PART_BYTES = 1_200_000;
const THREE_PART_BYTES = 900_000;
const MAX_COMPLETION_BLOCKS = 10;
const POLL_MS = 1000;
// A reorg case needs about 3 minutes on the rail: the decoder holds 90 s before it
// rolls back and the indexer rollback takes as long again.
const POLL_ATTEMPTS = 300;
const INDEXER_TIP_WAIT_MS = 360000;

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function actionIndexOf(indexed) {
    if (!indexed) return null;
    if (indexed.action_index !== undefined && indexed.action_index !== null)
        return Number(indexed.action_index);
    if (Array.isArray(indexed.actions) && indexed.actions.length)
        return Number(indexed.actions[0].action_index);
    return null;
}

function manifestActionIndex(result) {
    const candidates = [
        result && result.manifestActionIndex,
        result && result.manifest_action_index,
        result && result.actionIndex,
        result && result.action_index,
        actionIndexOf(result && result.indexed),
        actionIndexOf(result && result.manifest && result.manifest.indexed),
        result && result.manifest && result.manifest.actionIndex,
        result && result.manifest && result.manifest.action_index,
    ];
    const found = candidates.find((value) => value !== undefined && value !== null && Number.isFinite(Number(value)));
    if (found === undefined) throw new Error('multipart publish returned no manifest action index');
    return Number(found);
}

function assemblyBody(value) {
    if (!value) return null;
    if (value.multipart) return value.multipart;
    if (value.data && value.data.multipart) return value.data.multipart;
    if (value.data && !Array.isArray(value.data)) return value.data;
    return value;
}

function assemblyStatus(value) {
    const body = assemblyBody(value);
    return body && String(body.status || body.result || '').toLowerCase();
}

function coinPrefix() {
    return (global.NETWORK === 'regtest' ? 'R' : global.NETWORK === 'testnet' ? 'T' : '') + global.COIN_CODE;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readAssembly(sdk, actionIndex) {
    try {
        return await sdk.getFileAssembly(actionIndex, global.COIN_CODE);
    } catch (error) {
        if (error && error.response && error.response.status === 409)
            return { status: 'pending', httpStatus: 409 };
        throw error;
    }
}

async function waitForAssemblyStatus(sdk, actionIndex, wanted) {
    let last;
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
        last = await readAssembly(sdk, actionIndex);
        if (assemblyStatus(last) === wanted) return last;
        await sleep(POLL_MS);
    }
    throw new Error('file ' + actionIndex + ' did not become ' + wanted + '; last assembly=' + JSON.stringify(last));
}

async function mineUntilComplete(sdk, actionIndex) {
    let last;
    for (let mined = 0; mined <= MAX_COMPLETION_BLOCKS; mined++) {
        last = await readAssembly(sdk, actionIndex);
        if (assemblyStatus(last) === 'complete') return { assembly: last, mined };
        if (mined < MAX_COMPLETION_BLOCKS)
            await global.regtestMinerConnector.generateBlocks(1);
    }
    throw new Error('file ' + actionIndex + ' incomplete after ' + MAX_COMPLETION_BLOCKS +
        ' blocks; last assembly=' + JSON.stringify(last));
}

async function rawFile(actionIndex) {
    return await global.explorerConnector.getFileRaw(coinPrefix(), actionIndex);
}

async function actionDetail(sdk, actionIndex) {
    const response = await sdk.getAction(actionIndex);
    let detail = response && response.data !== undefined ? response.data : response;
    if (Array.isArray(detail)) detail = detail[0];
    if (detail && detail.action && typeof detail.action === 'object') detail = detail.action;
    return detail;
}

function planParts(plan) {
    if (!plan || !Array.isArray(plan.parts)) throw new Error('multipart plan has no parts array');
    return plan.parts;
}

function partBytes(part) {
    const bytes = part && (part.bytes || part.rawData || part.data || part.body);
    if (Buffer.isBuffer(bytes)) return bytes;
    if (bytes instanceof Uint8Array) return Buffer.from(bytes);
    if (typeof bytes === 'string') return Buffer.from(bytes, 'binary');
    throw new Error('multipart plan part has no byte payload');
}

function fileHashOfPlan(plan) {
    const hash = plan && (plan.fileHash || plan.file_hash || plan.FILE_HASH);
    if (!hash) throw new Error('multipart plan has no file hash');
    return hash;
}

function manifestParams(plan, meta) {
    const supplied = plan && (plan.manifestParams || plan.manifest_params ||
        (plan.manifest && (plan.manifest.params || plan.manifest)));
    if (supplied) return supplied;
    return {
        version: 1,
        fileHash: fileHashOfPlan(plan),
        totalParts: planParts(plan).length,
        totalBytes: plan.totalBytes || plan.total_bytes,
        name: meta.name,
        type: meta.type,
        title: meta.title || '',
        memo: meta.memo || '',
        gateTicker: meta.gateTicker || '',
        encryptionMethod: plan.encryptionMethod || plan.encryption_method || '',
        keyHash: plan.keyHash || plan.key_hash || '',
        gateMinAmount: meta.gateMinAmount || '',
        compression: plan.compression || plan.compressionField || '',
    };
}

// A TAPROOT envelope needs the source's public key as its internal key, as
// batchHelper passes it; the funded owner carries it from generateKeyPair.
function compressedPubKeyHex(owner) {
    const key = owner && owner.publicKey;
    return Buffer.isBuffer(key) || key instanceof Uint8Array ? Buffer.from(key).toString('hex') : key;
}

async function sendManifest(sdk, owner, plan, meta) {
    return await submit(sdk,
        { action: 'FILE', params: manifestParams(plan, meta) },
        { pubkey: owner.address, change: owner.address, encoding: CARRIER, compress: false,
          compressedPubKey: compressedPubKeyHex(owner) },
        submitOpts({ wif: owner.wif })
    );
}

async function sendPart(sdk, owner, plan, partIndex) {
    const bytes = partBytes(planParts(plan)[partIndex]);
    return await submit(sdk,
        { action: 'FILE', params: { version: 2, fileHash: fileHashOfPlan(plan), partIndex } },
        {
            pubkey: owner.address,
            change: owner.address,
            encoding: CARRIER,
            compress: false,
            compressedPubKey: compressedPubKeyHex(owner),
            rawData: bytes.toString('binary'),
        },
        submitOpts({ wif: owner.wif })
    );
}

// The wallet quotes a pair from its upload method; the rail suite passes a conservative
// estimate instead, which only over-funds a piece and never under-pays its fee.
const RAIL_PAIR_SIZES = {
    pairSizeFor: piece => (piece.lane === 'envelope'
        ? Math.ceil(piece.payloadBytes / 4) + 400
        : Math.ceil(piece.payloadBytes * 1.1) + 600),
};

// After a rollback the indexer may sit behind its decoder for minutes; a case that
// starts then reads a stale tip, so wait until /status says it is processing at tip.
async function waitForIndexerTip() {
    const url = 'http://' + (process.env.INDEXER_URL || '127.0.0.1') + ':' + (process.env.INDEXER_API_PORT || '3024') + '/status';
    const deadline = Date.now() + INDEXER_TIP_WAIT_MS;
    while (Date.now() < deadline) {
        try {
            const body = await (await fetch(url)).json();
            if (body && body.atProcessableTip === true && Number(body.lag) === 0) return body;
        } catch (error) { /* the indexer restarts during a rollback; keep polling */ }
        await sleep(POLL_MS * 5);
    }
    throw new Error('indexer did not return to tip within ' + INDEXER_TIP_WAIT_MS + ' ms at ' + url);
}

async function publishAndComplete(sdk, owner, bytes, meta, extra = {}) {
    const plan = await sdk.planMultipartFile(bytes, meta, { carrier: CARRIER, ...(extra.plan || {}) });
    const published = await sdk.publishMultipartFile(owner.wif, bytes, meta, {
        carrier: CARRIER,
        sourceAddress: owner.address,
        change: owner.address,
        sizes: RAIL_PAIR_SIZES,
        ...(extra.publish || {}),
    });
    const actionIndex = manifestActionIndex(published);
    const completion = await mineUntilComplete(sdk, actionIndex);
    expect(assemblyStatus(completion.assembly)).to.equal('complete');
    expect(completion.mined).to.be.at.most(MAX_COMPLETION_BLOCKS);
    return { plan, published, actionIndex };
}

describe('[sdk rail] multipart FILE', function () {
    this.timeout(0);

    let completed = 0;
    let bitcoinRail;
    let litecoinRail;

    before(async function () {
        if (global.COIN !== 'bitcoin' || global.NETWORK !== 'regtest')
            throw new Error('multipart FILE rail must start on bitcoin-regtest');
        bitcoinRail = chainRail.captureCurrentRail();
        litecoinRail = await chainRail.createRail('litecoin', 'regtest');
        const failures = await chainRail.railFailures(litecoinRail);
        if (failures.length) throw new Error('litecoin-regtest rail unavailable: ' + failures.join(', '));
    });

    after(function () {
        if (completed !== 5) return;
        fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
        fs.writeFileSync(REPORT_FILE, [
            '# Multipart file rail drive',
            '',
            'multipart file drive: PASS',
            'passing=5',
            'failing=0',
            '',
        ].join('\n'));
    });

    it('publishes 10,000,000 random bitcoin bytes as 26 parts and serves identical bytes', async function () {
        await chainRail.withRail(bitcoinRail, async () => {
            const sdk = makeSdk({ network: 'bitcoin-regtest', compactAddresses: false });
            const owner = await fundedSdkAddress(sdk, 5, 'p2wpkh');
            const source = crypto.randomBytes(PUBLIC_BYTES);
            const meta = { name: 'random-10m.bin', type: 'application/octet-stream', title: '10 MB random' };
            const result = await publishAndComplete(sdk, owner, source, meta);

            expect(planParts(result.plan)).to.have.length(26);
            const served = await rawFile(result.actionIndex);
            expect(served.status).to.equal(200);
            expect(served.body).to.have.length(source.length);
            expect(sha256(served.body)).to.equal(sha256(source));
        });
        completed++;
    });

    it('publishes a three-part envelope file from a P2PKH source with manifest ownership preserved', async function () {
        await chainRail.withRail(bitcoinRail, async () => {
            const sdk = makeSdk({ network: 'bitcoin-regtest', compactAddresses: false });
            const owner = await fundedSdkAddress(sdk, 5, 'p2pkh');
            const source = crypto.randomBytes(THREE_PART_BYTES);
            const meta = { name: 'p2pkh-random.bin', type: 'application/octet-stream' };
            const result = await publishAndComplete(sdk, owner, source, meta);

            expect(planParts(result.plan)).to.have.length(3);
            const served = await rawFile(result.actionIndex);
            expect(served.status).to.equal(200);
            expect(sha256(served.body)).to.equal(sha256(source));

            const manifest = await actionDetail(sdk, result.actionIndex);
            expect(manifest).to.be.an('object');
            expect(manifest.action).to.equal('FILE');
            expect(Number(manifest.action_format)).to.equal(1);
            expect(manifest.source).to.equal(owner.address);
        });
        completed++;
    });

    it('publishes a three-part gated bitcoin file whose ciphertext decrypts to the source', async function () {
        await chainRail.withRail(bitcoinRail, async () => {
            const sdk = makeSdk({ network: 'bitcoin-regtest', compactAddresses: false });
            const owner = await fundedGasAddress(sdk, 5, undefined, 'p2wpkh');
            const gateTicker = uniqueTick('MF');
            const issued = await submit(sdk,
                { action: 'ISSUE', params: {
                    tick: gateTicker, maxSupply: 1000, maxMint: 0, decimals: 0,
                    description: 'multipart file gate', mintSupply: 1000,
                } },
                { pubkey: owner.address, change: owner.address },
                submitOpts({ wif: owner.wif })
            );
            expect(issued.indexed.status).to.equal('valid');

            const source = crypto.randomBytes(THREE_PART_BYTES);
            const key = sdk.gatedFile.generateKey().key;
            const meta = {
                name: 'gated-random.bin', type: 'application/octet-stream',
                gateTicker, gateMinAmount: 1,
            };
            const result = await publishAndComplete(sdk, owner, source, meta, {
                plan: { gate: { key } },
                publish: { gate: { key } },
            });
            expect(planParts(result.plan)).to.have.length(3);

            const ciphertext = await sdk.getGatedFileRaw(result.actionIndex);
            const compression = result.plan.compression || result.plan.compressionField ||
                manifestParams(result.plan, meta).compression || '';
            const plaintext = compression
                ? await sdk.gatedFile.decryptAndInflateFileBytes(ciphertext, key, { compressed: compression })
                : sdk.gatedFile.decryptFileBytes(ciphertext, key);
            expect(sha256(plaintext)).to.equal(sha256(source));
        });
        completed++;
    });

    it('publishes and completes a three-part file on litecoin regtest', async function () {
        await chainRail.withRail(litecoinRail, async () => {
            const sdk = makeSdk({
                network: 'litecoin-regtest',
                encoderPort: litecoinRail.ports.encoder,
                compactAddresses: false,
            });
            const owner = await fundedSdkAddress(sdk, 50, 'p2wpkh');
            const source = crypto.randomBytes(THREE_PART_BYTES);
            const meta = { name: 'litecoin-random.bin', type: 'application/octet-stream' };
            const result = await publishAndComplete(sdk, owner, source, meta);

            expect(planParts(result.plan)).to.have.length(3);
            const served = await rawFile(result.actionIndex);
            expect(served.status).to.equal(200);
            expect(sha256(served.body)).to.equal(sha256(source));
        });
        completed++;
    });

    // Last: each rollback stalls the bitcoin indexer's hub mirror for minutes, which
    // starves a later case's gas mint.
    it('keeps a reverse, duplicate, withheld bitcoin file pending and follows its last part through a reorg', async function () {
        await chainRail.withRail(bitcoinRail, async () => {
            const sdk = makeSdk({ network: 'bitcoin-regtest', compactAddresses: false });
            const owner = await fundedSdkAddress(sdk, 5, 'p2wpkh');
            const source = crypto.randomBytes(FOUR_PART_BYTES);
            const meta = { name: 'reverse-duplicate.bin', type: 'application/octet-stream' };
            const plan = await sdk.planMultipartFile(source, meta, { carrier: CARRIER });
            expect(planParts(plan)).to.have.length(4);

            const manifest = await sendManifest(sdk, owner, plan, meta);
            const actionIndex = actionIndexOf(manifest.indexed);
            expect(actionIndex).to.be.a('number');

            for (const partIndex of [3, 2, 3, 0]) {
                const sent = await sendPart(sdk, owner, plan, partIndex);
                expect(sent.indexed.status).to.equal('valid');
            }

            const pending = await readAssembly(sdk, actionIndex);
            expect(assemblyStatus(pending)).to.equal('pending');
            expect((await rawFile(actionIndex)).status).to.equal(409);

            const lastPart = await sendPart(sdk, owner, plan, 1);
            expect(lastPart.indexed.status).to.equal('valid');
            await mineUntilComplete(sdk, actionIndex);
            expect((await rawFile(actionIndex)).status).to.equal(200);

            const lastPartBlock = Number(lastPart.indexed.block_index);
            expect(lastPartBlock).to.be.a('number').and.greaterThan(0);
            const lastPartHash = await global.nodeConnector.getBlockHash(lastPartBlock);
            await global.regtestMinerConnector.pauseMining();
            try {
                // A lower node tip reads to the decoder as node lag, not a reorg, so the
                // orphaned branch is replaced by a longer chain of empty blocks: the last
                // part goes back to the mempool and stays there while the miner is paused.
                const orphan = await orphanWithEmptyBlocks(global.nodeConnector,
                    { height: lastPartBlock, coinbase: owner.address });
                expect(orphan.hash).to.equal(lastPartHash);
                await waitForAssemblyStatus(sdk, actionIndex, 'pending');
                expect((await rawFile(actionIndex)).status).to.equal(409);

                // Resuming the miner confirms the returned part at a new height.
                await global.regtestMinerConnector.resumeMining();
                await waitForAssemblyStatus(sdk, actionIndex, 'complete');
                const restored = await rawFile(actionIndex);
                expect(restored.status).to.equal(200);
                expect(sha256(restored.body)).to.equal(sha256(source));
            } finally {
                await global.regtestMinerConnector.resumeMining();
                await waitForIndexerTip();
            }
        });
        completed++;
    });
});
