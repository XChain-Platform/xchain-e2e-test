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
const path              = require('path')

// The hub's own relay-margin table, so the wait below tracks the margin the hub
// actually stamps rather than a number copied from it. Resolved the way
// multiValidatorHubHelper finds the hub source: the file: dep first (the e2e
// image and a monorepo dev checkout both link node_modules/xchain-hub), then the
// copy staged beside this package in the image, then the monorepo sibling, then
// the xchain-node modules/ layout. A staged CI checkout carries no node_modules
// link for the sibling, so the bare package require alone is not enough.
function loadRelayMargin(){
    const candidates = [
        'xchain-hub/src/lib/relay_margin',
        path.resolve(__dirname, '../../xchain-hub/src/lib/relay_margin.js'),
        path.resolve(__dirname, '../../../xchain-hub/src/lib/relay_margin.js'),
        path.resolve(__dirname, '../../../../xchain-hub/src/lib/relay_margin.js'),
        path.resolve(__dirname, '../../../../../modules/xchain-hub/src/lib/relay_margin.js')
    ]
    for (const c of candidates) {
        try { return require(c) } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e }
    }
    throw new Error('gasHelper: cannot resolve xchain-hub/src/lib/relay_margin beside this checkout; tried ' + candidates.join(', '))
}
const { relayMarginFloorS } = loadRelayMargin()

const GAS_TICK = "XCHAIN"

// Slack on top of the relay margin for everything between the lock confirming and
// the credit row: the engine's 15 s poll, the single-validator PBFT round, the
// mirror ingest, and the destination's protocol clock (median-time-past off
// mainnet, five to six blocks behind the wall clock at the idle cadence below).
const BRIDGE_CREDIT_SLACK_MS = 180000

// Empty-block heartbeat driven on BOTH chains while the credit is awaited. Neither
// regtest miner mines without a transaction in its mempool, so with nothing in
// flight BTC never buries the lock to the hub's depth and the destination's
// protocol time never reaches the row's effective_time (run 35124072478 sat on
// "not proposing BTC:3 (below depth 6)" until the credit wait gave up).
const IDLE_MINE_INTERVAL_MS = 10000

// Wall-clock budget for the bridged credit on `destCoin`: the hub stamps the
// finalized transfer with effective_time = now + relayMarginFloorS(dest)
// (transfer_poll.js), and the destination indexer settles it at the first block
// whose protocol time reaches that instant, so no wait shorter than the margin
// itself can ever see the credit (LTC 600 s, DOGE 240 s).
function bridgeCreditWaitMs(destCoin){
    return relayMarginFloorS(destCoin) * 1000 + BRIDGE_CREDIT_SLACK_MS
}

// Run `fn` with the idle heartbeat on every miner in `miners`, and switch it back
// off on each of them afterwards whether `fn` resolved or threw. The rest of the
// suite assumes a block lands only on its own transaction (depth and reorg
// assertions count blocks), so a heartbeat left running would perturb every case
// after this one. Every miner is restored even when an earlier restore fails;
// the first restore error surfaces only when `fn` itself succeeded, so the
// caller's own failure is never masked by a miner that would not answer.
async function withIdleMining(miners, fn, intervalMs = IDLE_MINE_INTERVAL_MS){
    for (const miner of miners) await miner.setIdleMineInterval(intervalMs)
    let fnFailed = false
    try {
        return await fn()
    } catch (err) {
        fnFailed = true
        throw err
    } finally {
        let restoreError = null
        for (const miner of miners) {
            try { await miner.setIdleMineInterval(0) }
            catch (err) { if (!restoreError) restoreError = err }
        }
        // Deliberate: a heartbeat left running is a real failure of this helper's
        // contract, so it replaces a successful return; it never replaces `fn`'s
        // own error.
        if (restoreError && !fnFailed) throw restoreError
    }
}

module.exports = {
    BRIDGE_CREDIT_SLACK_MS,
    IDLE_MINE_INTERVAL_MS,
    bridgeCreditWaitMs,
    bridgeCreditAttribution: requireRow.bridgeCreditAttribution,
    bridgeCreditEvidence: requireRow.bridgeCreditEvidence,
    withIdleMining,

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
    // lazily creates off BTC carries injectGasToken's mint-disabled parameters
    // (section 9), so a DOGE/LTC run can no longer self-seed XCHAIN with a local
    // ISSUE or open MINT once the bridge lands.
    async bridgeGasIn(addressInfo, amount){
        const destCoin    = global.COIN_CODE
        const destAddress = addressInfo["address"]
        const network     = global.NETWORK

        const btcRail = await chainRail.createRail('bitcoin', network)
        // The destination's standing miner, taken BEFORE withRail swaps the globals
        // to the BTC rail's set; the rail's own miner sits on its captured globals.
        const destMiner = global.regtestMinerConnector
        const btcMiner  = btcRail.globals.regtestMinerConnector
        let lockTxHash, issuerAddress
        return await withIdleMining([btcMiner, destMiner], async () => {
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
            // ingest applies it. The budget is the destination's relay margin plus
            // slack (bridgeCreditWaitMs): the credit cannot settle before the
            // destination's protocol clock passes effective_time, which the hub
            // stamps a full margin ahead, and the idle heartbeat above is what moves
            // that clock while nothing else is being mined.
            const waitMs = bridgeCreditWaitMs(destCoin)
            console.log("Waiting for the bridged " + GAS_TICK + " credit on " + destCoin
                + " (up to " + Math.round(waitMs / 1000) + " s: relay margin "
                + relayMarginFloorS(destCoin) + " s plus slack)...")
            const credit = await indexerDatabase.waitForCredit({
                address: destAddress,
                tick: GAS_TICK,
                amount: amount
            }, waitMs)
            const failure = "bridgeGasIn: the bridged " + GAS_TICK + " credit of " + amount + " to "
                + destAddress + " on " + destCoin + " never landed (lock tx " + lockTxHash + ")"
            const expected = {
                lockTxHash,
                destCoin,
                destAddress,
                tick: GAS_TICK,
                amount
            }
            return await requireRow.withProbe(credit, failure,
                () => requireRow.bridgeCreditAttribution(indexerDatabase, expected),
                requireRow.bridgeCreditEvidence(expected))
        })
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
