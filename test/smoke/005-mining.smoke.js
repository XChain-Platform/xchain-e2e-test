// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')

describe('SMOKE: Regtest Mining', () => {
    it('should be able to configure mining timing', async () => {
        const result = await regtestMinerConnector.setMiningTime(1000, 1000)
        assert(result !== null && result !== undefined, 'setMiningTime should return a result')
    })

    it('should be able to send funds to a new address', async () => {
        const cryptoHelper = require('../cryptoHelper')
        const addressInfo = await cryptoHelper.getNewAddress(
            'SMOKE.MINING', COIN, NETWORK, null, 'legacy', 0
        )

        const txId = await regtestMinerConnector.sendFunds(addressInfo.address, 1)
        assert(txId, 'sendFunds should return a transaction ID')

        const txExists = await nodeConnector.waitForTx(txId, 30000)
        assert(txExists, 'Funded transaction should appear in the blockchain')
    })
})
