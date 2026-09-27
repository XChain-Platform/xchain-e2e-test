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
 * DOGE counter-order placement for the public cross-chain settlement drill.
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

function orderAction({ dogeTick, btcTick, amount, btcRecv }) {
    return {
        action: 'ORDER',
        params: {
            giveCoin: 'DOGE',
            giveTick: dogeTick,
            giveAmount: amount,
            getCoin: 'BTC',
            getTick: btcTick,
            getAmount: amount,
            getAddress: btcRecv,
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

async function placeDogeCounterOrder({
    dogeSdk, submitFn, maker, amount, btcRecv, waitBlocks, uniqueTick, log
}) {
    const writeLog = typeof log === 'function' ? log : () => {};
    const dogeTick = uniqueTick('DOGE');
    const btcTick = uniqueTick('BTC');

    const issue = await submitFn(dogeSdk, issueAction(dogeTick),
        { pubkey: maker.address, change: maker.address }, submitOptions(maker));
    await waitBlocks(1);
    writeLog('DOGE ISSUE submitted: ' + txidOf(issue));

    const order = await submitFn(dogeSdk,
        orderAction({ dogeTick, btcTick, amount, btcRecv }),
        { pubkey: maker.address, change: maker.address }, submitOptions(maker));
    await waitBlocks(1);
    writeLog('DOGE cross-chain ORDER submitted: ' + txidOf(order));

    return { dogeTick, orderTxid: txidOf(order), btcRecv };
}

module.exports = { placeDogeCounterOrder };
