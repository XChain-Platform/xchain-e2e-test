/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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

const validators = Object.freeze({
    hosts: Object.freeze([
        'validator01.xchain.io',
        'validator02.xchain.io',
        'validator03.xchain.io',
        'validator04.xchain.io',
        'validator05.xchain.io'
    ]),
    port: 10002,
    minLive: 4
});

const deadlines = Object.freeze({
    inclusionMs: 60 * 60 * 1000,
    matchMs: 2 * 60 * 60 * 1000,
    settleMs: 3 * 60 * 60 * 1000
});

function readSettleTopology(env) {
    const explorerUrl = env && env.TESTNET_EXPLORER_URL;
    if (!explorerUrl) {
        throw new Error('TESTNET_EXPLORER_URL is required');
    }

    return Object.freeze({
        validators,
        explorerUrl,
        btcCoin: env.TESTNET_BTC_COIN || 'TBTC',
        dogeCoin: env.TESTNET_DOGE_COIN || 'TDOGE',
        deadlines
    });
}

module.exports = { readSettleTopology };
