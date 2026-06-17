// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available:
// contact legal@dankest.llc.

const transactionHelper = require('../transactionHelper')

// PRICE v1 is the permissionless user TOKEN/FIAT oracle action (no stake).
// Wire format: PRICE|1|COIN|TICK|FIAT|VALUE|FEE|MEMO. The indexer records
// every PRICE v1 (valid or invalid) into the `prices` table, so this helper
// returns the row regardless of validation outcome; the caller asserts the
// expected validation_status.
module.exports = {
    // Build + broadcast a PRICE v1 action, then wait for its `prices` row.
    // `expected` defaults to a valid quote; pass validationStatus to poll for
    // the invalid record on a negative case.
    async sendPriceV1(addressInfo, { coin, tick, fiat, value, fee = '0', memo = '' }, validationStatus = 'valid'){
        let address = addressInfo['address']
        let priceMessage = 'PRICE|1|' + coin + '|' + tick + '|' + fiat + '|' + value + '|' + fee + '|' + memo

        console.log('Creating and sending PRICE V1 tx...')
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, priceMessage)

        let priceRow = await indexerDatabase.waitForPrice({
            source: address, txHash: txHash, version: 1, validationStatus: validationStatus
        })

        return { txHash, price: priceRow }
    }
}
