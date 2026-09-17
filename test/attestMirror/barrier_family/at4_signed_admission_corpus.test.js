'use strict'

/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 **********************************************************************
 * AT4 corpus: a federation-signed, admission-era mirror corpus for the replay
 * witness (xchain-indexer bin/verify-mirror-admission-replay-equivalence.js).
 *
 * WHY A DRIVE BUILDS IT. The witness counts a corpus as admission-bearing only
 * when its mirror holds a row carrying this chain's admission height in a table a
 * consumer binds by it. The BF legs seed INERT rows (no verifiable signature, so no
 * pass applies them) and the AB legs cover anchor_reward_attestations, which the
 * witness does not count; on one BTC stack the only such table real traffic reaches
 * is attestation_responses. So this drive makes one: AT1's http_get request, with
 * the mirror-admission lever armed on every venue hub (the producers stamp
 * admit_block_btc) and every venue indexer (the consumers bind by it).
 *
 * WHAT IT PROVES, and leaves behind:
 *   1. the round finalizes a SIGNED row whose admit_block_btc is set, identical on
 *      both mirrors;
 *   2. both armed indexers apply that response with no transaction AT its admission
 *      height, at the same action index with the same response hash;
 *   3. the corpus levels past that height, and the drive prints the witness command
 *      for it (bin path, --decoder-db, --mirror-db, --activation-height H) with H
 *      strictly above the admission height and at or below the corpus tip.
 * The mirror schema survives the venue's stop (indexer-side schemas are stable by
 * name), so the witness runs after this file exits, against the same database.
 *
 * THE ROSTER. The request needs a responsible set of three live signers, and the
 * venue ADOPTS the seated roster rather than staking. A fresh chain seats none, so
 * the prologue suite runs the repository's roster seeder
 * (test/tools/reseedAttestationRoster.test) when, and only when, the seated set
 * cannot be adopted. Seeding needs E2E_STAKE_TEARDOWN=off, and the seeder refuses
 * loudly without it. A chain that already seats an adoptable roster skips it.
 *
 * SERIALIZED, like AT1: the venue runs hubs for the seated identities, so two live
 * venues on one chain would equivocate against each other.
 ********************************************************************/

const assert = require('assert')
const path = require('path')
const dotenv = require('dotenv')
dotenv.config()

const rows = require('../helpers/barrierFamilyRows')
const drive = require('../helpers/barrierFamilyDrive')
const {
    provisionDrillIdentities, startAttestTestServer, deployRequestContract, settleStack, readContractState, mineWhile,
} = require('../mirrorDrillFixture')
const { findEmittedAttestRequest, waitForMirrorRowEverywhere, waitForAppliedEverywhere, widenArithmetic } = require('../mirrorDrillWaits')
const vmHelper = require('../../helpers/vmHelper')

const BUILD_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const LABEL = 'at4corpus'
const CONTEXT_TAG = 'ctx-at4corpus'
const FIXED_BODY = '{"score":42,"meta":"at4-corpus"}'
// AT1's http_get window and burial: the registry caps http_get at 100 blocks, and the hubs
// fetch only once the request is buried by their confirmations.
const DEADLINE_BLOCKS = 60
const BURIAL_BLOCKS = 6
// Blocks mined past the apply so the corpus tip clears the admission height by enough
// for H to sit strictly between them with room on either side.
const TAIL_BLOCKS = 6
const SEEDER = require.resolve('../../tools/reseedAttestationRoster.test/01_seed_the_attestation_roster_on_a_reset_chain.test')

describe('AT4 corpus prologue: the seated roster is adoptable, seeded only when it is not', function () {
    this.timeout(0)

    before(async function () {
        try {
            await provisionDrillIdentities({ label: LABEL, count: 5, redundancy: 3 })
        } catch (e) {
            console.log('AT4 corpus: the seated roster cannot be adopted, so the roster seeder runs: ' + ((e && e.message) || e))
            return
        }
        console.log('AT4 corpus: the seated roster is already adoptable; the seeder is skipped')
        this.skip()
    })

    // Registered inside this suite so the seeder's case runs first and only under the
    // skip above. A module already in the cache was loaded by a seeder file named on the
    // same mocha run, which registered its case at the root already; loading it twice would
    // stake twice.
    if (!require.cache[SEEDER]) require(SEEDER)
})

describe('AT4 corpus: a federation-signed admission-era mirror row, applied at its height on both armed indexers', function () {
    this.timeout(Math.max(drive.LEG_FLOOR_MS, 45 * 60 * 1000))

    const ctx = { venue: null, btc: null, coin: 'BTC', server: null, contract: null, requestId: null, admission: null, applied: null }

    before(async function () {
        const vm = drive.vmLinkProblem(BUILD_ROOT)
        assert.strictEqual(vm, null, 'FAILED DRIVE: ' + vm)
        // REAL TLS: the provider refuses a non-https payload before any network work.
        ctx.server = await startAttestTestServer({ body: FIXED_BODY })
        const staked = await provisionDrillIdentities({ label: LABEL, count: 5, redundancy: 3 })
        const up = await drive.bootFamilyVenue({
            label: LABEL, repoRoot: BUILD_ROOT, armed: [0, 1], armHubs: true,
            venue: { identities: staked.identities, needsLlm: false, hubExtraEnv: Object.assign({}, ctx.server.hubEnv) },
        })
        Object.assign(ctx, up, { coin: up.evidence.coinCode })
        ctx.contract = await deployRequestContract({ label: LABEL + 'http', code: rows.attestRequestContractCode(DEADLINE_BLOCKS, CONTEXT_TAG) })
    })

    after(async function () {
        if (ctx.server) await ctx.server.close()
        if (ctx.venue) await ctx.venue.stop()
    })

    it('finalizes a signed response whose mirror row carries the admission height on both mirrors', async function () {
        await finalizeSignedRow(ctx)
    })

    it('applies it with no transaction at its admission height on both armed indexers', async function () {
        await applyAtAdmitHeight(ctx)
    })

    it('levels the corpus past the admission height and prints the replay witness command', async function () {
        await printWitnessCommand(ctx)
    })
})

