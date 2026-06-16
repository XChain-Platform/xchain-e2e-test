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
 * NFT pattern parity on the NATIVE-FEE path (Track C.3 deep-dive).
 *
 * NFTs on XChain are a composition of existing primitives (spec:
 * protocol/NFT_Standard.md) — an ISSUE with DECIMALS=0 + LOCK_MAX_SUPPLY=1.
 * The SDK suite (test/sdk/nft.sdk.test.js) proves the full pattern on BTC via
 * the XCHAIN-gas fee path. This actions-driven suite re-proves the NFT-specific
 * consensus guarantees on the NATIVE-COIN fee path (LTC/DOGE), confirming the
 * indexer's NFT logic is chain-agnostic and only the fee path differs:
 *   - classification: DECIMALS=0 + LOCK_MAX_SUPPLY=1 on the token record
 *   - indivisibility: a fractional SEND of a 0-decimals token is rejected
 *   - collection provenance: a child sub-TICK is valid only from the parent owner
 *
 * Native fee is injected automatically by transactionHelper/nativeFeeHelper on
 * fee chains. Run AFTER _ctlseed.test.js so the {COIN}/USD snapshot is fresh:
 *   ctl-run-doge.sh test/actions/_ctlseed.test.js test/actions/nftParity.test.js
 ********************************************************************/

const assert            = require('assert')
const cryptoHelper      = require('../cryptoHelper')
const issueHelper       = require('../helpers/issueHelper')
const transactionHelper = require('../transactionHelper')

async function q(sql, params) {
    const conn = await indexerDatabase.getConnection()
    try { return await conn.query(sql, params) }
    finally { await conn.release() }
}
async function tokenRecord(tick) {
    const rows = await q(`SELECT t.decimals, t.lock_max_supply, t.max_supply
        FROM tokens t JOIN index_tickers it ON it.id=t.tick_id WHERE it.tick=?`, [tick])
    return rows.length ? rows[0] : null
}
async function balanceOf(address, tick) {
    const rows = await q(`SELECT b.amount FROM balances b
        JOIN index_addresses ia ON ia.id=b.address_id
        JOIN index_tickers it ON it.id=b.tick_id
        WHERE ia.address=? AND it.tick=?`, [address, tick])
    return rows.length ? String(rows[0].amount) : '0'
}
async function tip() { const r = await q(`SELECT MAX(block_index) h FROM blocks`, []); return Number(r[0].h) }
async function mine(n) { try { await regtestMinerConnector.generateBlocks(n) } catch (e) {} }
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function randTick(p) { let s = p; for (let i = 0; i < 6; i++) s += String.fromCharCode(65 + Math.floor(Math.random() * 26)); return s }
// Send a tx expected to be REJECTED, then block until the indexer has processed
// its block (tip == node tip) so a state-effect assertion is deterministic.
async function sendAndSettle(addressInfo, wire) {
    const txHash = await transactionHelper.createAndSendTransaction(addressInfo, wire)
    await mine(1)
    let s = 0
    while ((await tip()) < (await nodeConnector.getBlockCount()) && s++ < 60) { await sleep(1000) }
    await sleep(1500)
    return txHash
}

describe('NFT pattern parity (native-fee path: DECIMALS=0 + LOCK_MAX_SUPPLY=1)', function () {
    this.timeout(0)

    let issuer, other, nftTick, parent

    before(async function () {
        issuer = await cryptoHelper.getNewFundedAddress('nftp-issuer', COIN, NETWORK, null, 'legacy', 0, 2)
        other  = await cryptoHelper.getNewFundedAddress('nftp-other',  COIN, NETWORK, null, 'legacy', 0, 1)
    })

    it('issues a unique 1-of-1 classifiable as an NFT (DECIMALS=0 + LOCK_MAX_SUPPLY=1)', async function () {
        nftTick = randTick('NFTP')
        // ISSUE|0|tick|1|0|0|desc|1|||1  -> maxSupply=1, decimals=0, mintSupply=1, lockMaxSupply=1
        await issueHelper.sendIssueV0(issuer, nftTick, '1', '0', '0', 'nft parity 1of1', '1', '', '', '1')
        const rec = await tokenRecord(nftTick)
        assert(rec, 'token record exists for the NFT')
        assert.strictEqual(Number(rec.decimals), 0, 'DECIMALS=0 (indivisible)')
        assert.strictEqual(Number(rec.lock_max_supply), 1, 'LOCK_MAX_SUPPLY=1 (permanently capped)')
        assert.strictEqual(String(rec.max_supply), '1', 'MAX_SUPPLY=1 (a unique 1-of-1)')
        assert.strictEqual(await balanceOf(issuer.address, nftTick), '1', 'issuer holds the 1-of-1')
        console.log('   NFT', nftTick, 'issued: decimals=0 lock_max_supply=1 max_supply=1')
    })

    it('enforces indivisibility: a fractional SEND of the NFT is rejected', async function () {
        await sendAndSettle(issuer, `SEND|0|${nftTick}|0.5|${other.address}|frac`)
        assert.strictEqual(await balanceOf(other.address, nftTick), '0', 'recipient was NOT credited a fractional NFT')
        assert.strictEqual(await balanceOf(issuer.address, nftTick), '1', 'issuer still holds the whole 1-of-1')
        console.log('   fractional SEND 0.5 rejected — recipient uncredited, issuer intact')
    })

    describe('collection provenance (parent/child sub-TICKs)', function () {
        before(async function () {
            parent = randTick('COLLP')
            // Parent is an ordinary owned token; child validity keys off parent ownership.
            await issueHelper.sendIssueV0(issuer, parent, '100', '0', '0', 'collection parent', '100')
        })

        it('the parent owner can issue a child item (valid NFT child)', async function () {
            const child = parent + '.ITEM'
            await issueHelper.sendIssueV0(issuer, child, '1', '0', '0', 'child item', '1', '', '', '1')
            const rec = await tokenRecord(child)
            assert(rec, 'child token record created from the parent owner')
            assert.strictEqual(Number(rec.decimals), 0, 'child DECIMALS=0')
            assert.strictEqual(Number(rec.lock_max_supply), 1, 'child LOCK_MAX_SUPPLY=1')
            assert.strictEqual(await balanceOf(issuer.address, child), '1', 'issuer holds the child item')
            console.log('   child', child, 'issued by parent owner — valid')
        })

        it('a non-owner cannot issue a child item under the parent', async function () {
            const child2 = parent + '.X1'
            await sendAndSettle(other, `ISSUE|0|${child2}|1|0|0|nope|1|||1`)
            assert.strictEqual(await tokenRecord(child2), null, 'no child token created by a non-owner of the parent')
            assert.strictEqual(await balanceOf(other.address, child2), '0', 'non-owner was not credited the rejected child')
            console.log('   child', child2, 'from non-owner — rejected (no token created)')
        })
    })
})
