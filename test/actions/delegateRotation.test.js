// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// DELEGATE rotation: the F8 key-rotation lifecycle against the live stack:
//
//   STAKE v1 (key K1) → DELEGATE v0 (add K2) → effective signer set holds BOTH
//   (additive-until-revoked) → DELEGATE v2 revokes the ORIGINAL stake key K1
//   (key-compromise completion; recorded in stake_key_revocations) → set holds
//   K2 only → STAKE v2 re-stake of K1 restores it (a revocation suppresses only
//   stake rows that predate it).
//
// Plus the collision guards that keep the effective set single-resolving:
//   - DELEGATE v0 of an already-delegated pubkey rejects (F9)
//   - STAKE v1 of an actively-delegated pubkey rejects (mirror collision)
//   - DELEGATE v2 double-revoke of the same stake key is refused, recording nothing
//   - revoking a DELEGATED key frees the pubkey for re-delegation
//
// Membership is observed through the indexer's `getcapabilityvalidators`
// JSON-RPC (which resolves through the consensus effective-set query), so the
// suite exercises exactly what PBFT quorum reads see. Assertions check OUR
// pubkeys' membership only; the shared regtest chain may carry other stakes.

const assert = require('assert')
const crypto = require('crypto')
const cryptoHelper = require('../cryptoHelper')
const stakeHelper = require('../helpers/stakeHelper')
const gasHelper = require('../helpers/gasHelper')
const transactionHelper = require('../transactionHelper')

