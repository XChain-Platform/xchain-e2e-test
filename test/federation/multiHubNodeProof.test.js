/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * E2E test — full-node tier (NODEPROOF) live possession proof
 *
 * Stands up three real in-process xchain-hub validators against the regtest
 * stack and proves the verified-full-node tier end to end:
 *
 *   - Hubs 0 + 1 are FULL validators (each wired to the regtest bitcoind RPC)
 *     and are the bootstrap GENESIS_VERIFIERS.
 *   - Hub 2 is a LIGHT validator (NO coin RPC) — it stakes the full_node
 *     capability but cannot answer the possession challenge.
 *
 * Flow:
 *   1. Stake all three pubkeys above the full_node MIN_STAKE so the capability
 *      snapshot includes them (all three become "claimants").
 *   2. The FullNodeChallengeRound on each full hub derives the per-epoch
 *      challenge (challenge_id = sha256(network:epoch:ledger_hash:target)),
 *      answers it from its OWN bitcoind, runs the sign round, and the leader
 *      broadcasts a NODEPROOF verdict on-chain.
 *   3. The indexer validates the verdict and records full_node_verifications.
 *
 * Asserts: the two FULL hubs are verified (passed rows); the LIGHT hub is NOT,
 * and a `failed_full_node_challenge` slash proposal is recorded for it.
 *
 * The two-tranche reward SPLIT that follows from verification (oracle_base +
 * oracle_full_node) is a pure, deterministic function covered exhaustively by
 * the indexer unit tests (price.test.js "two-tranche full-node split" +
 * "reward derivation is order-independent"); driving a full PRICE oracle round
 * here would require the oracle subsystem (skipped by MultiValidatorHub), so it
 * is intentionally out of scope for this scenario — see README-NODEPROOF.md.
 *
 * VENUE: requires the regtest stack (bitcoind + decoder + indexer + MariaDB)
 * and FULLNODE_BTC_RPC_URL pointing at the regtest bitcoind JSON-RPC endpoint
 * (http://user:pass@host:port). Skips gracefully when prerequisites are absent.
 *
 * Spec: xchain-documentation/protocol/actions/NODEPROOF.md
 *
 ********************************************************************/

const dotenv = require('dotenv')
dotenv.config()

const assert = require('assert')

const cryptoHelper       = require('../cryptoHelper')
const stakeHelper        = require('../helpers/stakeHelper')
const gasHelper          = require('../helpers/gasHelper')
const transactionHelper  = require('../transactionHelper')
const { MultiValidatorHub, ValidatorIdentity } = require('../helpers/multiValidatorHubHelper')
const { requireFederationEnv, assertCleanValidatorSet } = require('../helpers/federationGuards')

// Regtest bitcoind JSON-RPC endpoint (with creds) the FULL hubs answer from.
const COIN_RPC = process.env.FULLNODE_BTC_RPC_URL || ''

// Small, regtest-friendly cadence so an epoch boundary is reached quickly.
const FULLNODE_CFG = {
    CHALLENGE_INTERVAL_BLOCKS:    5,
    CONFIRM_DEPTH:                2,
    PROOF_WINDOW_BLOCKS:          100,
    VERDICT_ACCEPT_WINDOW_BLOCKS: 20,
    REWARD_SHARE:                 '0.25',
    POLL_MS:                      2000,
    COLLECT_MS:                   3000,
    // GENESIS_VERIFIERS filled in once identities are generated (below).
}

async function _settleStack() {
    await utxoTrackerConnector.quiesce({ timeoutMs: 30000, pollMs: 250, regtestMiner: regtestMinerConnector })
}

// Poll a query until it returns rows (or timeout). Returns the rows.
async function _waitForRows(sql, args, timeoutMs = 120000, label = 'rows') {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const rows = await indexerDatabase.doQuery(sql, args)
        if (rows && rows.length > 0) return rows
        await regtestMinerConnector.generateBlocks(1)   // advance the tip so the engine ticks
        await new Promise(r => setTimeout(r, 2000))
    }
    throw new Error('timed out waiting for ' + label)
}

