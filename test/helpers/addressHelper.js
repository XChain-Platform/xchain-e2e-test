// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const transactionHelper = require('../transactionHelper')

module.exports = {
    /*
     * Find the vout of a decoded transaction that pays `address`, on any chain
     * this suite runs against.
     *
     * WHY THIS IS NOT A ONE-LINER. Bitcoin Core 22 replaced the per-vout
     * `scriptPubKey.addresses` array (plus `reqSigs`) with a single
     * `scriptPubKey.address` string. The regtest venue is multi-chain and its
     * nodes are NOT all on the same generation: measured 2026-08-03 on
     * devhost, bitcoind reports `address` and litecoind still reports
     * `addresses`. So `v.scriptPubKey.address === addr` is not merely fragile,
     * it is ALWAYS undefined on Litecoin, which makes any test using it pass on
     * BTC and be structurally incapable of passing on LTC. That is exactly what
     * had happened to the envelope's MuSig2 coverage ( §3.9): it read as
     * multi-chain and had never once run on the second chain.
     *
     * Matching both shapes is also the honest way round, because a suite that
     * points at whichever node the venue has should not care which generation
     * it is; the address is the assertion, not the JSON spelling.
     */
    findVoutPayingAddress(rawTx, address){
        if (!rawTx || !Array.isArray(rawTx.vout)) return null
        return rawTx.vout.find(v => {
            const spk = v && v.scriptPubKey
            if (!spk) return false
            // Core >=22 single string, then the legacy array. An `addresses`
            // entry with several addresses is a bare multisig vout; `includes`
            // is right there, since the output does pay this address.
            return spk.address === address || (Array.isArray(spk.addresses) && spk.addresses.includes(address))
        }) || null
    },

    // ADDRESS v0 wire format: ADDRESS|0|FEE_PREFERENCE|REQUIRE_MEMO|DISPENSER_PREFERENCE|MEMO
    // DISPENSER_PREFERENCE: 1=only owner can open dispenser (default), 2=anyone.
    async sendAddressV0(addressInfo, feePreference, requireMemo, memo, dispenserPreference){
        if (dispenserPreference == null) dispenserPreference = 1
        let addressMessage = "ADDRESS|0|"+feePreference+"|"+requireMemo+"|"+dispenserPreference+"|"+memo

        console.log("Creating and sending ADDRESS V0 tx...")
        let txHash = await transactionHelper.createAndSendTransaction(addressInfo, addressMessage)

        console.log("Waiting for ADDRESS in the database...")
        let row = await indexerDatabase.waitForAddressOption({
            txHash: txHash,
            source: addressInfo["address"],
            feePreference: feePreference,
            requireMemo: requireMemo,
            status: "valid"
        })

        return { txHash, addressOption: row }
    }
}
