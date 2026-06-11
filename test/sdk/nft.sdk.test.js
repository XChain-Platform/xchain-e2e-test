/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Platform E2E - SDK-driven NFT pattern
 *
 * NFTs on XChain are a composition of existing primitives, not a new
 * action (spec: protocol/NFT_Standard.md). An NFT is an ISSUE with
 * DECIMALS=0 + LOCK_MAX_SUPPLY=1. This suite drives the live regtest
 * stack via sdk.submitAction and dogfoods the sdk.nft.* builders, and
 * exercises two consensus guarantees the NFT work depends on:
 *   - LOCK_MAX_SUPPLY now validates a *declared cap*, not minted supply,
 *     so a fair-mint NFT can lock its cap at issuance with zero supply.
 *   - 0-decimal ticks are indivisible end-to-end (fractional amounts
 *     are rejected; partial fills settle integer amounts).
 *
 ********************************************************************/

const { expect } = require('chai');
const { makeSdk, submit, fundedGasAddress, uniqueTick, submitOpts } = require('./sdkHelper');

const COIN = (typeof global.COIN_CODE !== 'undefined' && global.COIN_CODE) || 'BTC';

function rawBalance(balances, tick) {
    const list = balances && (Array.isArray(balances) ? balances : balances.data);
    if (!Array.isArray(list)) return null;
    const row = list.find((b) => (b.tick || b.TICK) === tick);
    if (!row) return null;
    return String(row.amount ?? row.quantity ?? row.balance);
}

// An action that the indexer rejects still gets indexed with status 'invalid'.
// Pass requireValid:false so the waiter returns it instead of throwing.
function expectInvalid(opts) { return submitOpts(Object.assign({ requireValid: false }, opts)); }

