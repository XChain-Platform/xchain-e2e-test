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
const sendHelper        = require('./sendHelper')
const chainRail         = require('./chainRail')
const requireRow        = require('./requireRow')
const transactionHelper = require('./core/transactionHelper')
const cryptoHelper      = require('./core/cryptoHelper')
const createHeartbeatController = require('./core/heartbeatHelper')
const gasFaucet         = require('./rail/gas_faucet')
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

// The per-transaction MAX_MINT the e2e ISSUE of the gas tick sets on BTC (the ISSUE
// below and initialCheck's), so a bridge larger than one MINT is minted in chunks.
const GAS_MAX_MINT = 100000

// XCHAIN carries 8 decimals off BTC; amounts are compared in these base units so a
// display string such as '0.5' cannot be rounded into a false "enough".
const GAS_UNIT_SCALE = 10n ** 8n

// Bridged gas held on a non-BTC chain for the rest of this process, handed out by a
// local SEND. Bridging once per funded address cost a full relay margin each time
// (LTC 600 s, DOGE 240 s, plus the BTC MINT and lock), and nearly every funded
// address takes gas: on a representative nightly run the lock-to-credit
// leg alone averaged 518 s on litecoin and 404 s on dogecoin, per address, where
// bitcoin's grant is one local block (fundGas). A SEND from the reservoir is one block.
// Sized to cover a full action suite in one bridge: the 111 literal call sites ask
// for about 364 000 XCHAIN, plus 100 per funded address (261 on the bitcoin leg of
// that run). A shortfall refills rather than fails.
const RESERVOIR_BRIDGE_AMOUNT = parseReservoirAmount(process.env.E2E_GAS_RESERVOIR_AMOUNT, 500000)

// Native coin the reservoir address is funded with for its SEND fees. Each SEND
// spends the 50 000-sat native fee output plus relay fee, so this covers thousands.
const RESERVOIR_NATIVE_FUND = 10

// Charged against the reservoir per SEND on top of the amount, so a gas-schedule
// fee on the SEND itself can never drain it below what the accounting believes.
const RESERVOIR_FEE_HEADROOM = 1n * GAS_UNIT_SCALE

// One reservoir per chain and network, so a test that swaps rails never spends
// another chain's reservoir. Values: { addressInfo, remaining } (base units).
const reservoirs = new Map()

function parseReservoirAmount(raw, def){
    if (raw === undefined || raw === '') return def
    const n = Number(raw)
    if (!Number.isInteger(n) || n <= 0)
        throw new Error('gasHelper: E2E_GAS_RESERVOIR_AMOUNT must be a positive whole number of XCHAIN, got ' + raw)
    return n
}

function gasUnits(amount){
    const m = String(amount).trim().match(/^(\d+)(?:\.(\d{1,8}))?$/)
    if (!m) throw new Error('gasHelper: not a gas amount: ' + amount)
    return BigInt(m[1]) * GAS_UNIT_SCALE + BigInt((m[2] || '').padEnd(8, '0'))
}

// The MINT amounts that add up to `amount`, each within GAS_MAX_MINT. An amount
// that fits one MINT is returned untouched, so its wire string is the caller's.
function mintChunks(amount){
    if (gasUnits(amount) <= BigInt(GAS_MAX_MINT) * GAS_UNIT_SCALE) return [amount]
    // BTC's gas tick has 0 decimals, so anything minted there is whole.
    let left = BigInt(String(amount))
    const chunks = []
    while (left > 0n) {
        const chunk = left < BigInt(GAS_MAX_MINT) ? left : BigInt(GAS_MAX_MINT)
        chunks.push(String(chunk))
        left -= chunk
    }
    return chunks
}

function reservoirKey(){
    return global.COIN_CODE + ':' + global.NETWORK
}

// Slack on top of the relay margin for everything between the lock confirming and
// the credit row: the engine's 15 s poll, the single-validator PBFT round, the
// mirror ingest, and the destination's protocol clock (median-time-past off
// mainnet, five to six blocks behind the wall clock at the idle cadence below).
const BRIDGE_CREDIT_SLACK_MS = 180000

// Empty-block heartbeat driven on BOTH chains while the credit is awaited. The
// miners boot with a slow empty-block heartbeat, but the run pins it off for
// deterministic block counts. Enabling it here lets BTC bury the lock and lets
// destination protocol time reach the row's effective_time.
const IDLE_MINE_INTERVAL_MS = 10000
const {
    noteHeartbeatBaseline,
    pinHeartbeatOff,
    restoreHeartbeatBaselines,
    withIdleMining,
    resetHeartbeatBaselines,
} = createHeartbeatController(IDLE_MINE_INTERVAL_MS)

