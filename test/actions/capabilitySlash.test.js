// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert           = require('assert')
const crypto           = require('crypto')
const cryptoHelper     = require('../cryptoHelper')
const gasHelper        = require('../helpers/gasHelper')
const stakeHelper      = require('../helpers/stakeHelper')
const stakeTeardown    = require('../helpers/stakeTeardown')
const transactionHelper = require('../transactionHelper')
const { waitForTxIndexed } = require('../helpers/indexerWait')
// The same header module the indexer's SLASH verifier derives the EQUIV key from,
// so the proof this test signs is byte-identical to what a real equivocating
// validator would have produced.
const eq = require('../../../xchain-indexer/src/equivocation_header.js')
// Same reason: the verifier resolves the proof's membership at the BURIED height, so the
// declared snapshot_block this test signs has to be one whose buried form the bond is
// active at, exactly as a real hub's locked slot would be.
const srb = require('../../../xchain-indexer/src/snapshot_reorg_buffer.js')

/**
 * CAPABILITY SLASH, driven on a chain.
 *
 * Both slash paths were landed unit-green and had never executed anywhere, so the
 * first real run would have been in production. This drives the
 * PERMISSIONLESS one: a submitter proves a staked signing key signed two conflicting
 * values for one protocol slot, and the indexer burns the whole bond.
 *
 * The property under test is the LEDGER SHAPE, not just the burn. A capability bond
 * is LOCKED in the staker's escrow at STAKE time, so a slash must RELEASE that escrow
 * before it redirects anything; crediting the bounty without the release would be a
 * pure mint that also strands the burned bond in escrow forever. So:
 *
 *   escrow released to the staker == the whole burned bond
 *   supply falls                  == exactly the un-redirected remainder
 *
 * Both figures are read back from the chain, and both are compared against the
 * indexer's own capability_slash_events row rather than against constants, so the
 * assertions hold whatever the venue's bounty/treasury governance config says.
 *
 * VENUE COST. The bond is deliberately SMALLER than the smallest capability
 * MIN_STAKE (oracle_publish, 500 XCHAIN), so it joins no capability signer set and
 * cannot move any hub's quorum weight. It does join the WHOLE-FEDERATION set, which
 * is what XCONFIG equivocation resolves membership against, and the slash then bars
 * the key from every set permanently - so the run leaves the venue no larger than it
 * found it, which is why the teardown ledger is settled by hand below.
 */