describe('Federation — full-node tier (NODEPROOF) possession proof', function () {
    // 3 hubs × (start + DB) + staking + activation + epoch mining + sign round
    // + on-chain verdict + indexer processing.
    this.timeout(12 * 60 * 1000)

    let mvh        = null
    let identities = null
    let fullPubkeys = []   // hubs 0,1
    let lightPubkey = null // hub 2

    before(async function () {
        if (!requireFederationEnv(this)) return
        if (!COIN_RPC) {
            console.warn('SKIP: FULLNODE_BTC_RPC_URL not set (regtest bitcoind RPC endpoint required)')
            this.skip()
            return
        }
        await assertCleanValidatorSet(indexerDatabase)

        // Fixed identities up front so GENESIS_VERIFIERS can name the two full hubs.
        identities  = [0, 1, 2].map(() => ValidatorIdentity.generate())
        fullPubkeys = [identities[0].pubkeyHex, identities[1].pubkeyHex]
        lightPubkey = identities[2].pubkeyHex

        mvh = new MultiValidatorHub({
            count: 3,
            identities,
            fullnode: Object.assign({}, FULLNODE_CFG, { GENESIS_VERIFIERS: fullPubkeys }),
            // Hubs 0,1 = full (coin RPC); hub 2 = light (no coin node).
            coinRpcUrls: [COIN_RPC, COIN_RPC, null],
        })
        await mvh.start()

        // Stake every pubkey above the full_node MIN_STAKE (2000) so all three are
        // claimants in the capability snapshot. The light hub is a claimant that
        // cannot answer — exactly the case the proof must catch.
        for (let i = 0; i < identities.length; i++) {
            const addr = await cryptoHelper.getNewFundedAddress('np-staker-' + i, COIN, NETWORK, null, 'legacy', 0, 0.02)
            await _settleStack()
            await gasHelper.ensureGasBalance(addr, '3000')
            await _settleStack()
            const res = await stakeHelper.sendStakeV1(addr, '2500.00000000', identities[i].pubkeyHex)
            assert.strictEqual(res.stake.status, 'valid', 'stake ' + i + ' should be valid')
        }
        await regtestMinerConnector.generateBlocks(7)   // activation window
        await _settleStack()

        // Fund a publisher and wire it as the NODEPROOF verdict broadcaster (only
        // the elected leader invokes it per epoch, so one shared address is fine).
        const publisherAddr = await cryptoHelper.getNewFundedAddress('np-publisher', COIN, NETWORK, null, 'legacy', 0, 0.02)
        await regtestMinerConnector.generateBlocks(2)
        await _settleStack()
        mvh.setNodeProofBroadcastHook(async (wirePayload) => {
            const txHash = await transactionHelper.createAndSendTransaction(publisherAddr, wirePayload)
            return { txid: txHash }
        })
    })

    after(async function () {
        if (mvh) {
            await mvh.stop()
            await mvh.dropDatabases()
        }
    })

    it('verifies the FULL validators and excludes the LIGHT one', async function () {
        // Cross an epoch boundary; the engines poll the tip, answer, sign, and the
        // leader publishes a NODEPROOF verdict that the indexer records.
        await regtestMinerConnector.generateBlocks(6)

        const verifiedRows = await _waitForRows(
            `SELECT ip.pubkey AS pubkey
               FROM full_node_verifications fv
               JOIN index_pubkeys ip ON ip.id = fv.signing_pubkey_id
              WHERE fv.passed = 1`,
            [], 240000, 'full_node_verifications'
        )
        const verified = new Set(verifiedRows.map(r => String(r.pubkey).toLowerCase()))

        for (const pk of fullPubkeys) {
            assert(verified.has(pk.toLowerCase()), 'FULL validator should be verified: ' + pk.slice(0, 16) + '...')
        }
        assert(!verified.has(lightPubkey.toLowerCase()),
            'LIGHT validator (no coin node) must NOT be verified')
    })

    it('records a failed_full_node_challenge slash proposal for the LIGHT validator', async function () {
        // Slash proposals are hub-local (SlashDetector writes to each hub's DB);
        // check a FULL hub's view.
        const fullHub = mvh.hubs[0]
        let rows = []
        const deadline = Date.now() + 60000
        while (Date.now() < deadline) {
            rows = await fullHub.db.doQuery(
                `SELECT validator_pubkey FROM slash_proposals
                  WHERE offense_type = 'failed_full_node_challenge'`, [])
            if (rows.some(r => String(r.validator_pubkey).toLowerCase() === lightPubkey.toLowerCase())) break
            await new Promise(r => setTimeout(r, 2000))
        }
        assert(rows.some(r => String(r.validator_pubkey).toLowerCase() === lightPubkey.toLowerCase()),
            'expected a failed_full_node_challenge proposal for the light validator')
    })
})