// How long the hub may hold the lock before it proposes the transfer at all. A BTC leg
// past BRIDGE_PROOF_READY_SNAPSHOT_ACTIVATION (regtest 0) is stamped with the first
// finalized BTC checkpoint at or above its block, and the hub checkpoints the tip less
// CHECKPOINT_CONFIRMATIONS (6) once per CHECKPOINT_INTERVAL_BLOCKS (6), judged on a
// CHECKPOINT_POLL_MS (60 s) tick. That is 12 idle blocks of chain, plus one tick of
// phase, plus one tick the interval latch drops when the 10 s miner lands its sixth
// block just after the tick. Release matrix run 41267102555 held four shards 180 s
// here and none of it was in the slack, so every credit wait gave up seconds short.
const CHECKPOINT_COVERAGE_MS = (6 + 6) * IDLE_MINE_INTERVAL_MS + 2 * 60000

// Wall-clock budget for the bridged credit on `destCoin`: the hub stamps the
// finalized transfer with effective_time = now + relayMarginFloorS(dest)
// (transfer_poll.js), and the destination indexer settles it at the first block
// whose protocol time reaches that instant, so no wait shorter than the margin
// itself can ever see the credit (LTC 600 s, DOGE 240 s). The margin clock starts
// only once a checkpoint covers the lock, so the coverage wait comes first.
function bridgeCreditWaitMs(destCoin){
    return relayMarginFloorS(destCoin) * 1000 + CHECKPOINT_COVERAGE_MS + BRIDGE_CREDIT_SLACK_MS
}

// Caches derived faucet holders by address, and when each last paid a grant.
const faucetHolders  = new Map()
const faucetLastUsed = new Map()

async function faucetHolder(record){
    if (faucetHolders.has(record.address)) return faucetHolders.get(record.address)
    const info = await cryptoHelper.getNewAddress('GAS.FAUCET.' + record.address, 'bitcoin', global.NETWORK,
                                                  record.mnemonic, 'legacy', 0)
    // Skips a record whose key does not derive its address; it cannot sign for it.
    const holder = info && info.address === record.address ? info : null
    faucetHolders.set(record.address, holder)
    return holder
}

const RELAY_POLL_MS = 5000

// One read of the committed cross_chain stake at the BTC tip: { count } on a good
// read, { error } when the tip or the weights could not be read.
async function readRelayStake(indexer){
    try {
        const tip = await indexer.call('getlatestblock', {})
        const blockIndex = tip && Number(tip.block_index)
        if (!tip || tip.error || !Number.isInteger(blockIndex) || blockIndex < 0)
            return { error: 'could not read the BTC indexer tip' }
        const weights = await indexer.call('getstakeweightsbycapability', {
            capability: 'cross_chain', block_index: blockIndex
        })
        if (!weights || weights.error || !Array.isArray(weights.validators))
            return { error: 'could not read the cross_chain stake at BTC block ' + blockIndex }
        return { count: weights.validators.length }
    } catch (e) {
        return { error: e.message }
    }
}

// A standalone hub has no cross_chain staker, so a BTC lock debits and the credit can
// never land. The nightly stack seeds its validator only once both stacks are up, so
// a stake may still arrive after the root hook starts: poll for it within the budget
// the credit wait would have spent anyway, and refuse before any BTC is locked.
async function waitForBridgeRelay(indexer, budgetMs){
    if (!indexer || typeof indexer.call !== 'function')
        throw new Error('bridgeGasIn: the BTC indexer connector is unavailable; cannot prove the hub can relay GAS')
    const deadline = Date.now() + budgetMs
    let seen = await readRelayStake(indexer)
    if (seen.count > 0) return
    console.log('Waiting up to ' + Math.round(budgetMs / 1000) + ' s for a cross_chain staker on the hub...')
    while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, RELAY_POLL_MS))
        seen = await readRelayStake(indexer)
        if (seen.count > 0) return
    }
    if (seen.error)
        throw new Error('bridgeGasIn: ' + seen.error + ' after ' + Math.round(budgetMs / 1000) +
            ' s, so the hub cross_chain stake is unproven and no BTC was locked')
    throw new Error("bridgeGasIn: the stack's hub has no cross_chain staker, so GAS can't be bridged in from BTC; " +
        "fund the reservoir another way, or run on a stack whose hub is a validator")
}

