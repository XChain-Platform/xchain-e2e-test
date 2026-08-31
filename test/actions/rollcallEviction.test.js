/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * E2E acceptance: ROLLCALL eviction (validator liveness), AT1 - AT4.
 *
 * Drives the whole two-chain rail: three in-process hubs sign a canonical bound
 * to a BITCOIN epoch block's ledger_hash, the elected leader lands the
 * signatures on DOGECOIN as a ROLLCALL action, and the BITCOIN indexer closes
 * each epoch at C = E + 14, re-verifies every signature against its OWN
 * ledger_hash, and after K = 2 consecutive rolled absences evicts the idle
 * fourth staking source with a synthetic UNSTAKE at action_format = 3.
 *
 *   AT1  the idle fourth source is evicted by the protocol after K rolled
 *        epochs, and getcapabilityvalidators at C + 7 returns three rows.
 *   AT2  a hub stopped across K - 1 epoch closes is absent then present, and is
 *        never evicted.
 *   AT3  rolling back the evicting close restores the hashes at C - 1, the
 *        re-parse of C reproduces them byte-identically, and deactivation_block
 *        returns to NULL on `stakes` AND `delegations`.
 *   AT4  after COOLDOWN_BLOCKS the evicted source is credited its swept amount
 *        and a fresh STAKE v1 re-enters.
 *
 * AT1 AND AT2 SHARE ONE DRIVE, deliberately: AT2's hub is down for exactly the
 * first of the two epochs AT1 needs, so one pair of epochs shows both the
 * one-epoch absence that must NOT evict and the two-epoch streak that must. The
 * two tests are one `it` because they are one measurement.
 *
 * The suite SEEDS NOTHING. Staking the federation is an operator decision, so
 * every condition the drive depends on is a named precondition in
 * test/helpers/rollcallHelper.js (bringUpVenue) that fails with the gap spelled
 * out. Two of those conditions were measured absent on the regtest venue on
 * 2026-08-30: the BTC indexer had no DOGE_INDEXER_API_URL, and the DOGE indexer
 * reported manifest_hash null. Either one makes every close DEFER forever, which
 * is why they are checked before a single block is mined.
 *
 * VENUE: bootstrapped on the BITCOIN regtest stack (COIN=bitcoin), with the
 * DOGECOIN regtest stack up and registered with the hub. Needs HUB_DB_USER /
 * HUB_DB_PASS for the in-process hubs and E2E_REQUIRE_FEDERATION=1 to opt in.
 *
 ********************************************************************/

'use strict'

const assert = require('assert')

const rc                = require('../helpers/rollcallHelper')
const cryptoHelper      = require('../cryptoHelper')
const stakeHelper       = require('../helpers/stakeHelper')
const gasHelper         = require('../helpers/gasHelper')
const { requireFederationEnv } = require('../helpers/federationGuards')

// The hub whose absence AT2 measures. Never one of the pair that must carry
// quorum without it: hubs 0 and 1 have to roll an epoch on their own.
const AT2_SILENT_HUB = 2

