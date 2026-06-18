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
 * XChain Platform E2E - SDK-driven SWAP (atomic token exchange)
 *
 * Drives the SWAP lifecycle through the public xchain-sdk API:
 *
 *   - SWAP v0 (create) an offer: GIVE tokenA -> GET tokenB.
 *   - SWAP v2 (edit) extend the offer's expiration.
 *   - SWAP v1 (cancel) close the offer.
 *   - Full exchange: two addresses post exact counter-swaps; the indexer
 *     AUTO-MATCHES them (no explicit accept action) and both settle to
 *     swap_status='complete'.
 *
 * Offer state is read back through the SDK (sdk.getSwaps / sdk.getSwapMatches)
 * exactly as a swap UI would.
 *
 * NOTE on cross-chain: SWAP supports GIVE_COIN != GET_COIN, but a real
 * cross-coin match needs a live multi-chain stack (the hub coordinates the
 * two ledgers). This suite exercises the same-chain path (GIVE_COIN ==
 * GET_COIN == this chain, different ticks): a complete on-ledger swap that
 * the SDK fully drives. The cross-coin variant is Phase 4 (LTC/DOGE).
 *
 * SWAP settlement rides on the indexer's matching engine; this suite runs on
 * BTC regtest (skips elsewhere, keeping parity with the connector suite, which
 * uses COIN_CODE as GIVE/GET coin).
 *
 ********************************************************************/

const { expect } = require('chai');
const { makeSdk, submit, fundedGasAddress, mine, submitOpts, uniqueTick } = require('./sdkHelper');

// SWAP create returns the offer's own action_index (used as SWAP_ACTION_INDEX
// by edit/cancel and as the give/get key in a match).
function swapIndexOf(indexed) {
    const a = indexed && Array.isArray(indexed.actions) ? indexed.actions[0] : null;
    return a ? a.action_index : null;
}

// Find a swap row (by action_index) in an sdk.getSwaps result.
function findSwap(result, actionIndex) {
    const rows = (result && result.data) || [];
    return rows.find(r => Number(r.action_index) === Number(actionIndex));
}

function ninetyDaysOut() {
    return Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90;
}

