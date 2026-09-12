// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const mintHelper        = require('./mintHelper')
const issueHelper       = require('./issueHelper')
const chainRail         = require('./chainRail')
const requireRow        = require('./requireRow')
const transactionHelper = require('../transactionHelper')
const cryptoHelper      = require('../cryptoHelper')

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

    // Bridge `amount` XCHAIN onto the CURRENTLY ACTIVE chain's `addressInfo` by
    // minting on BTC and locking it across with an XBRIDGE v0 (xchain-bridge.md
    // section 4), the same recipe the real distribution rail drives (AT7). The
    // bridge's supply-path closure (D62) refuses a broadcast ISSUE of the GAS tick
    // off BTC unconditionally, even on regtest, and the token row a v2 credit
    // lazily creates off BTC carries _injectGasToken's mint-disabled parameters
    // (section 9), so a DOGE/LTC run can no longer self-seed XCHAIN with a local
    // ISSUE or open MINT once the bridge lands.
    async bridgeGasIn(addressInfo, amount){
        const destCoin    = global.COIN_CODE
        const destAddress = addressInfo["address"]
        const network     = global.NETWORK

        const btcRail = await chainRail.createRail('bitcoin', network)
        let lockTxHash, issuerAddress
        await chainRail.withRail(btcRail, async () => {
            // A fresh funded BTC address per call. The first call on a fresh venue
            // ISSUEs the GAS tick (the initialCheck bootstrap shape, idempotent
            // the same way); every later call only needs a funded address to MINT
            // into and lock from, since that ISSUE leaves minting open
            // (mintStartBlock unset => 0, the e2e faucet convention).
            const gasTokenExists = await indexerDatabase.checkIssue({ tick: GAS_TICK, status: 'valid' })
            const issuerInfo = await cryptoHelper.getNewFundedAddress(
                gasTokenExists ? "GAS.LOCK" : "GAS.TOKEN", "bitcoin", network, null, "legacy", 0, 1, false
            )
            issuerAddress = issuerInfo["address"]

            if (!gasTokenExists) {
                await issueHelper.sendIssueV0(
                    issuerInfo, GAS_TICK,
                    100000000, // MAX_SUPPLY
                    100000,    // MAX_MINT (per tx): high for e2e; real faucet may cap tighter
                    0,         // decimals
                    "XChain GAS Token",
                    0          // MINT_SUPPLY: faucet, no pre-minted supply
                )
            }

            await mintHelper.sendMintV0(issuerInfo, GAS_TICK, amount, issuerAddress, "")

            let lockMessage = "XBRIDGE|0|" + destCoin + "|" + destAddress + "|" + amount + "|"

            console.log("Creating and sending XBRIDGE V0 (lock) tx...")
            lockTxHash = await transactionHelper.createAndSendTransaction(issuerInfo, lockMessage)

            console.log("Waiting for the XBRIDGE lock debit in the BTC database...")
            requireRow(await indexerDatabase.waitForDebit({
                txHash: lockTxHash,
                tick: GAS_TICK,
                address: issuerAddress,
                amount: amount
            }), "bridgeGasIn: XBRIDGE v0 lock of " + amount + " " + GAS_TICK + " to "
                + destCoin + ":" + destAddress + " (tx " + lockTxHash + ") never debited the BTC source")
        })

        // Globals are restored to the destination chain here: the mirrored v2
        // credit lands in ITS OWN indexer once the federation attests at the
        // pinned regtest depth (XCHAIN_CONFIRMATIONS_<COIN>=1) and the mirror
        // ingest applies it. Generous timeout: this crosses a PBFT round and the
        // mirror, not just a block.
        console.log("Waiting for the bridged " + GAS_TICK + " credit on " + destCoin + "...")
        return requireRow(await indexerDatabase.waitForCredit({
            address: destAddress,
            tick: GAS_TICK,
            amount: amount
        }, 120000), "bridgeGasIn: the bridged " + GAS_TICK + " credit of " + amount + " to "
            + destAddress + " on " + destCoin + " never landed (lock tx " + lockTxHash + ")")
    },

    // Fresh mnemonics per run mean addresses start at zero balance, so no need to
    // diff against current balance for idempotency in the e2e context. BTC keeps
    // the local open-mint faucet; every other chain routes through the bridge
    // (bridgeGasIn above), because xchain-bridge.md's supply-path closure (D62)
    // closes the local ISSUE/open-MINT path everywhere else.
    async ensureGasBalance(addressInfo, amount){
        if (global.COIN_CODE === 'BTC')
            return await this.mintGas(addressInfo, amount)
        return await this.bridgeGasIn(addressInfo, amount)
    }
}