describe('Capability SLASH: an equivocation proof burns a bond and releases its escrow', function () {

    const GAS  = 'XCHAIN'
    // Under oracle_publish's 500 MIN_STAKE (the lowest of the five capabilities), so
    // this bond qualifies for the whole-federation set and for no capability set.
    const BOND = '400.00000000'
    // XCONFIG's signed content is `snapshot_block|config_digest`, the shortest
    // slashable canonical there is, which keeps the two proofs inside one
    // comfortable transaction.
    const CAPABILITY = 'config'
    const ROUND_ID   = 'e2e1'
    const VIEW       = 0

    let staker = null, submitter = null, offender = null
    let snapshotBlock = null, slashActionIndex = null, slashTxHash = null
    let event = null
    let supplyBefore = null, supplyAfter = null, baselineMaxAction = null

    function newOffender() {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
        // SPKI DER for Ed25519 is a 12-byte prefix + the 32-byte raw key.
        return { privateKey, pubkey: publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex') }
    }
    const sign = (msg) => crypto.sign(null, Buffer.from(msg, 'utf8'), offender.privateKey).toString('hex')
    const b64  = (msg) => Buffer.from(msg, 'utf8').toString('base64url')

    async function q(sql, params) {
        const conn = await indexerDatabase.getConnection()
        try { return await conn.query(sql, params) }
        finally { await conn.release() }
    }
    async function gasSupply() {
        const rows = await q(`SELECT t.supply FROM tokens t
            JOIN index_tickers it ON it.id = t.tick_id WHERE it.tick=?`, [GAS])
        return rows.length ? Number(rows[0].supply) : 0
    }
    async function maxActionIndex() {
        const rows = await q('SELECT COALESCE(MAX(action_index),0) AS m FROM actions')
        return Number(rows[0].m)
    }
    // Signed ledger rows for one action: credits positive, debits negative, escrows
    // as written (a release is a negative row). Their sum is that action's effect on
    // total supply, which is the quantity this whole suite is about.
    async function ledgerFor(actionIndex) {
        const one = async (table) => {
            const rows = await q(`SELECT COALESCE(SUM(CAST(l.amount AS DECIMAL(30,8))),0) AS amt
                FROM ${table} l JOIN index_tickers it ON it.id = l.tick_id
                WHERE l.action_index=? AND it.tick=?`, [Number(actionIndex), GAS])
            return Number(rows[0].amt)
        }
        const credits = await one('credits'), debits = await one('debits'), escrows = await one('escrows')
        return { credits, debits, escrows, net: credits - debits + escrows }
    }
    // Everything OTHER actions did to XCHAIN supply while this test was running. The
    // venue is shared, so the supply figure is only attributable once this is netted
    // out; without it a stray action elsewhere would read as a slash defect.
    async function otherLedgerNet(sinceActionIndex, exceptActionIndex) {
        const one = async (table) => {
            const rows = await q(`SELECT COALESCE(SUM(CAST(l.amount AS DECIMAL(30,8))),0) AS amt
                FROM ${table} l JOIN index_tickers it ON it.id = l.tick_id
                WHERE l.action_index > ? AND l.action_index <> ? AND it.tick=?`,
                [Number(sinceActionIndex), Number(exceptActionIndex), GAS])
            return Number(rows[0].amt)
        }
        return (await one('credits')) - (await one('debits')) + (await one('escrows'))
    }
    async function escrowRow(actionIndex, address) {
        const rows = await q(`SELECT e.amount FROM escrows e
            JOIN index_addresses ia ON ia.id = e.address_id
            JOIN index_tickers it ON it.id = e.tick_id
            WHERE e.action_index=? AND ia.address=? AND it.tick=?`,
            [Number(actionIndex), address, GAS])
        return rows.length ? Number(rows[0].amount) : null
    }
    async function creditRow(actionIndex, address) {
        const rows = await q(`SELECT c.amount FROM credits c
            JOIN index_addresses ia ON ia.id = c.address_id
            JOIN index_tickers it ON it.id = c.tick_id
            WHERE c.action_index=? AND ia.address=? AND it.tick=?`,
            [Number(actionIndex), address, GAS])
        return rows.length ? Number(rows[0].amount) : null
    }
    async function stakeAmounts(pubkey) {
        const rows = await q(`SELECT s.amount FROM stakes s
            JOIN index_pubkeys ip ON ip.id = s.signing_pubkey_id WHERE ip.pubkey=?`, [pubkey])
        return rows.map(r => Number(r.amount))
    }
    // The audit row IS the verdict: the SLASH handler writes it only on the valid
    // path, so its absence means the proof was refused and the reason is in the
    // indexer log for this action.
    async function waitForSlashEvent(pubkey, ms = 60000) {
        const deadline = Date.now() + ms
        for (;;) {
            const rows = await q(`SELECT cse.* FROM capability_slash_events cse
                JOIN index_pubkeys ip ON ip.id = cse.signing_pubkey_id WHERE ip.pubkey=?`, [pubkey])
            if (rows.length) return rows[0]
            if (Date.now() >= deadline)
                throw new Error('the SLASH was indexed but wrote no capability_slash_events row for ' +
                    pubkey + ' (tx ' + slashTxHash + ', action ' + slashActionIndex + '): the proof was ' +
                    'REFUSED, and the indexer log for that action carries the reason')
            await new Promise(r => setTimeout(r, 1000))
        }
    }

    before(async function () {
        // Capability staking is BTC-only by protocol design: STAKE off Bitcoin is
        // rejected outright (`invalid: ACTION (BTC only)`), so the bond this whole
        // suite is built on can never land on LTC or DOGE. Measured in the
        // 2026-09-05 release matrix, where this suite failed identically on both
        // and the indexer had already written that verdict. Same skip the COLLECT
        // suite carries for the same reason.
        if (COIN_CODE !== 'BTC') {
            console.log('capability SLASH rides on STAKE, which is BTC-only; skipping on ' + COIN_CODE)
            this.skip()
            return
        }
        staker = await cryptoHelper.getNewFundedAddress('cap-slash-staker', COIN, NETWORK, null, 'legacy', 0, 1)
        await gasHelper.ensureGasBalance(staker, '600')
        submitter = await cryptoHelper.getNewFundedAddress('cap-slash-submitter', COIN, NETWORK, null, 'legacy', 0, 1)
        await gasHelper.ensureGasBalance(submitter, '200')
        offender = newOffender()

        const st = await stakeHelper.sendStakeV1(staker, BOND, offender.pubkey)
        assert.strictEqual(st.stake.status, 'valid', 'the bond must be staked before it can be slashed')

        // Membership resolves at the proof's own snapshot_block BURIED by
        // CANONICAL_REORG_BUFFER, which is where the hub that locked the slot resolved its
        // own signer set. So the declared height has to sit a buffer ABOVE the first block
        // this bond is active at, or the buried read lands before activation, finds no
        // member, and the proof is refused. Mine the chain up to the declared height: the
        // equivocation being proved has to be one the chain could actually have witnessed.
        const activation = Number(st.stake.activation_block)
        assert.ok(Number.isFinite(activation) && activation > 0,
            'the stake row carries no activation_block; nothing can be proved against it')
        // Derived through the gate rather than hard-added, so this reads correctly on a
        // network where burial is still inert and the declared height IS the resolved one.
        snapshotBlock = srb.isSnapshotBurialActive(activation + srb.CANONICAL_REORG_BUFFER, NETWORK)
            ? activation + srb.CANONICAL_REORG_BUFFER
            : activation
        assert.strictEqual(srb.buriedSnapshotBlock(snapshotBlock, NETWORK), activation,
            'the declared snapshot_block must resolve onto the activation block on this network')
        const tip = await nodeConnector.getBlockCount()
        if (tip < snapshotBlock) {
            await regtestMinerConnector.generateBlocks(snapshotBlock - tip)
            // The encoder refuses to pick UTXOs while the tracker trails the node, so the
            // SLASH below cannot be built until the mining above has been absorbed.
            const synced = await utxoTrackerConnector.waitForSync(120000)
            assert.ok(synced && synced.synced,
                'the utxo-tracker never caught up with the blocks mined for the activation delay')
        }

        baselineMaxAction = await maxActionIndex()
        supplyBefore = await gasSupply()

        // The offence: two conflicting XCONFIG canonicals for one (engine, round, view).
        const contentA = String(snapshotBlock) + '|a1a1a1a1a1a1a1a1'
        const contentB = String(snapshotBlock) + '|b2b2b2b2b2b2b2b2'
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.CONFIG, ROUND_ID, VIEW, contentA)
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.CONFIG, ROUND_ID, VIEW, contentB)
        // SLASH|0|CAPABILITY|OFFENDER_PUBKEY|MSG_A|SIG_A|MSG_B|SIG_B. The EQUIV key is not
        // a wire field: it contains '|' and the verifier re-derives it from MSG_A's header.
        const wire = `SLASH|0|${CAPABILITY}|${offender.pubkey}|` +
            `${b64(msgA)}|${sign(msgA)}|${b64(msgB)}|${sign(msgB)}`

        console.log('Creating and sending SLASH V0 tx (equivocation proof)...')
        slashTxHash = await transactionHelper.createAndSendTransaction(submitter, wire)
        const rows = await waitForTxIndexed(slashTxHash, { timeoutMs: 180000 })
        slashActionIndex = Number(rows[0].action_index)

        event = await waitForSlashEvent(offender.pubkey)
        supplyAfter = await gasSupply()

        // The bond is burned to zero and the key is barred from every signer set for
        // good, so there is no UNSTAKE left to owe the venue. Settle the fixture ledger
        // by hand rather than let the sweep broadcast an UNSTAKE that must be rejected.
        stakeTeardown.noteUnstake({ signingPubkey: offender.pubkey })
    })

    it('burns the offender\'s entire capability bond', async function () {
        assert.strictEqual(Number(event.amount), Number(BOND),
            'the slash event must record the whole bond as burned')
        const remaining = await stakeAmounts(offender.pubkey)
        assert.ok(remaining.length >= 1, 'the offender must still have a stake row')
        for (const a of remaining)
            assert.strictEqual(a, 0, 'every stake row of a slashed key must be zeroed (got ' + a + ')')
    })

    it('releases the staker\'s escrow by exactly the burned amount', async function () {
        const released = await escrowRow(slashActionIndex, staker['address'])
        assert.notStrictEqual(released, null,
            'the slash wrote no escrow row for the staker: the burned bond is stranded in escrow ' +
            'and the bounty/treasury credits are a pure mint')
        assert.strictEqual(released, -Number(event.amount),
            'the escrow release must equal the burned bond exactly')
    })

    it('pays the submitter the bounty and redirects nothing else', async function () {
        const bounty = Number(event.bounty_amount)
        assert.ok(bounty > 0, 'this venue configures a bounty, so the submitter must be paid one')
        assert.strictEqual(await creditRow(slashActionIndex, submitter['address']), bounty,
            'the submitter must be credited exactly the bounty the slash event records')
        assert.strictEqual(bounty + Number(event.treasury_amount), Number(event.amount),
            'bounty + treasury must account for the whole burned bond')
        // No treasury address configured => the remainder is destroyed rather than paid out,
        // which is what makes it the "un-redirected remainder" the supply test measures.
        assert.strictEqual(event.destination_id, null,
            'this venue has no treasury destination, so the remainder must have no credit destination')
    })

    it('supply falls by exactly the un-redirected remainder', async function () {
        const led = await ledgerFor(slashActionIndex)
        // The handler pushes no debits of its own, so anything debited here is the
        // protocol fee: a genuine burn, but not part of the slash's own arithmetic.
        const fee = led.debits
        assert.strictEqual(led.net + fee, -Number(event.treasury_amount),
            'the slash itself must destroy exactly the remainder it did not redirect ' +
            '(credits ' + led.credits + ', escrows ' + led.escrows + ', fee ' + fee + ')')

        const others = await otherLedgerNet(baselineMaxAction, slashActionIndex)
        assert.strictEqual(supplyAfter - supplyBefore, led.net + others,
            'the token supply moved by something other than what the ledger recorded ' +
            '(supply ' + supplyBefore + ' -> ' + supplyAfter + ', slash net ' + led.net +
            ', other actions ' + others + ')')
    })
})
