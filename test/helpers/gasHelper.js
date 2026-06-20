// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const mintHelper = require('./mintHelper')

const GAS_TICK = "XCHAIN"

module.exports = {
    async mintGas(addressInfo, amount){
        return await mintHelper.sendMintV0(
            addressInfo,
            GAS_TICK,
            amount,
            addressInfo["address"],
            ""
        )
    },

    // Fresh mnemonics per run mean addresses start at zero balance, so no need to
    // diff against current balance for idempotency in the e2e context.
    async ensureGasBalance(addressInfo, amount){
        return await this.mintGas(addressInfo, amount)
    }
}
