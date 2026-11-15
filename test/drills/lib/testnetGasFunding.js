// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const GAS_TICK = 'XCHAIN';

function defaultSubmit(...args) {
    return require('../../sdk/helpers/sdkHelper').submit(...args);
}

async function fundedGasAddress({ sdk, treasury, amount, log, submitFn = defaultSubmit }) {
    if (!sdk) throw new Error('fundedGasAddress: sdk is required');
    if (!treasury || !treasury.address || !treasury.wif) {
        throw new Error('fundedGasAddress: treasury { address, wif } is required');
    }
    if (amount === undefined || amount === null) throw new Error('fundedGasAddress: amount is required');

    const kp = sdk.generateKeyPair();
    const address = sdk.deriveAddress(kp.publicKey, { type: 'p2pkh' });

    const res = await submitFn(
        sdk,
        { action: 'SEND', params: { tick: GAS_TICK, amount, destination: address } },
        { pubkey: treasury.address, change: treasury.address },
        { waitForIndexer: true, timeout: 120000, pollInterval: 1500, wif: treasury.wif }
    );

    const txid = res && res.txid;
    if (typeof log === 'function') log('funded ' + address + ' with ' + amount + ' ' + GAS_TICK + ' in ' + txid);
    return { address, wif: kp.wif, txid };
}

module.exports = { fundedGasAddress, GAS_TICK };
