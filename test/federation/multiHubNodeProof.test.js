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

// FIXED (deterministic) Ed25519 seeds for the three validators. The indexer's
// eligible-verifier bootstrap is its FULLNODE.GENESIS_VERIFIERS config, which a
// separate process must be told BEFORE the verdict lands — so the genesis pubkeys
// can't be random per run. Seeds 0+1 are the two FULL hubs (and the genesis
// verifiers); seed 2 is the LIGHT hub. Configure the regtest indexer with
// FULLNODE_GENESIS_VERIFIERS = the pubkeys of seeds 0+1 (printed by
// `node test/federation/printNodeProofVerifiers.js`, or below at run start).
const FIXED_SEEDS = [
    '01'.repeat(32),   // full hub 0 (genesis verifier)
    '02'.repeat(32),   // full hub 1 (genesis verifier)
    '03'.repeat(32),   // light hub 2
]

// Small, regtest-friendly cadence so an epoch boundary is reached quickly.
const FULLNODE_CFG = {
    CHALLENGE_INTERVAL_BLOCKS:    5,
    CONFIRM_DEPTH:                2,
    PROOF_WINDOW_BLOCKS:          30,   // small so the window-based slash fires within the test (light never verified → slashed after a full window; honest hubs stay verified)
    VERDICT_ACCEPT_WINDOW_BLOCKS: 20,
    REWARD_SHARE:                 '0.25',
    POLL_MS:                      2000,
    COLLECT_MS:                   8000,   // long enough for the peer full hub's XNODE_ANSWER to reach the leader before the PASS list closes (so a verdict carries both, not just the leader)
    // GENESIS_VERIFIERS filled in once identities are generated (below).
}

async function _settleStack() {
    await utxoTrackerConnector.quiesce({ timeoutMs: 30000, pollMs: 250, regtestMiner: regtestMinerConnector })
}

// Run a raw query through the e2e indexer DB connector (pooled connection).
async function _idxQuery(sql, args) {
    const conn = await indexerDatabase.getConnection()
    try { return await conn.query(sql, args) }
    finally { await conn.release() }
}

// Poll a query until it returns rows (or timeout). Returns the rows.
async function _waitForRows(sql, args, timeoutMs = 120000, label = 'rows') {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const rows = await _idxQuery(sql, args)
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

        // Fixed (deterministic) identities so GENESIS_VERIFIERS can name the two
        // full hubs AND match the regtest indexer's FULLNODE_GENESIS_VERIFIERS env.
        identities  = FIXED_SEEDS.map((seed) => {
            const vi = new ValidatorIdentity(seed)
            return { pubkeyHex: vi.getPubkeyHex(), privkeyHex: seed }
        })
        fullPubkeys = [identities[0].pubkeyHex, identities[1].pubkeyHex]
        lightPubkey = identities[2].pubkeyHex
        console.log('NODEPROOF genesis verifiers (set indexer FULLNODE_GENESIS_VERIFIERS to these):')
        console.log('  ' + fullPubkeys.join(','))

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
            // Idempotent on a non-reset chain: a pubkey already staked (e.g. from a
            // prior run) is already a full_node claimant; STAKE v1 would be rejected
            // "SIGNING_PUBKEY already in use", so skip it.
            const existing = await _idxQuery(
                `SELECT COUNT(*) AS n FROM stakes s
                   LEFT JOIN index_statuses ist ON ist.id = s.status_id
                   LEFT JOIN index_pubkeys ip   ON ip.id  = s.signing_pubkey_id
                  WHERE ist.status = 'valid' AND LOWER(ip.pubkey) = ?
                    AND (s.deactivation_block IS NULL OR s.deactivation_block = 0)`,
                [identities[i].pubkeyHex.toLowerCase()]
            )
            if (existing && Number(existing[0].n) > 0) {
                console.log('stake ' + i + ' (' + identities[i].pubkeyHex.slice(0, 16) + '...) already present — skipping')
                continue
            }
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

        // Each verdict verifies the epoch's leader-proposed PASS list; leadership
        // rotates per epoch, so both full hubs become verified across consecutive
        // epochs. Poll (mining to advance epochs) until BOTH are present, rather
        // than asserting on the first verdict — which may carry only one.
        const wantFull = fullPubkeys.map(p => p.toLowerCase())
        const sql = `SELECT ip.pubkey AS pubkey
                       FROM full_node_verifications fv
                       JOIN index_pubkeys ip ON ip.id = fv.signing_pubkey_id
                      WHERE fv.passed = 1`
        let verified = new Set()
        const deadline = Date.now() + 240000
        while (Date.now() < deadline) {
            const rows = await _idxQuery(sql, [])
            verified = new Set(rows.map(r => String(r.pubkey).toLowerCase()))
            if (wantFull.every(pk => verified.has(pk))) break
            await regtestMinerConnector.generateBlocks(1)   // advance the tip so the engine ticks
            await new Promise(r => setTimeout(r, 2000))
        }

        for (const pk of wantFull) {
            assert(verified.has(pk), 'FULL validator should be verified: ' + pk.slice(0, 16) + '...')
        }
        assert(!verified.has(lightPubkey.toLowerCase()),
            'LIGHT validator (no coin node) must NOT be verified')
    })

    it('slashes the persistently-failing LIGHT validator but NOT the honest full hubs', async function () {
        // Window-based slashing: the LIGHT validator never answers, so after a full
        // proof window with no passing verdict it is slash-proposed; the honest FULL
        // hubs pass within the window and must NOT be slashed (the false positive a
        // per-epoch local slash would produce). Slash proposals are hub-local; check
        // a FULL hub's view, mining to advance epochs past the window.
        const fullHub = mvh.hubs[0]
        let slashed = new Set()
        const deadline = Date.now() + 180000
        while (Date.now() < deadline) {
            const rows = await fullHub.db.doQuery(
                `SELECT validator_pubkey FROM slash_proposals
                  WHERE offense_type = 'failed_full_node_challenge'`, [])
            slashed = new Set(rows.map(r => String(r.validator_pubkey).toLowerCase()))
            if (slashed.has(lightPubkey.toLowerCase())) break
            await regtestMinerConnector.generateBlocks(1)   // advance the tip so the window elapses
            await new Promise(r => setTimeout(r, 2000))
        }
        assert(slashed.has(lightPubkey.toLowerCase()),
            'LIGHT validator (never answers) must be slashed after the proof window')
        for (const pk of fullPubkeys) {
            assert(!slashed.has(pk.toLowerCase()),
                'honest FULL validator must NOT be slashed (window-based): ' + pk.slice(0, 16) + '...')
        }
    })
})