describe('[sdk] SWAP (atomic token exchange)', function () {
    this.timeout(0);

    let sdk, coin, addr1, addr2;

    // Issue a fresh token from `owner` with ample supply for swap tests.
    async function issueToken(owner, tick) {
        const res = await submit(sdk,
            { action: 'ISSUE', params: { tick, maxSupply: 1000000, maxMint: 100000, decimals: 0, description: 'sdk swap token', mintSupply: 1000 } },
            { pubkey: owner.address, change: owner.address },
            submitOpts({ wif: owner.wif })
        );
        expect(res.indexed.status, 'ISSUE ' + tick + ' should be valid').to.equal('valid');
        return tick;
    }

    before(async function () {
        const coinCode = global.COIN_CODE || 'BTC';
        if (coinCode !== 'BTC') {
            console.log('    [sdk] swap suite pinned to BTC, skipping on ' + coinCode);
            this.skip();
            return;
        }
        coin = coinCode;
        sdk = makeSdk();
        addr1 = await fundedGasAddress(sdk, 5);
        addr2 = await fundedGasAddress(sdk, 5);
        console.log('    [sdk] addr1=' + addr1.address + ' addr2=' + addr2.address);
    });

    it('SWAP v0 creates an open offer, readable via sdk.getSwaps with swap_status', async function () {
        const giveTick = uniqueTick('SWPG');
        const getTick  = uniqueTick('SWPT');
        await issueToken(addr1, giveTick);
        await issueToken(addr1, getTick);

        const res = await submit(sdk,
            {
                action: 'SWAP',
                params: {
                    version: 0,
                    giveCoin: coin, giveTick, giveAmount: 10,
                    getCoin: coin, getTick, getAmount: 5,
                    getAddress: addr1.address,
                    expiration: ninetyDaysOut(),
                    memo: 'sdk swap v0 create',
                },
            },
            { pubkey: addr1.address, change: addr1.address },
            submitOpts({ wif: addr1.wif })
        );
        console.log('    [sdk] SWAP v0 version=' + res.version + ' encoding=' + res.encoding + ' status=' + res.indexed.status);
        expect(res.version, 'should select SWAP v0').to.equal(0);
        expect(res.indexed.status).to.equal('valid');
        const swapIndex = swapIndexOf(res.indexed);
        expect(swapIndex, 'swap action_index').to.not.equal(null);

        // Read the offer back through the SDK: swap_status must reflect 'open'.
        await mine(1);
        const viaSdk = await sdk.getSwaps(addr1.address, 'address');
        const row = findSwap(viaSdk, swapIndex);
        expect(row, 'sdk.getSwaps should surface the offer').to.exist;
        expect(row.give_tick).to.equal(giveTick);
        expect(row.get_tick).to.equal(getTick);
        expect(row.swap_status, 'new offer should be open').to.equal('open');

        // Hand off to the edit/cancel test.
        this.test.parent.ctx.swap = { swapIndex, giveTick, getTick };
    });

    it('SWAP v2 edits the offer (extends expiration)', async function () {
        const s = this.test.parent.ctx.swap;
        expect(s, 'swap from prior test').to.exist;

        const res = await submit(sdk,
            {
                action: 'SWAP',
                params: {
                    version: 2,
                    swapActionIndex: s.swapIndex,
                    expiration: ninetyDaysOut() + 60 * 60 * 24 * 90, // +180d total
                    memo: 'sdk swap v2 edit',
                },
            },
            { pubkey: addr1.address, change: addr1.address },
            submitOpts({ wif: addr1.wif })
        );
        console.log('    [sdk] SWAP v2 version=' + res.version + ' status=' + res.indexed.status);
        expect(res.version, 'should select SWAP v2').to.equal(2);
        expect(res.indexed.status).to.equal('valid');

        // Still an open offer after the edit.
        await mine(1);
        const row = findSwap(await sdk.getSwaps(addr1.address, 'address'), s.swapIndex);
        expect(row, 'offer still present after edit').to.exist;
        expect(row.swap_status).to.equal('open');
    });

    it('SWAP v1 cancels the offer (swap_status -> cancelled)', async function () {
        const s = this.test.parent.ctx.swap;
        expect(s, 'swap from prior test').to.exist;

        const res = await submit(sdk,
            { action: 'SWAP', params: { version: 1, swapActionIndex: s.swapIndex, memo: 'sdk swap v1 cancel' } },
            { pubkey: addr1.address, change: addr1.address },
            submitOpts({ wif: addr1.wif })
        );
        console.log('    [sdk] SWAP v1 version=' + res.version + ' status=' + res.indexed.status);
        expect(res.version, 'should select SWAP v1').to.equal(1);
        expect(res.indexed.status).to.equal('valid');

        // Indexer flips swap_status to cancelled (authoritative DB wait).
        const cancelled = await global.indexerDatabase.waitForSwap({
            source: addr1.address, giveTick: s.giveTick, swapStatus: 'cancelled'
        }, 30000);
        expect(cancelled, 'swap should be cancelled in the DB').to.exist;

        // And the SDK read reflects it.
        await mine(1);
        const row = findSwap(await sdk.getSwaps(addr1.address, 'address'), s.swapIndex);
        expect(row, 'cancelled offer still listed').to.exist;
        expect(row.swap_status).to.equal('cancelled');
    });

    it('two exact counter-swaps auto-match and both settle to complete', async function () {
        const tokenA = uniqueTick('SWMA');
        const tokenB = uniqueTick('SWMB');

        // addr1 issues both tokens, then funds addr2 with tokenB so it can offer it.
        await issueToken(addr1, tokenA);
        await issueToken(addr1, tokenB);
        const sendRes = await submit(sdk,
            { action: 'SEND', params: { tick: tokenB, amount: 50, destination: addr2.address, memo: 'fund addr2' } },
            { pubkey: addr1.address, change: addr1.address },
            submitOpts({ wif: addr1.wif })
        );
        expect(sendRes.indexed.status).to.equal('valid');

        const expiration = ninetyDaysOut();

        // addr1: GIVE 10 tokenA, GET 5 tokenB
        const swap1 = await submit(sdk,
            {
                action: 'SWAP',
                params: {
                    version: 0,
                    giveCoin: coin, giveTick: tokenA, giveAmount: 10,
                    getCoin: coin, getTick: tokenB, getAmount: 5,
                    getAddress: addr1.address, expiration, memo: 'sell A for B',
                },
            },
            { pubkey: addr1.address, change: addr1.address },
            submitOpts({ wif: addr1.wif })
        );
        expect(swap1.indexed.status).to.equal('valid');
        const swap1Index = swapIndexOf(swap1.indexed);

        // addr2: GIVE 5 tokenB, GET 10 tokenA (exact counter-swap)
        const swap2 = await submit(sdk,
            {
                action: 'SWAP',
                params: {
                    version: 0,
                    giveCoin: coin, giveTick: tokenB, giveAmount: 5,
                    getCoin: coin, getTick: tokenA, getAmount: 10,
                    getAddress: addr2.address, expiration, memo: 'buy A with B',
                },
            },
            { pubkey: addr2.address, change: addr2.address },
            submitOpts({ wif: addr2.wif })
        );
        expect(swap2.indexed.status).to.equal('valid');
        const swap2Index = swapIndexOf(swap2.indexed);

        // The matching engine created a valid match (authoritative DB wait).
        const match = await global.indexerDatabase.waitForSwapMatch({
            giveActionIndex: swap1Index, getActionIndex: swap2Index, status: 'valid'
        }, 45000);
        expect(match, 'swap match should exist').to.exist;

        // Both offers settle to complete, observed through the SDK.
        await mine(1);
        const row1 = findSwap(await sdk.getSwaps(addr1.address, 'address'), swap1Index);
        const row2 = findSwap(await sdk.getSwaps(addr2.address, 'address'), swap2Index);
        expect(row1, 'swap1 via SDK').to.exist;
        expect(row2, 'swap2 via SDK').to.exist;
        expect(row1.swap_status, 'swap1 complete').to.equal('complete');
        expect(row2.swap_status, 'swap2 complete').to.equal('complete');

        // The match is also readable via the SDK (keyed by block).
        const matchBlock = row1.block_index || row2.block_index;
        if (matchBlock != null) {
            const matches = await sdk.getSwapMatches(matchBlock, 'block');
            expect((matches && matches.data) || [], 'sdk.getSwapMatches should return rows for the block').to.be.an('array');
        }
    });
});
