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

// submitAction's `indexed` result is a transaction ({ actions: [{ action_index }] }) on
// the polling path, or a single action on the WS path — handle both (matches the other
// sdk e2e suites).
function actionIndexOf(indexed) {
    if (!indexed) return undefined;
    if (indexed.action_index !== undefined && indexed.action_index !== null) return indexed.action_index;
    const a = Array.isArray(indexed.actions) ? indexed.actions[0] : null;
    return a ? a.action_index : undefined;
}

// The per-action status on the indexed transaction is the reliable signal;
// res.indexed.status is computed by the SDK waiter and is inconsistent across its
// WS/polling paths (invalid actions can read as 'valid' on the polling path).
function statusOf(res) {
    const a = res && res.indexed && Array.isArray(res.indexed.actions) ? res.indexed.actions[0] : null;
    return (a && a.status) || (res && res.indexed && res.indexed.status);
}

// Classify by re-fetching the action's FLAT record via getAction (has decimals /
// lock_max_supply). getToken returns a nested display object whose fields isNft
// can't read, so it's the wrong input for classification.
async function classifyNft(sdk, res) {
    const idx = actionIndexOf(res && res.indexed);
    if (idx === undefined || idx === null) return false;
    return sdk.nft.isNft(await sdk.getAction(idx));
}

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
        expect(statusOf(res), 'unique ISSUE').to.equal('valid');
        expect(await classifyNft(sdk, res), 'classifier sees an NFT').to.equal(true);
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
        expect(statusOf(res), 'zero-supply fair-mint lock').to.equal('valid');
        expect(await classifyNft(sdk, res), 'locked fair-mint edition is an NFT').to.equal(true);
    });

    it('rejects LOCK_MAX_SUPPLY when no MAX_SUPPLY cap is declared (brick guard)', async function () {
        const tick = uniqueTick('NFTBR');
        const res = await submit(sdk,
            { action: 'ISSUE', params: { tick, maxSupply: 0, decimals: 0, lockMaxSupply: 1 } },
            { pubkey: issuer.address, change: issuer.address },
            expectInvalid({ wif: issuer.wif })
        );
        expect(statusOf(res), 'lock with no cap').to.match(/^invalid/);
    });

    it('enforces indivisibility: a fractional SEND of an NFT is rejected', async function () {
        const tick = uniqueTick('NFTID');
        let res = await submit(sdk,
            { action: 'ISSUE', params: sdk.nft.unique({ tick }) },
            { pubkey: issuer.address, change: issuer.address },
            submitOpts({ wif: issuer.wif })
        );
        expect(statusOf(res), 'NFT ISSUE').to.equal('valid');

        res = await submit(sdk,
            { action: 'SEND', params: { tick, amount: '0.5', destination: other.address } },
            { pubkey: issuer.address, change: issuer.address },
            expectInvalid({ wif: issuer.wif })
        );
        expect(statusOf(res), 'fractional NFT SEND').to.match(/^invalid/);
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
            expect(statusOf(res), 'parent ISSUE').to.equal('valid');
        });

        it('the parent owner can issue a child item', async function () {
            const res = await submit(sdk,
                { action: 'ISSUE', params: sdk.nft.collectionItem({ parent, name: 'I1' }) },
                { pubkey: issuer.address, change: issuer.address },
                submitOpts({ wif: issuer.wif })
            );
            expect(statusOf(res), 'child ISSUE from owner').to.equal('valid');
            expect(await classifyNft(sdk, res), 'child is an NFT').to.equal(true);
        });

        it('a non-owner cannot issue a child item under the parent', async function () {
            const res = await submit(sdk,
                { action: 'ISSUE', params: sdk.nft.collectionItem({ parent, name: 'X1' }) },
                { pubkey: other.address, change: other.address },
                expectInvalid({ wif: other.wif })
            );
            expect(statusOf(res), 'child ISSUE from non-owner').to.match(/^invalid/);
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
            expect(statusOf(issued), 'NFT ISSUE').to.equal('valid');
            issueActionIndex = actionIndexOf(issued.indexed);

            // A real (decodable) 24x24 PNG — an orange square — so the
            // explorer's raw endpoint serves a renderable image and visual
            // passes of the NFT surfaces show actual artwork.
            const ART_PNG = Buffer.from(
                'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAJ0lEQVR4nGNYECBCFcSwIEDk+2QpCtGoQaMGjRo0atCoQSPXIKogAHcNd64kvBMEAAAAAElFTkSuQmCC',
                'base64'
            );
            const file = await submit(sdk,
                { action: 'FILE', params: { name: 'art.png', type: 'image/png', title: 'Cover' } },
                { pubkey: issuer.address, change: issuer.address, rawData: ART_PNG.toString('binary') },
                submitOpts({ wif: issuer.wif })
            );
            expect(statusOf(file), 'FILE upload').to.equal('valid');
            fileActionIndex = actionIndexOf(file.indexed);
        });

        it('the token owner can LINK a FILE to the token', async function () {
            const res = await submit(sdk,
                { action: 'LINK', params: sdk.nft.attachContentParams({ coin: COIN, fileActionIndex, issueActionIndex, memo: 'cover art' }) },
                { pubkey: issuer.address, change: issuer.address },
                submitOpts({ wif: issuer.wif })
            );
            expect(statusOf(res), 'owner LINK').to.equal('valid');
        });

        it('a non-owner cannot LINK content to the token', async function () {
            const res = await submit(sdk,
                { action: 'LINK', params: sdk.nft.attachContentParams({ coin: COIN, fileActionIndex, issueActionIndex }) },
                { pubkey: other.address, change: other.address },
                expectInvalid({ wif: other.wif })
            );
            expect(statusOf(res), 'non-owner LINK').to.match(/^invalid/);
        });

        // On-chain TIS document (TIS — On-Chain Format): the token's
        // information JSON itself lives in a FILE action and DESCRIPTION
        // points at it as action:<index>. Round-trips authoring (FILE) →
        // pointing (ISSUE v1) → resolution (explorer raw bytes).
        it('an on-chain TIS document round-trips via DESCRIPTION action:<index>', async function () {
            const { json } = sdk.nft.tisDocument({
                tick, name: 'Cover Art One',
                imageActionIndex: fileActionIndex,
                imageType: 'image/png', imageName: 'art.png',
            });
            const tisFile = await submit(sdk,
                { action: 'FILE', params: { name: tick + '.json', type: 'application/json', title: 'Token information' } },
                { pubkey: issuer.address, change: issuer.address, rawData: Buffer.from(json, 'utf8').toString('binary') },
                submitOpts({ wif: issuer.wif })
            );
            expect(statusOf(tisFile), 'TIS FILE upload').to.equal('valid');
            const tisActionIndex = actionIndexOf(tisFile.indexed);

            const described = await submit(sdk,
                { action: 'ISSUE', params: { version: '1', tick, description: 'action:' + tisActionIndex } },
                { pubkey: issuer.address, change: issuer.address },
                submitOpts({ wif: issuer.wif })
            );
            expect(statusOf(described), 'ISSUE v1 description update').to.equal('valid');

            // The pointer is the token's live description...
            const token = await sdk.getToken(tick);
            expect(token.info.description, 'on-chain TIS pointer').to.equal('action:' + tisActionIndex);

            // ...and the explorer serves the document bytes back verbatim.
            const bytes = await sdk.getGatedFileRaw(tisActionIndex);
            const doc = JSON.parse(Buffer.from(bytes).toString('utf8'));
            expect(doc.tick).to.equal(tick.toUpperCase());
            expect(doc.images[0].data_ref).to.equal('action:' + fileActionIndex);
        });
    });

    // Exercises the order_match indivisibility fix on a real DEX trade: an NFT sold
    // through ORDER must settle an INTEGER amount (the matcher quantizes fills to the
    // tick's 0 decimals). DB-confirmed so the assertion is deterministic.
    describe('trading (order_match settles NFTs as integers)', function () {
        let tick;
        const expiry = () => Math.floor(Date.now() / 1000) + 90 * 86400;

        before(async function () {
            tick = uniqueTick('NFTTR');
            const res = await submit(sdk,
                { action: 'ISSUE', params: { tick, maxSupply: 5, decimals: 0, lockMaxSupply: 1, mintSupply: 5 } },
                { pubkey: issuer.address, change: issuer.address },
                submitOpts({ wif: issuer.wif })
            );
            expect(statusOf(res), 'edition ISSUE').to.equal('valid');
        });

        it('an NFT sell order matched by a buy order settles an integer NFT amount', async function () {
            // issuer sells 3 NFT for 30 XCHAIN
            const sell = await submit(sdk,
                { action: 'ORDER', params: {
                    giveCoin: COIN, giveTick: tick, giveAmount: 3,
                    getCoin: COIN, getTick: 'XCHAIN', getAmount: 30,
                    getAddress: issuer.address, expiration: expiry(),
                } },
                { pubkey: issuer.address, change: issuer.address },
                submitOpts({ wif: issuer.wif })
            );
            expect(statusOf(sell), 'sell ORDER').to.equal('valid');

            // other buys 3 NFT for 30 XCHAIN — auto-matches the sell
            const buy = await submit(sdk,
                { action: 'ORDER', params: {
                    giveCoin: COIN, giveTick: 'XCHAIN', giveAmount: 30,
                    getCoin: COIN, getTick: tick, getAmount: 3,
                    getAddress: other.address, expiration: expiry(),
                } },
                { pubkey: other.address, change: other.address },
                submitOpts({ wif: other.wif })
            );
            expect(statusOf(buy), 'buy ORDER').to.equal('valid');

            // DB-confirm the match settled exactly 3 NFT on the give side — an integer,
            // not a fractional artifact (this is the order_match indivisibility guarantee).
            const match = await global.indexerDatabase.waitForOrderMatch({
                giveTick: tick, getTick: 'XCHAIN', giveAmount: '3', status: 'valid',
            });
            expect(match, 'order_match recorded with integer give_amount=3').to.exist;

            // And the buyer holds exactly 3 NFT, no fractional dust.
            const bal = String(rawBalance(await sdk.getBalances(other.address), tick));
            expect(bal, 'buyer holds integer NFT amount').to.equal('3');
            expect(bal.includes('.'), 'no fractional NFT settled').to.equal(false);
        });
    });
});
