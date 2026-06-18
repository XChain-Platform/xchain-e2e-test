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
 * XChain Platform E2E - SDK-driven misc actions
 *
 * Remaining self-contained Phase 2 actions through sdk.submitAction:
 * LIST, AIRDROP (to that list), SLEEP, DIVIDEND, SWEEP. Each test uses a
 * fresh funded+gassed actor for isolation.
 *
 ********************************************************************/

const { expect } = require('chai');
const { makeSdk, submit, fundedSdkAddress, fundedGasAddress, uniqueTick, submitOpts } = require('./sdkHelper');

function actionIndexOf(indexed) {
    const a = indexed && Array.isArray(indexed.actions) ? indexed.actions[0] : null;
    return a ? a.action_index : null;
}

async function issueToken(sdk, actor, tick, mintSupply, maxMint = 0) {
    const r = await submit(sdk,
        { action: 'ISSUE', params: { tick, maxSupply: 1000000, maxMint, decimals: 0, description: 'misc', mintSupply } },
        { pubkey: actor.address, change: actor.address }, submitOpts({ wif: actor.wif }));
    expect(r.indexed.status, 'ISSUE ' + tick).to.equal('valid');
}

async function futureBlock(sdk, ahead = 1000) {
    const status = await sdk.getStatus();
    const last = (status && status.last_block && (status.last_block.RBTC || Object.values(status.last_block)[0])) || 0;
    return Number(last) + ahead;
}

describe('[sdk] misc actions', function () {
    this.timeout(0);

    let sdk;
    before(function () { sdk = makeSdk(); });

    it('LIST creates an allowlist with an address item', async function () {
        const actor = await fundedGasAddress(sdk, 1);
        const member = await fundedSdkAddress(sdk, 1);
        const res = await submit(sdk,
            { action: 'LIST', params: { type: 1, item: member.address } },
            { pubkey: actor.address, change: actor.address }, submitOpts({ wif: actor.wif }));
        console.log('    [sdk] LIST status=' + res.indexed.status);
        expect(res.indexed.status).to.equal('valid');
    });

    it('AIRDROP distributes a token to a list', async function () {
        const actor = await fundedGasAddress(sdk, 1);
        const tick = uniqueTick('AIR');
        await issueToken(sdk, actor, tick, 1000);
        const member = await fundedSdkAddress(sdk, 1);
        const list = await submit(sdk,
            { action: 'LIST', params: { type: 1, item: member.address } },
            { pubkey: actor.address, change: actor.address }, submitOpts({ wif: actor.wif }));
        const listIndex = actionIndexOf(list.indexed);
        const res = await submit(sdk,
            { action: 'AIRDROP', params: { tick, amount: 10, listActionIndex: listIndex } },
            { pubkey: actor.address, change: actor.address }, submitOpts({ wif: actor.wif }));
        console.log('    [sdk] AIRDROP status=' + res.indexed.status);
        expect(res.indexed.status).to.equal('valid');
    });

    it('SLEEP pauses a TICK without sleeping the owner address', async function () {
        const actor = await fundedGasAddress(sdk, 1);
        const tick = uniqueTick('SLP');
        await issueToken(sdk, actor, tick, 1000);
        const resumeBlock = await futureBlock(sdk);
        const res = await submit(sdk,
            { action: 'SLEEP', params: { version: 1, resumeBlock, tick } },
            { pubkey: actor.address, change: actor.address }, submitOpts({ wif: actor.wif }));
        console.log('    [sdk] SLEEP version=' + res.version + ' status=' + res.indexed.status);
        expect(res.version).to.equal(1);
        expect(res.indexed.status).to.equal('valid');
        // Regression guard (#11): a TICK sleep must NOT sleep the owner's address.
        const tick2 = uniqueTick('SL2');
        const r2 = await submit(sdk,
            { action: 'ISSUE', params: { tick: tick2, maxSupply: 1000, maxMint: 0, decimals: 0, description: 'after-sleep', mintSupply: 1 } },
            { pubkey: actor.address, change: actor.address }, submitOpts({ wif: actor.wif }));
        expect(r2.indexed.status, 'owner address must remain active after a TICK sleep').to.equal('valid');
    });

    it('DIVIDEND pays holders in another token', async function () {
        const actor = await fundedGasAddress(sdk, 1);
        const tick = uniqueTick('DVT');
        const divTick = uniqueTick('DVD');
        await issueToken(sdk, actor, tick, 100);
        await issueToken(sdk, actor, divTick, 100000);
        const res = await submit(sdk,
            { action: 'DIVIDEND', params: { tick, dividendTick: divTick, amount: 1 } },
            { pubkey: actor.address, change: actor.address }, submitOpts({ wif: actor.wif }));
        console.log('    [sdk] DIVIDEND status=' + res.indexed.status);
        expect(res.indexed.status).to.equal('valid');
    });

    it('SWEEP moves balances to another address', async function () {
        const sweeper = await fundedGasAddress(sdk, 1);
        const dest = await fundedSdkAddress(sdk, 1);
        const res = await submit(sdk,
            { action: 'SWEEP', params: { destination: dest.address, balances: 1 } },
            { pubkey: sweeper.address, change: sweeper.address }, submitOpts({ wif: sweeper.wif }));
        console.log('    [sdk] SWEEP status=' + res.indexed.status);
        expect(res.indexed.status).to.equal('valid');
    });

    it('getStatus exposes decoder_tip and non-negative decoder_lag_blocks per coin', async function () {
        const status = await sdk.getStatus();
        expect(status, 'status object').to.be.an('object');
        // The decoder-tip reference and the indexer->decoder lag must both be present
        // so a caller can detect a stalled indexer from this single call. NOTE: these
        // measure the indexer->decoder slice only (decoder_tip is the decoder's
        // highest *processed* block, NOT the coin node's chain tip); so this test
        // deliberately does not assert anything about the chain->decoder gap (that is
        // surfaced by the decoder's own health() RPC, not /api/status).
        expect(status.decoder_tip, 'decoder_tip map').to.be.an('object');
        expect(status.decoder_lag_blocks, 'decoder_lag_blocks map').to.be.an('object');
        const coins = Object.keys(status.last_block || {});
        expect(coins.length, 'at least one active coin in last_block').to.be.greaterThan(0);
        let sawTip = false;
        for (const coin of coins) {
            // Both maps must carry an entry for every coin the indexer reports.
            expect(status.decoder_tip, 'decoder_tip has ' + coin).to.have.property(coin);
            expect(status.decoder_lag_blocks, 'decoder_lag_blocks has ' + coin).to.have.property(coin);
            const tip = status.decoder_tip[coin];
            const lag = status.decoder_lag_blocks[coin];
            // decoder_tip/decoder_lag_blocks may be null when the decoder DB is
            // unavailable; when present, the decoder tip must be at or ahead of the
            // indexer position (the indexer reads from the decoder) and the lag must
            // be a non-negative integer.
            if (tip === null) {
                expect(lag, 'decoder_lag_blocks ' + coin + ' is null when decoder_tip is null').to.equal(null);
            } else {
                sawTip = true;
                expect(tip, 'decoder_tip ' + coin).to.be.a('number');
                expect(lag, 'decoder_lag_blocks ' + coin).to.be.a('number').and.to.be.at.least(0);
                expect(tip, 'decoder_tip >= last_block ' + coin).to.be.at.least(Number(status.last_block[coin]));
            }
        }
        // In the e2e regtest stack the decoder is co-located, so at least one coin
        // must report a real decoder tip, not silently degrade to null.
        expect(sawTip, 'at least one coin reports a non-null decoder_tip').to.equal(true);
    });
});