describe('ROLLCALL acceptance: eviction of an idle staking source (AT1-AT4)', function () {
    // Two epochs of 30 BTC blocks with their 14-block closes, a reorg, and a
    // cooldown, all with DOGE publishes interleaved.
    this.timeout(45 * 60 * 1000)

    let ctx = null
    let idleSource = null, silentSource = null
    let E1 = null, E2 = null, C1 = null, C2 = null
    let evictionRows = null      // the synthetic UNSTAKE rows AT1 observed
    let cooldownBlocks = null    // both delays are DERIVED from those rows,
    let activationDelay = null   // never assumed from a config this cannot read

    before(async function () {
        if (!rc.requireRollcallVenue(this)) return
        if (!requireFederationEnv(this)) return

        ctx = await rc.bringUpVenue({ hubCount: 3, needSources: 4 })
        idleSource   = ctx.idleSource
        silentSource = ctx.sourceOf(AT2_SILENT_HUB)
        console.log('    federation: ' + ctx.fed.sourceCount + ' source(s); idle ' + idleSource +
                    ', AT2 silent ' + silentSource)

        // AT2's outage must leave its epoch ROLLED, or the epoch counts for
        // nobody and AT1's K-streak never forms.
        rc.assertOutageStillRolls(ctx, [silentSource, idleSource])

        const tip = await ctx.btcTip()
        const epochs = rc.epochsAfter(tip + 6, ctx.network, 2)
        E1 = epochs[0]; E2 = epochs[1]
        C1 = rc.closeHeightOf(E1, ctx.network)
        C2 = rc.closeHeightOf(E2, ctx.network)
        console.log('    driving epochs ' + E1 + ' (close ' + C1 + ') and ' + E2 + ' (close ' + C2 + ')')
    })

    after(async function () { await rc.tearDownVenue(ctx) })

    // ── AT1 + AT2 ────────────────────────────────────────────────────────────

    it('AT1/AT2: the idle fourth source is evicted after K rolled epochs; the hub silent for K-1 is not', async function () {
        // Epoch 1: the AT2 hub is down. Both it and the idle source are absent,
        // and neither may be evicted on a streak of one.
        const row1 = await rc.driveEpoch(ctx, E1, { silentHubs: [AT2_SILENT_HUB] })
        assert.strictEqual(Number(row1.rolled), 1,
            'epoch ' + E1 + ' closed UNROLLED. With one hub down the remaining weight must still clear the strict ' +
            '2/3 bar, or the epoch counts for nobody and no streak forms. responsible_set_json=' +
            String(row1.responsible_set_json))
        assert.strictEqual(Number(row1.close_block), C1, 'epoch ' + E1 + ' must close at E + 14')

        const abs1 = await rc.absenceRows(ctx, E1)
        const abs1Sources = abs1.map(r => String(r.source)).sort()
        assert.deepStrictEqual(abs1Sources, [idleSource, silentSource].sort(),
            'epoch ' + E1 + ': exactly the idle source and the stopped hub\'s source must be absent, got ' +
            JSON.stringify(abs1Sources))
        for (const r of abs1)
            assert.strictEqual(Number(r.evicted), 0,
                'epoch ' + E1 + ': ' + r.source + ' must NOT be evicted on a streak of 1 (K = 2)')

        // Epoch 2: the AT2 hub is back, so only the idle source is absent and its
        // streak reaches K.
        const row2 = await rc.driveEpoch(ctx, E2, { silentHubs: [] })
        assert.strictEqual(Number(row2.rolled), 1, 'epoch ' + E2 + ' must close ROLLED with all three hubs present')

        const abs2 = await rc.absenceRows(ctx, E2)
        assert.deepStrictEqual(abs2.map(r => String(r.source)), [idleSource],
            'epoch ' + E2 + ': only the idle source may be absent once the AT2 hub is back, got ' +
            JSON.stringify(abs2.map(r => String(r.source))))
        assert.strictEqual(Number(abs2[0].evicted), 1,
            'epoch ' + E2 + ': the idle source has now been absent for K = 2 consecutive ROLLED epochs and must ' +
            'be evicted')

        // AT2's whole claim, over both epochs.
        const silentAbsences = await ctx.idxQuery(
            `SELECT ra.epoch_height, ra.evicted FROM rollcall_absences ra
               JOIN index_addresses ia ON ia.id = ra.source_id WHERE ia.address = ?`, [silentSource])
        for (const r of silentAbsences)
            assert.strictEqual(Number(r.evicted), 0,
                'AT2: a hub stopped across K - 1 closes must never be evicted; epoch ' + r.epoch_height +
                ' says otherwise')

        // The DOGE side counted the presence the BTC side judged. A mismatch here
        // means the two chains disagree about who signed, which is the failure the
        // whole rail is built to make impossible.
        const signers2 = await rc.dogeSigners(ctx, E2)
        const signerKeys = new Set(signers2.map(r => String(r.pubkey).toLowerCase()))
        for (let i = 0; i < 3; i++)
            assert.ok(signerKeys.has(ctx.roster[i].pubkey),
                'epoch ' + E2 + ': hub ' + i + '\'s signature must be on the DOGE chain, got ' +
                JSON.stringify(Array.from(signerKeys)))
        assert.ok(!signerKeys.has(ctx.roster[rc.IDLE_SEED_INDEX].pubkey),
            'epoch ' + E2 + ': the idle staker never runs a hub, so its key must not appear on the DOGE chain')

        // The eviction is a synthetic UNSTAKE at action_format = 3, one row per
        // (source, signing key) with a sweepable balance.
        evictionRows = await rc.evictionUnstakes(ctx, idleSource)
        assert.ok(evictionRows.length >= 1,
            'the eviction must mint at least one synthetic UNSTAKE at action_format = 3 for ' + idleSource +
            '; found none. Zero sweepable rows is a deliberate no-op in evictSource(), so this also fails when ' +
            'the idle source held no active stake at the close block.')
        for (const r of evictionRows){
            assert.strictEqual(Number(r.block_index), C2, 'the synthetic UNSTAKE is stamped at the close block ' + C2)
            assert.strictEqual(String(r.status), 'valid', 'the synthetic UNSTAKE is written valid')
        }

        cooldownBlocks  = Number(evictionRows[0].cooldown_end_block) - C2
        const stakeRows = await rc.stakeDeactivations(ctx, idleSource)
        const stamped   = stakeRows.filter(r => r.deactivation_block !== null)
        assert.ok(stamped.length >= 1, 'the eviction must stamp deactivation_block on the idle source\'s stake row(s)')
        activationDelay = Number(stamped[0].deactivation_block) - C2
        console.log('    eviction: ' + evictionRows.length + ' synthetic UNSTAKE row(s), ACTIVATION_DELAY_BLOCKS=' +
                    activationDelay + ', COOLDOWN_BLOCKS=' + cooldownBlocks)

        assert.ok(activationDelay <= 7,
            'AT1 reads getcapabilityvalidators at C + 7, but this venue\'s ACTIVATION_DELAY_BLOCKS is ' +
            activationDelay + ', so the evicted source is still in the capability set at C + 7. Lower ' +
            'STAKING.ACTIVATION_DELAY_BLOCKS on the regtest venue, or restate the acceptance height as C + ' +
            activationDelay + '.')

        // AT1's headline.
        await rc.mineBtcTo(ctx, C2 + 7, 'AT1 read height C + 7')
        const caps = await indexerConnector.call('getcapabilityvalidators', {
            capability: 'oracle_publish', block_index: C2 + 7,
        })
        assert.ok(caps && !caps.error, 'getcapabilityvalidators failed: ' + JSON.stringify(caps && caps.error))
        assert.strictEqual(caps.validators.length, 3,
            'AT1: getcapabilityvalidators(oracle_publish) at C + 7 = ' + (C2 + 7) + ' must return three rows once ' +
            'the protocol has evicted the idle fourth source; got ' + caps.validators.length + ': ' +
            JSON.stringify(caps.validators.map(v => v.pubkey)))
        assert.ok(!caps.validators.some(v => String(v.pubkey).toLowerCase() === ctx.roster[rc.IDLE_SEED_INDEX].pubkey),
            'AT1: the evicted source\'s signing key must be gone from the capability set at C + 7')

        // The two plain public reads the acceptance list quotes. Their DB half is
        // landed (db.js getRollcalls / getRollcallAbsencesBySource); the JSON-RPC
        // half was still in flight when this was written and is absent from the
        // regtest BTC indexer as measured 2026-08-30, so a missing method is
        // reported as exactly that rather than passing quietly.
        if (process.env.XC_ROLLCALL_SKIP_PUBLIC_READS !== '1'){
            rc.assertPublicRollcallRead(ctx.publicReads, 'getrollcalls')
            rc.assertPublicRollcallRead(ctx.publicReads, 'getrollcallabsences')

            const list = await indexerConnector.call('getrollcalls', { limit: 5 })
            assert.ok(Array.isArray(list.rollcalls), 'getrollcalls must return { rollcalls: [...] }')
            const heights = list.rollcalls.map(r => Number(r.epoch_height))
            assert.deepStrictEqual(heights.slice(), heights.slice().sort((a, b) => b - a),
                'getrollcalls must be ordered epoch_height DESC')
            const seen2 = list.rollcalls.find(r => Number(r.epoch_height) === E2)
            assert.ok(seen2, 'getrollcalls must carry epoch ' + E2)
            assert.strictEqual(Number(seen2.snapshot_block), Number(row2.snapshot_block))
            assert.strictEqual(Number(seen2.close_block), C2)
            assert.strictEqual(Number(seen2.rolled), 1)
            assert.strictEqual(Number(seen2.absent_count), 1, 'epoch ' + E2 + ' had exactly one absent source')

            const evicted = await indexerConnector.call('getrollcallabsences', { source: idleSource, limit: 10 })
            assert.ok(Array.isArray(evicted.absences), 'getrollcallabsences must return { absences: [...] }')
            assert.strictEqual(Number(evicted.absences[0].epoch_height), E2,
                'getrollcallabsences must be ordered epoch_height DESC')
            assert.strictEqual(Number(evicted.absences[0].evicted), 1)
            assert.strictEqual(String(evicted.absences[0].source), idleSource,
                'the response echoes the canonical address, not the caller\'s input')

            const unknown = await indexerConnector.call('getrollcallabsences', {
                source: 'rollcall-acceptance-no-such-source', limit: 5,
            })
            assert.deepStrictEqual(unknown.absences, [],
                'an unknown source must return an empty list, never an error: "no absences on record" is the ' +
                'reading that makes an operator stop worrying, so it must never be a swallowed query failure')
        }
    })

    // ── AT3 ──────────────────────────────────────────────────────────────────

    it('AT3: rolling back the evicting close restores the hashes and re-NULLs deactivation_block on stakes AND delegations', async function () {
        assert.ok(evictionRows && evictionRows.length,
            'AT3 reads back the eviction AT1 produced; this suite runs in file order')

        const before = {
            atClose: await indexerConnector.call('getblockhashes', { block_index: C2 }),
            atPrior: await indexerConnector.call('getblockhashes', { block_index: C2 - 1 }),
        }
        const delegationsBefore = await rc.delegationDeactivations(ctx, idleSource)

        await regtestMinerConnector.pauseMining()
        try {
            const tipBefore = await nodeConnector.getBlockCount()
            const closeHash = await nodeConnector.getBlockHash(C2)
            const minerAddr = (await cryptoHelper.getNewAddress('rollcall-reorg-miner', COIN, NETWORK, null, 'legacy', 0)).address

            await nodeConnector.invalidateBlock(closeHash)
            assert.strictEqual(await nodeConnector.getBlockCount(), C2 - 1,
                'the node must roll back to the block before the evicting close')

            // The eviction's undo is TWO separate repairs, which is why both
            // halves are asserted: the orphaned-unstake join re-NULLs the `stakes`
            // stamps, and a dedicated UPDATE keyed on rollcall_absences.evicted = 1
            // re-NULLs the `delegations` stamps, because an eviction writes no
            // DELEGATE-revoke row for the generic repair to find.
            let stakesAfter = null, delegationsAfter = null, rcRow = null, rolledBack = false
            const deadline = Date.now() + 180000
            while (Date.now() < deadline){
                stakesAfter      = await rc.stakeDeactivations(ctx, idleSource)
                delegationsAfter = await rc.delegationDeactivations(ctx, idleSource)
                rcRow            = await rc.rollcallRow(ctx, E2)
                rolledBack = !rcRow &&
                             stakesAfter.every(r => r.deactivation_block === null) &&
                             delegationsAfter.every(r => r.deactivation_block === null)
                if (rolledBack) break
                await rc.sleep(2000)
            }

            assert.strictEqual(rcRow, null,
                'the `rollcalls` row for epoch ' + E2 + ' must be deleted by the rollback: both BTC-side ROLLCALL ' +
                'tables delete on close_block >= the rollback height, because neither carries a block_index column')
            for (const r of stakesAfter)
                assert.strictEqual(r.deactivation_block, null,
                    'AT3: deactivation_block must return to NULL on `stakes` for ' + idleSource + ' / ' +
                    String(r.signing_pubkey).slice(0, 16) + '... (got ' + r.deactivation_block + ')')
            if (delegationsBefore.length === 0)
                console.log('    NOTE: the idle source holds no delegations, so the `delegations` half of AT3 has ' +
                            'nothing to assert on this venue. Seed a DELEGATE from the idle source to cover it.')
            for (const r of delegationsAfter)
                assert.strictEqual(r.deactivation_block, null,
                    'AT3: deactivation_block must return to NULL on `delegations` for ' + idleSource +
                    ' (action_index ' + r.action_index + ', got ' + r.deactivation_block + ')')

            const priorAfter = await indexerConnector.call('getblockhashes', { block_index: C2 - 1 })
            for (const f of ['ledger_hash', 'actions_hash', 'contract_hash', 'stakes_root', 'balances_root', 'state_root'])
                assert.strictEqual(String(priorAfter[f]), String(before.atPrior[f]),
                    'AT3: ' + f + ' at C - 1 must survive the rollback unchanged')

            // Empty competing chain that overtakes the original tip.
            const need = tipBefore - (C2 - 1) + 2
            for (let i = 0; i < need; i++) await nodeConnector.generateBlock(minerAddr, [])
            assert.ok(await nodeConnector.getBlockCount() > tipBefore, 'the competing chain must overtake the original')
        } finally {
            await regtestMinerConnector.resumeMining()
        }

        // Re-parse. The close is a HEIGHT event, not a transaction, so the
        // replacement block at C closes the same epoch against the same unchanged
        // DOGE evidence and must reach the same verdict. The bitcoin BLOCK hash
        // necessarily differs (it is a different block); what must be
        // byte-identical is everything the close decides.
        await rc.mineBtcTo(ctx, C2, 'reparse of the evicting close')
        let after = null
        const deadline = Date.now() + 180000
        while (Date.now() < deadline){
            if (await rc.rollcallRow(ctx, E2)){
                after = await indexerConnector.call('getblockhashes', { block_index: C2 })
                break
            }
            await rc.sleep(2000)
        }
        assert.ok(after,
            'the re-parsed block at ' + C2 + ' wrote no `rollcalls` row for epoch ' + E2 + '. The close is ' +
            'height-driven and the DOGE evidence is unchanged, so the same verdict must be reachable; a missing ' +
            'row means the close deferred on the replay.')
        for (const f of ['ledger_hash', 'actions_hash', 'contract_hash', 'stakes_root', 'balances_root', 'state_root'])
            assert.strictEqual(String(after[f]), String(before.atClose[f]),
                'AT3: ' + f + ' at the re-parsed close ' + C2 + ' must be byte-identical to the original (' +
                String(before.atClose[f]) + ' became ' + String(after[f]) + ')')

        const reEvicted = await rc.evictionUnstakes(ctx, idleSource)
        assert.strictEqual(reEvicted.length, evictionRows.length,
            'the re-parse must mint the same number of synthetic UNSTAKE rows as the original close')
    })

    // ── AT4 ──────────────────────────────────────────────────────────────────

    it('AT4: after COOLDOWN_BLOCKS the evicted source is credited its swept amount and a fresh STAKE v1 re-enters', async function () {
        assert.ok(Number.isFinite(cooldownBlocks) && cooldownBlocks > 0,
            'AT4 needs the cooldown derived from AT1\'s synthetic UNSTAKE row')

        const cooldownEnd = C2 + cooldownBlocks
        const swept = evictionRows.reduce((acc, r) => acc + Number(r.amount), 0)
        console.log('    AT4: cooldown ends at ' + cooldownEnd + ', sweeping ' + swept.toFixed(8) +
                    ' XCHAIN back to ' + idleSource)

        // The credit lands through processCooldownCompletions, which is exactly
        // why the eviction must write its `unstakes` rows BEFORE the sweep runs in
        // the same block.
        async function xchainBalance(address){
            const rows = await ctx.idxQuery(
                `SELECT b.amount AS amount FROM balances b
                   JOIN index_addresses a ON a.id = b.address_id
                   JOIN index_tickers   t ON t.id = b.tick_id
                  WHERE a.address = ? AND t.tick = 'XCHAIN'`, [address])
            return rows.length ? Number(rows[0].amount) : 0
        }
        const balanceBefore = await xchainBalance(idleSource)

        await rc.mineBtcTo(ctx, cooldownEnd + 2, 'cooldown completion')

        let balanceAfter = balanceBefore
        const deadline = Date.now() + 180000
        while (Date.now() < deadline){
            balanceAfter = await xchainBalance(idleSource)
            if (balanceAfter >= balanceBefore + swept) break
            await rc.sleep(2000)
        }
        assert.ok(balanceAfter >= balanceBefore + swept,
            'AT4: the evicted source must be credited its swept ' + swept.toFixed(8) + ' XCHAIN at the end of the ' +
            'ordinary cooldown (' + cooldownEnd + '); the balance went ' + balanceBefore + ' to ' + balanceAfter +
            '. Nothing is burned by an eviction: absence is not an offense.')

        // Re-entry. A fresh STAKE v1 with a NEW signing key, because the evicted
        // key is spent (STAKE rejects "SIGNING_PUBKEY already in use"), which is
        // itself part of the contract.
        const reentryPubkey = rc.pubkeyForSeed('55'.repeat(32))
        const stakerAddr = await cryptoHelper.getNewFundedAddress('rollcall-reentry', COIN, NETWORK, null, 'legacy', 0, 0.05)
        await gasHelper.ensureGasBalance(stakerAddr, '30000')
        await utxoTrackerConnector.quiesce({ timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector })

        const res = await stakeHelper.sendStakeV1(stakerAddr, swept.toFixed(8), reentryPubkey)
        assert.strictEqual(res.stake.status, 'valid',
            'AT4: a fresh STAKE v1 must re-enter after the cooldown; got ' + res.stake.status)

        const activation = Number(res.stake.activation_block)
        assert.ok(Number.isFinite(activation), 'the re-entering stake must carry an activation_block')
        await rc.mineBtcTo(ctx, activation + 1, 'activation of the re-entering stake')

        const caps = await indexerConnector.call('getcapabilityvalidators', {
            capability: 'oracle_publish', block_index: activation + 1,
        })
        assert.ok(caps.validators.some(v => String(v.pubkey).toLowerCase() === reentryPubkey.toLowerCase()),
            'AT4: the re-entering stake\'s key must be back in the oracle_publish capability set at ' +
            (activation + 1) + '; got ' + JSON.stringify(caps.validators.map(v => v.pubkey)))
    })
})