// AT1's request path: execute `ask`, find the emitted request by its action, bury it, and
// wait for the row on both mirrors. The admission facts are read beside AT1's row read,
// which does not select the admission column.
async function finalizeSignedRow (ctx) {
    assert.ok(ctx.contract, 'AT4 corpus: no request contract was deployed')
    const exec = await mineWhile(() => vmHelper.sendExecuteV0(ctx.contract.owner, ctx.contract.contractIndex, 'ask', ['http_get', ctx.server.url]))
    assert.strictEqual(exec.execution.status, 'valid', 'the EXECUTE that emits the request came back ' + exec.execution.status)
    const request = await findEmittedAttestRequest(ctx.contract.contractIndex, exec.execution.action_index, { label: 'http_get' })
    ctx.requestId = request.requestId
    await regtestMinerConnector.generateBlocks(BURIAL_BLOCKS)
    await settleStack()
    const rowsPerIndexer = await waitForMirrorRowEverywhere(ctx.venue, ctx.requestId)
    for (const [i, row] of rowsPerIndexer.entries()) {
        assert.strictEqual(String(row.status), 'ok', 'mirror row status is ' + row.status + ' on indexer ' + i)
    }
    assert.strictEqual(rowsPerIndexer[0].response_hash, rowsPerIndexer[1].response_hash, 'the two mirrors hold different response hashes')
    ctx.admission = await drive.readAdmissionRows(ctx.venue, ctx.requestId, ctx.coin)
    const pre = rows.admitHeightApplyFindings(ctx.admission.column, ctx.admission.rows, [])
    assert.deepStrictEqual(pre.findings, [], 'the finalized row is not a signed admission-era corpus row: ' + JSON.stringify(ctx.admission.rows))
    console.log('AT4 corpus: request ' + ctx.requestId + ' finalized, ' + ctx.admission.column + '=' + pre.admitHeight)
}

// The apply wait mines, capped inside the request's own window so an expiry never
// stands in for an applier verdict; then every AT1 claim about the apply, plus the height.
async function applyAtAdmitHeight (ctx) {
    assert.ok(ctx.requestId && ctx.admission, 'AT4 corpus: no finalized request to apply')
    const onChain = await indexerDatabase.checkAttestationResponse({ requestId: ctx.requestId }).catch(() => null)
    assert.strictEqual(onChain, null, 'the standing indexer holds an on-chain ATTEST v1 row for ' + ctx.requestId)
    const cap = Math.max(1, widenArithmetic(DEADLINE_BLOCKS).safeCap - BURIAL_BLOCKS)
    ctx.applied = await waitForAppliedEverywhere(ctx.venue, ctx.requestId, null, { mineWhileWaiting: { perPoll: 1, maxBlocks: cap } })
    // Re-read: a second leader slot can add a row between the finalize and the apply.
    ctx.admission = await drive.readAdmissionRows(ctx.venue, ctx.requestId, ctx.coin)
    const got = rows.admitHeightApplyFindings(ctx.admission.column, ctx.admission.rows, ctx.applied)
    console.log('AT4 corpus apply: ' + JSON.stringify({ admitHeight: got.admitHeight, applied: ctx.applied.map((a) => a && ({ block_index: a.block_index, action_index: a.action_index })) }))
    assert.deepStrictEqual(got.findings, [], 'the response was not applied at its admission height on both armed indexers')
    ctx.admitHeight = got.admitHeight
    const state = await readContractState(ctx.venue, ctx.venue.indexers[0].index, ctx.contract.contractIndex)
    assert.strictEqual(JSON.parse(state.callback_status), 'ok', 'callback_status is ' + state.callback_status)
    assert.strictEqual(JSON.parse(state.callback_context), CONTEXT_TAG)
    assert.strictEqual(JSON.parse(state.callback_payload), FIXED_BODY, 'the callback payload is not the body the provider served')
}

async function printWitnessCommand (ctx) {
    assert.ok(Number.isSafeInteger(ctx.admitHeight), 'AT4 corpus: no applied admission height to build a witness command on')
    await regtestMinerConnector.generateBlocks(TAIL_BLOCKS)
    await settleStack()
    const level = await drive.levelIndexers(ctx.venue)
    const corpusTip = Math.min(...level.map((s) => s.decoder))
    const coords = drive.corpusCoordinates(ctx.venue, 0, ctx.coin)
    const cmd = rows.replayWitnessCommand(Object.assign({ indexerRoot: path.join(BUILD_ROOT, 'xchain-indexer'), admitHeight: ctx.admitHeight, corpusTip }, coords))
    console.log('AT4 CORPUS ' + JSON.stringify({ requestId: ctx.requestId, admitHeight: ctx.admitHeight, corpusTip, mirrorDbs: ctx.venue.indexers.map((ix) => ix.mirrorDbName), activationHeight: cmd.activationHeight }))
    assert.deepStrictEqual(cmd.refusals, [], 'the corpus cannot be read by the replay witness')
    console.log('AT4 WITNESS COMMAND (export ' + coords.passEnv + ' first): ' + cmd.line)
}