describe('[sdk] NFT pattern (ISSUE DECIMALS=0 + LOCK_MAX_SUPPLY=1)', function () {
    this.timeout(0);

    let sdk, issuer, other;

    before(async function () {
        sdk    = makeSdk();
        issuer = await fundedGasAddress(sdk, 1);
        other  = await fundedGasAddress(sdk, 1);
        console.log('    [sdk] issuer=' + issuer.address + ' other=' + other.address);
    });

    it('issues a unique 1-of-1 and classifies it as an NFT', async function () {
        const tick = uniqueTick('NFT1');
        const res = await submit(sdk,
            { action: 'ISSUE', params: sdk.nft.unique({ tick, description: 'ipfs:art' }) },
            { pubkey: issuer.address, change: issuer.address },
            submitOpts({ wif: issuer.wif })
        );
        expect(res.indexed.status, 'unique ISSUE').to.equal('valid');

        const token = await sdk.getToken(tick);
        expect(sdk.nft.isNft(token), 'classifier sees an NFT').to.equal(true);
        expect(String(rawBalance(await sdk.getBalances(issuer.address), tick)), 'issuer holds the 1-of-1').to.equal('1');
    });

    it('fair-mint NFT locks its cap at issuance with ZERO minted supply', async function () {
        // This is the LOCK_MAX_SUPPLY rule: validity now depends on a declared
        // MAX_SUPPLY cap, NOT on minted supply. A pure fair-mint NFT (no MINT_SUPPLY)
        // can therefore declare its cap, open a mint window, and permanently lock the
        // cap — all in one ISSUE, before any supply exists. (Previously rejected.)
        const tick = uniqueTick('NFTFM');
        const res = await submit(sdk,
            { action: 'ISSUE', params: {
                tick, maxSupply: 100, maxMint: 1, decimals: 0,
                lockMaxSupply: 1, mintSupply: 0, mintAddressMax: 1,
            } },
            { pubkey: issuer.address, change: issuer.address },
            submitOpts({ wif: issuer.wif })
        );
        expect(res.indexed.status, 'zero-supply fair-mint lock').to.equal('valid');

        const token = await sdk.getToken(tick);
        expect(sdk.nft.isNft(token), 'locked fair-mint edition is an NFT').to.equal(true);
    });

    it('rejects LOCK_MAX_SUPPLY when no MAX_SUPPLY cap is declared (brick guard)', async function () {
        const tick = uniqueTick('NFTBR');
        const res = await submit(sdk,
            { action: 'ISSUE', params: { tick, maxSupply: 0, decimals: 0, lockMaxSupply: 1 } },
            { pubkey: issuer.address, change: issuer.address },
            expectInvalid({ wif: issuer.wif })
        );
        expect(res.indexed.status, 'lock with no cap').to.match(/^invalid/);
    });

    it('enforces indivisibility: a fractional SEND of an NFT is rejected', async function () {
        const tick = uniqueTick('NFTID');
        let res = await submit(sdk,
            { action: 'ISSUE', params: sdk.nft.unique({ tick }) },
            { pubkey: issuer.address, change: issuer.address },
            submitOpts({ wif: issuer.wif })
        );
        expect(res.indexed.status, 'NFT ISSUE').to.equal('valid');

        res = await submit(sdk,
            { action: 'SEND', params: { tick, amount: '0.5', destination: other.address } },
            { pubkey: issuer.address, change: issuer.address },
            expectInvalid({ wif: issuer.wif })
        );
        expect(res.indexed.status, 'fractional NFT SEND').to.match(/^invalid/);
    });

    describe('collections (parent/child sub-TICKs)', function () {
        let parent;

        before(async function () {
            parent = uniqueTick('COLL');
            const res = await submit(sdk,
                { action: 'ISSUE', params: sdk.nft.unique({ tick: parent }) },
                { pubkey: issuer.address, change: issuer.address },
                submitOpts({ wif: issuer.wif })
            );
            expect(res.indexed.status, 'parent ISSUE').to.equal('valid');
        });

        it('the parent owner can issue a child item', async function () {
            const res = await submit(sdk,
                { action: 'ISSUE', params: sdk.nft.collectionItem({ parent, name: 'I1' }) },
                { pubkey: issuer.address, change: issuer.address },
                submitOpts({ wif: issuer.wif })
            );
            expect(res.indexed.status, 'child ISSUE from owner').to.equal('valid');
            expect(sdk.nft.isNft(await sdk.getToken(parent + '.I1')), 'child is an NFT').to.equal(true);
        });

        it('a non-owner cannot issue a child item under the parent', async function () {
            const res = await submit(sdk,
                { action: 'ISSUE', params: sdk.nft.collectionItem({ parent, name: 'X1' }) },
                { pubkey: other.address, change: other.address },
                expectInvalid({ wif: other.wif })
            );
            expect(res.indexed.status, 'child ISSUE from non-owner').to.match(/^invalid/);
        });
    });

    describe('content attachment (FILE + owner-validated LINK)', function () {
        let tick, issueActionIndex, fileActionIndex;

        before(async function () {
            tick = uniqueTick('NFTC');
            const issued = await submit(sdk,
                { action: 'ISSUE', params: sdk.nft.unique({ tick }) },
                { pubkey: issuer.address, change: issuer.address },
                submitOpts({ wif: issuer.wif })
            );
            expect(issued.indexed.status, 'NFT ISSUE').to.equal('valid');
            issueActionIndex = issued.indexed.action_index;

            const file = await submit(sdk,
                { action: 'FILE', params: { name: 'art.png', type: 'image/png', title: 'Cover' } },
                { pubkey: issuer.address, change: issuer.address, rawData: Buffer.from('\x89PNG fake bytes').toString('binary') },
                submitOpts({ wif: issuer.wif })
            );
            expect(file.indexed.status, 'FILE upload').to.equal('valid');
            fileActionIndex = file.indexed.action_index;
        });

        it('the token owner can LINK a FILE to the token', async function () {
            const res = await submit(sdk,
                { action: 'LINK', params: sdk.nft.attachContentParams({ coin: COIN, fileActionIndex, issueActionIndex, memo: 'cover art' }) },
                { pubkey: issuer.address, change: issuer.address },
                submitOpts({ wif: issuer.wif })
            );
            expect(res.indexed.status, 'owner LINK').to.equal('valid');
        });

        it('a non-owner cannot LINK content to the token', async function () {
            const res = await submit(sdk,
                { action: 'LINK', params: sdk.nft.attachContentParams({ coin: COIN, fileActionIndex, issueActionIndex }) },
                { pubkey: other.address, change: other.address },
                expectInvalid({ wif: other.wif })
            );
            expect(res.indexed.status, 'non-owner LINK').to.match(/^invalid/);
        });
    });
});
