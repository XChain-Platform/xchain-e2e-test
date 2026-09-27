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
 * BTC order placement for the public cross-chain settlement drill.
 *
 ********************************************************************/

'use strict';

const FREE_TIER_SECONDS = 90 * 86400;

function issueAction(tick) {
    return {
        action: 'ISSUE',
        params: {
            tick,
            maxSupply: 1000000,
            maxMint: 100000,
            decimals: 0,
            description: 'dex-settle',
            mintSupply: 1000
        }
    };
}

function orderAction({ tick, amount, dogeTick, dogeMakerBtcRecv }) {
    return {
        action: 'ORDER',
        params: {
            giveCoin: 'BTC',
            giveTick: tick,
            giveAmount: amount,
            getCoin: 'DOGE',
            getTick: dogeTick,
            getAmount: amount,
            getAddress: dogeMakerBtcRecv,
            expiration: Math.floor(Date.now() / 1000) + FREE_TIER_SECONDS
        }
    };
}

function submitOptions(maker) {
    return { waitForIndexer: true, timeout: 120000, pollInterval: 1500, wif: maker.wif };
}

function txidOf(result) {
    return result && (result.txid || (result.signed && result.signed.txid));
}

async function placeBtcCrossOrder({
    sdk, submitFn, maker, amount, dogeTick, dogeMakerBtcRecv, waitBlocks, uniqueTick, log
}) {
    const writeLog = typeof log === 'function' ? log : () => {};
    const tick = uniqueTick('BTC');

    const issue = await submitFn(sdk, issueAction(tick),
        { pubkey: maker.address, change: maker.address }, submitOptions(maker));
    await waitBlocks(1);
    writeLog('BTC ISSUE submitted: ' + txidOf(issue));

    const order = await submitFn(sdk,
        orderAction({ tick, amount, dogeTick, dogeMakerBtcRecv }),
        { pubkey: maker.address, change: maker.address }, submitOptions(maker));
    await waitBlocks(1);
    writeLog('BTC cross-chain ORDER submitted: ' + txidOf(order));

    return { tick, issueTxid: txidOf(issue), orderTxid: txidOf(order) };
}

module.exports = { placeBtcCrossOrder };