async function broadcastGasLock(helper, btcRail, bridge){
    let lockTxHash, issuerAddress
    await chainRail.withRail(btcRail, async () => {
        await waitForBridgeRelay(indexerConnector, bridgeCreditWaitMs(bridge.destCoin))
        // A fresh funded BTC address per call. The first call on a fresh venue ISSUEs
        // the GAS tick (the initialCheck bootstrap shape); later calls only need a funded
        // address to MINT into and lock from, since that ISSUE leaves minting open.
        const gasTokenExists = await indexerDatabase.checkIssue({ tick: GAS_TICK, status: 'valid' })
        const issuerInfo = await cryptoHelper.getNewFundedAddress(
            gasTokenExists ? "GAS.LOCK" : "GAS.TOKEN", "bitcoin", bridge.network, null, "legacy", 0, 1, false
        )
        issuerAddress = issuerInfo["address"]

        if (!gasTokenExists) {
            // MAX_SUPPLY, MAX_MINT per tx (high for e2e), decimals, name, and no
            // pre-minted supply: the e2e faucet convention.
            await issueHelper.sendIssueV0(
                issuerInfo, GAS_TICK,
                100000000, GAS_MAX_MINT, 0,
                "XChain GAS Token", 0
            )
        }
        // SEND from a faucet holder on a rail whose supply is spent, MINT otherwise.
        await helper.fundGas(issuerInfo, bridge.amount)
        const lockMessage = "XBRIDGE|0|" + bridge.destCoin + "|" + bridge.destAddress + "|" + bridge.amount + "|"
        console.log("Creating and sending XBRIDGE V0 (lock) tx...")
        lockTxHash = await transactionHelper.createAndSendTransaction(issuerInfo, lockMessage)

        console.log("Waiting for the XBRIDGE lock debit in the BTC database...")
        requireRow(await indexerDatabase.waitForDebit({
            txHash: lockTxHash, tick: GAS_TICK, address: issuerAddress, amount: bridge.amount
        }), "bridgeGasIn: XBRIDGE v0 lock of " + bridge.amount + " " + GAS_TICK + " to "
            + bridge.destCoin + ":" + bridge.destAddress + " (tx " + lockTxHash + ") never debited the BTC source")
    })
    return { lockTxHash, issuerAddress }
}

// Runs with the destination chain's globals restored: the mirrored v2 credit lands in
// its own indexer once the federation attests and the mirror ingest applies it. The
// budget is the relay margin plus checkpoint coverage and slack (bridgeCreditWaitMs),
// and the idle heartbeat is what moves the destination's protocol clock meanwhile.
async function waitForBridgeCredit(bridge, lockTxHash){
    const waitMs = bridgeCreditWaitMs(bridge.destCoin)
    console.log("Waiting for the bridged " + GAS_TICK + " credit on " + bridge.destCoin
        + " (up to " + Math.round(waitMs / 1000) + " s: relay margin "
        + relayMarginFloorS(bridge.destCoin) + " s plus slack)...")
    const credit = await indexerDatabase.waitForCredit({
        address: bridge.destAddress, tick: GAS_TICK, amount: bridge.amount
    }, waitMs)
    const failure = "bridgeGasIn: the bridged " + GAS_TICK + " credit of " + bridge.amount + " to "
        + bridge.destAddress + " on " + bridge.destCoin + " never landed (lock tx " + lockTxHash + ")"
    const expected = {
        lockTxHash, destCoin: bridge.destCoin, destAddress: bridge.destAddress,
        tick: GAS_TICK, amount: bridge.amount
    }
    return await requireRow.withProbe(credit, failure,
        () => requireRow.bridgeCreditAttribution(indexerDatabase, expected),
        requireRow.bridgeCreditEvidence(expected))
}