describe('DELEGATE rotation: additive effective signer set (F8) + collision guards (F9)', function () {

    const CAPABILITY = 'price'
    // Caller-supplied threshold (the getcapabilityvalidators RPC honours it
    // over the venue's local MIN_STAKE config), keeping the suite independent
    // of per-venue staking thresholds. All stakes below are sized to it.
    const MIN_STAKE = '1000'
    const STAKE_AMOUNT = '1000.00000000'

    let ownerAddr = null   // stakes K1, delegates K2
    let otherAddr = null   // independent staker (K3) for the collision legs
    let K1 = null          // ownerAddr's original stake signing key
    let K2 = null          // ownerAddr's delegated signing key
    let K3 = null          // otherAddr's stake signing key

    function newPubkey() {
        let { publicKey } = crypto.generateKeyPairSync('ed25519')
        // Strip the 12-byte SPKI prefix → 32-byte raw Ed25519 pubkey (64 hex)
        return publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex')
    }

    // The effective signer set for CAPABILITY at the indexer's latest block.
    async function effectivePubkeys() {
        let health = await indexerConnector.health()
        assert(health && health.lastIndexedBlock !== null, 'indexer health should report lastIndexedBlock')
        let result = await indexerConnector.getCapabilityValidators(CAPABILITY, health.lastIndexedBlock, MIN_STAKE)
        assert(result, 'getcapabilityvalidators should answer')
        assert(!result.error, 'getcapabilityvalidators should not error; got: ' + result.error)
        return result.validators.map(v => String(v.pubkey).toLowerCase())
    }

    // Mine past an activation/deactivation boundary and wait for the indexer
    // to index it. Effective-set queries are block-scoped, so reading the set
    // before the boundary is indexed would assert against the OLD set.
    async function syncPast(blockIndex) {
        await regtestMinerConnector.generateBlocks(7)
        let ok = await indexerConnector.waitForIndexedBlock(Number(blockIndex), 90000)
        assert(ok, 'indexer did not reach block ' + blockIndex + ' in time')
    }

    before(async function () {
        // Capability staking (STAKE/DELEGATE v0/v2) is BTC-only by protocol design.
        if (COIN_CODE !== 'BTC') {
            console.log('STAKE/DELEGATE capability rotation is BTC-only, skipping on ' + COIN_CODE)
            this.skip()
            return
        }
        ownerAddr = await cryptoHelper.getNewFundedAddress(
            "rotation-owner", COIN, NETWORK, null, "legacy", 0, 1
        )
        otherAddr = await cryptoHelper.getNewFundedAddress(
            "rotation-other", COIN, NETWORK, null, "legacy", 0, 1
        )
        // owner: v1 stake (1000) + v2 re-stake (1000) + fees; other: v1 stake (1000) + fees
        await gasHelper.ensureGasBalance(ownerAddr, '3000')
        await gasHelper.ensureGasBalance(otherAddr, '2000')

        K1 = newPubkey()
        K2 = newPubkey()
        K3 = newPubkey()
    })

    it('STAKE v1 puts the stake key in the effective signer set', async function () {
        let result = await stakeHelper.sendStakeV1(ownerAddr, STAKE_AMOUNT, K1)
        assert(result.stake, 'stake record should exist')
        assert.strictEqual(result.stake.status, 'valid')

        await syncPast(result.stake.activation_block)
        let set = await effectivePubkeys()
        assert(set.includes(K1), 'K1 should be in the effective set after activation')
    })

    it('DELEGATE v0 ADDS the delegated key; the original stake key remains effective (additive-until-revoked)', async function () {
        let result = await stakeHelper.sendDelegateV0(ownerAddr, K2)
        assert(result.delegation, 'delegation record should exist')
        assert.strictEqual(result.delegation.status, 'valid')

        await syncPast(result.delegation.activation_block)
        let set = await effectivePubkeys()
        assert(set.includes(K1), 'original stake key K1 must REMAIN effective after delegation')
        assert(set.includes(K2), 'delegated key K2 must be effective after activation')
    })

    it('getstakesourcebypubkey resolves both the stake key and the delegated key to the staking source', async function () {
        let health = await indexerConnector.health()
        let block = Number(health.lastIndexedBlock)

        let viaStake = await indexerConnector.getStakeSourceByPubkey(K1, block)
        assert(viaStake && !viaStake.error, 'resolution for K1 should answer')
        assert.strictEqual(viaStake.source, ownerAddr.address, 'K1 resolves via its stakes row')

        let viaDelegation = await indexerConnector.getStakeSourceByPubkey(K2, block)
        assert(viaDelegation && !viaDelegation.error, 'resolution for K2 should answer')
        assert.strictEqual(viaDelegation.source, ownerAddr.address, 'K2 resolves via the delegations fallback')
    })

    it('a second source cannot delegate an already-delegated pubkey (F9)', async function () {
        // otherAddr needs its own active stake before it may DELEGATE at all.
        let staked = await stakeHelper.sendStakeV1(otherAddr, STAKE_AMOUNT, K3)
        assert(staked.stake, 'otherAddr stake record should exist')
        assert.strictEqual(staked.stake.status, 'valid')
        await syncPast(staked.stake.activation_block)

        let result = await stakeHelper.sendDelegateInvalid(otherAddr, 0, K2)
        assert(result.delegation, 'rejected delegation row should still be recorded')
        assert.notStrictEqual(result.delegation.status, 'valid',
            'double-delegation should be rejected; got status=' + result.delegation.status)
        assert.match(result.delegation.status, /already delegated/i,
            'rejection reason should mention "already delegated"; got: ' + result.delegation.status)
    })

    it('STAKE v1 rejects a pubkey currently held by an active delegation (mirror collision)', async function () {
        let msg = "STAKE|1|" + STAKE_AMOUNT + "|" + K2
        let txHash = await transactionHelper.createAndSendTransaction(ownerAddr, msg)
        let row = await stakeHelper.waitForAnyStake({
            source:        ownerAddr.address,
            signingPubkey: K2,
            txHash:        txHash
        })
        assert(row, 'stake row should be recorded (even when rejected)')
        assert.notStrictEqual(row.status, 'valid',
            'staking a delegated pubkey should be rejected; got status=' + row.status)
        assert.match(row.status, /already delegated/i,
            'rejection reason should mention "already delegated"; got: ' + row.status)
    })

    it('DELEGATE v2 revokes the ORIGINAL stake key; only the delegated key stays effective (F8)', async function () {
        let result = await stakeHelper.sendStakeKeyRevoke(ownerAddr, K1)
        assert(result.revocation, 'stake_key_revocations row should exist')
        assert.strictEqual(result.revocation.status, 'valid')
        assert(Number(result.revocation.deactivation_block) > 0, 'deactivation block should be set')

        await syncPast(result.revocation.deactivation_block)
        let set = await effectivePubkeys()
        assert(!set.includes(K1), 'revoked stake key K1 must leave the effective set')
        assert(set.includes(K2), 'delegated key K2 must remain effective')
    })

    // A refused DELEGATE v2 leaves NO row to read a rejection status off. The
    // stake-key branch is not taken (that needs an UNrevoked stake key) and the
    // delegation branch inserts nothing under DEL-1 (DELEGATE_REVOKE_NO_REINSERT,
    // armed from genesis on regtest). So the assertion is on what must NOT change:
    // a repeat revoke that recorded anything would be the signer-lifetime extension
    // DEL-1 exists to prevent.
    it('a second revoke of the same stake key is refused and records nothing (already revoked)', async function () {
        let before = await indexerDatabase.checkStakeKeyRevocation({
            source: ownerAddr.address, signingPubkey: K1, status: 'valid'
        })
        assert(before, 'the first revocation must be on record before this leg runs')

        let txHash = await transactionHelper.createAndSendTransaction(ownerAddr, "DELEGATE|2|" + K1)
        assert(txHash, 'the repeat revoke should broadcast')

        // Nothing lands, so wait the indexer past the revoke's block rather than on a row.
        let health = await indexerConnector.health()
        await syncPast(Number(health.lastIndexedBlock) + 1)

        let after = await indexerDatabase.checkStakeKeyRevocation({
            source: ownerAddr.address, signingPubkey: K1, status: 'valid'
        })
        assert(after, 'the original revocation must survive the refused repeat')
        assert.strictEqual(String(after.tx_hash), String(before.tx_hash),
            'the refused repeat must not record a second revocation')
        assert.strictEqual(String(after.deactivation_block), String(before.deactivation_block),
            'the refused repeat must not move the revoked key\'s deactivation height')
        assert.strictEqual(await stakeHelper.readDelegation(ownerAddr, K1), null,
            'a refused stake-key revoke must not write a delegations row either')

        let set = await effectivePubkeys()
        assert(!set.includes(K1), 'K1 must stay out of the effective set')
    })

    it('STAKE v2 re-stake of the revoked key restores it to the effective set', async function () {
        // A revocation suppresses only stake rows with action_index < its own.
        // The re-stake row postdates it, so K1 re-qualifies on the new amount
        // alone (the suppressed original 1000 stays suppressed).
        let result = await stakeHelper.sendStakeV2(ownerAddr, STAKE_AMOUNT, K1)
        assert(result.stake, 're-stake record should exist')
        assert.strictEqual(result.stake.status, 'valid')

        await syncPast(result.stake.activation_block)
        let set = await effectivePubkeys()
        assert(set.includes(K1), 're-staked key K1 must return to the effective set')
        assert(set.includes(K2), 'delegated key K2 must remain effective')
    })

    it('revoking a DELEGATED key removes it and frees the pubkey for re-delegation', async function () {
        let revoke = await stakeHelper.sendRevokeDelegationV0(ownerAddr, K2)
        assert(revoke.revocation, 'the parent delegation should be stamped deactivated')
        assert.strictEqual(revoke.revocation.status, 'valid')

        // Under DEL-1 the revoke writes no row of its own, so the height to sync past
        // is the deactivation_block it stamped on the parent, not a revoke row's own
        // block_index (the parent's block_index is the DELEGATE v0 that created it).
        await syncPast(Number(revoke.revocation.deactivation_block))
        let set = await effectivePubkeys()
        assert(!set.includes(K2), 'revoked delegated key K2 must leave the effective set')

        // The pubkey is freed (getDelegationByPubkey is deactivation-gated),
        // so a different staker can now claim it.
        let redelegate = await stakeHelper.sendDelegateV0(otherAddr, K2)
        assert(redelegate.delegation, 're-delegation record should exist')
        assert.strictEqual(redelegate.delegation.status, 'valid',
            'a revoked pubkey should be re-delegatable; got status=' + redelegate.delegation.status)

        await syncPast(redelegate.delegation.activation_block)
        set = await effectivePubkeys()
        assert(set.includes(K2), 'K2 must be effective again, now backed by otherAddr')

        // The block-scoped source resolution follows the newest delegation.
        let health = await indexerConnector.health()
        let resolved = await indexerConnector.getStakeSourceByPubkey(K2, Number(health.lastIndexedBlock))
        assert(resolved && !resolved.error, 'resolution for re-delegated K2 should answer')
        assert.strictEqual(resolved.source, otherAddr.address, 'K2 now resolves to its new delegating source')
    })
})