module.exports = {
    BRIDGE_CREDIT_SLACK_MS,
    CHECKPOINT_COVERAGE_MS,
    IDLE_MINE_INTERVAL_MS,
    GAS_MAX_MINT,
    RESERVOIR_BRIDGE_AMOUNT,
    bridgeCreditWaitMs,
    bridgeCreditAttribution: requireRow.bridgeCreditAttribution,
    bridgeCreditEvidence: requireRow.bridgeCreditEvidence,
    withIdleMining,
    noteHeartbeatBaseline,
    pinHeartbeatOff,
    restoreHeartbeatBaselines,

    // Grants XCHAIN on BTC, the only chain with a local supply: a faucet SEND, else a
    // MINT chunked to MAX_MINT while supply allows, else a named refusal (rail/gas_faucet.js).
    async fundGas(addressInfo, amount){
        if (global.COIN_CODE !== 'BTC')
            throw new Error('gasHelper.fundGas: XCHAIN is funded on BTC only, not ' + global.COIN_CODE)
        const db = global.indexerDatabase
        const records = gasFaucet.readFaucetRecords(gasFaucet.faucetFile())
        const usable = []
        for (const r of records) if (await faucetHolder(r)) usable.push(r)
        const holders = usable.length ? await gasFaucet.readHolderBalances(db, usable, GAS_TICK) : []
        const plan = gasFaucet.planGasFunding({
            amount, holders, lastUsed: faucetLastUsed,
            supply: await gasFaucet.readGasSupply(db, GAS_TICK)
        })
        if (plan.kind === 'send') {
            faucetLastUsed.set(plan.address, Date.now())
            console.log('Funding ' + amount + ' ' + GAS_TICK + ' to ' + addressInfo['address'] +
                        ' by SEND from faucet holder ' + plan.address)
            return await sendHelper.sendSendV0(faucetHolders.get(plan.address), GAS_TICK, amount, addressInfo['address'], '')
        }
        if (plan.kind === 'refuse')
            throw new Error('gasHelper.fundGas: ' + plan.reason + '; faucet file ' + gasFaucet.faucetFile())
        let result = null
        for (const chunk of mintChunks(amount))
            result = await this.mintGas(addressInfo, chunk)
        return result
    },

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
        const bridge = {
            destCoin: global.COIN_CODE,
            destAddress: addressInfo["address"],
            network: global.NETWORK,
            amount
        }
        const btcRail = await chainRail.createRail('bitcoin', bridge.network)
        // The destination's standing miner, taken BEFORE withRail swaps the globals
        // to the BTC rail's set; the rail's own miner sits on its captured globals.
        const destMiner = global.regtestMinerConnector
        const btcMiner  = btcRail.globals.regtestMinerConnector
        return await withIdleMining([btcMiner, destMiner], async () => {
            const lock = await broadcastGasLock(this, btcRail, bridge)
            return await waitForBridgeCredit(bridge, lock.lockTxHash)
        })
    },

    // Fresh mnemonics per run mean addresses start at zero balance, so no need to
    // diff against current balance for idempotency in the e2e context. BTC is paid
    // by fundGas; every other chain is paid from the bridged
    // reservoir (sendFromGasReservoir below), because xchain-bridge.md's
    // supply-path closure (D62) closes the local ISSUE/open-MINT path everywhere
    // else. A suite that must prove the bridge itself calls bridgeGasIn directly.
    async ensureGasBalance(addressInfo, amount){
        if (global.COIN_CODE === 'BTC')
            return await this.fundGas(addressInfo, amount)
        return await this.sendFromGasReservoir(addressInfo, amount)
    },

    // Make sure this chain's reservoir exists and holds at least `neededUnits`
    // (base units), bridging a refill when it does not. The first call on a fresh
    // venue is also what creates the gas token row off BTC (section 9), which is
    // why initialCheck's bootstrap calls this directly.
    async fillGasReservoir(neededUnits = 1n){
        const key = reservoirKey()
        let reservoir = reservoirs.get(key)
        if (!reservoir) {
            const addressInfo = await cryptoHelper.getNewFundedAddress(
                "GAS.RESERVOIR", global.COIN, global.NETWORK, null, "legacy", 0, RESERVOIR_NATIVE_FUND, false
            )
            reservoir = { addressInfo, remaining: 0n }
            reservoirs.set(key, reservoir)
        }
        if (reservoir.remaining >= neededUnits) return reservoir

        // Whole XCHAIN, because the BTC side mints with 0 decimals.
        const shortfall = (neededUnits - reservoir.remaining + GAS_UNIT_SCALE - 1n) / GAS_UNIT_SCALE
        const bridgeAmount = String(shortfall > BigInt(RESERVOIR_BRIDGE_AMOUNT) ? shortfall : BigInt(RESERVOIR_BRIDGE_AMOUNT))
        console.log("Filling the " + key + " gas reservoir " + reservoir.addressInfo["address"]
            + " with " + bridgeAmount + " " + GAS_TICK + " over the bridge...")
        try {
            await this.bridgeGasIn(reservoir.addressInfo, bridgeAmount)
        } catch (err) {
            // A half-landed refill leaves the balance unknown; start the next call clean.
            reservoirs.delete(key)
            throw err
        }
        reservoir.remaining += gasUnits(bridgeAmount)
        return reservoir
    },

    async sendFromGasReservoir(addressInfo, amount){
        const cost = gasUnits(amount) + RESERVOIR_FEE_HEADROOM
        const reservoir = await this.fillGasReservoir(cost)
        try {
            const result = await sendHelper.sendSendV0(reservoir.addressInfo, GAS_TICK, amount, addressInfo["address"], "")
            reservoir.remaining -= cost
            return result
        } catch (err) {
            // A SEND that did not land valid means the accounting no longer matches the
            // ledger (a reorg, a fee this file does not know about): rebuild next time
            // rather than keep spending from a balance nobody has checked.
            reservoirs.delete(reservoirKey())
            throw err
        }
    },

    // Unit tests only: forget every reservoir so each case starts from none.
    ['_resetGasReservoirs'](){
        reservoirs.clear()
    },

    // Unit tests only: forget every derived faucet holder and its last-use time.
    ['_resetGasFaucet'](){
        faucetHolders.clear()
        faucetLastUsed.clear()
    },

    // Unit tests only: forget every recorded heartbeat baseline.
    ['_resetHeartbeatBaselines'](){
        resetHeartbeatBaselines()
    }
}
