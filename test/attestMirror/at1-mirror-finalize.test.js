'use strict'

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
 * AT1: a response finalizes over P2P and reaches the chain's readers without a
 * transaction of its own.
 *
 * The spec's own test, verbatim in intent: an `http_get` and an `llm` request
 * finalize over P2P, the encoder records ZERO transactions for either response,
 * the callback fires on BOTH indexers at the block §4.1 predicts, contract state
 * carries the payload, and the synthetic v1 action has a NULL `tx_index` and the
 * deterministic hash.
 *
 * WHAT MAKES THIS DIFFERENT FROM THE FEDERATION DRILLS. multiHubAttestation
 * proves the same request reaches a callback; it does so through an on-chain
 * ATTEST v1 that the leader broadcasts. Here that transaction must NOT EXIST,
 * so every assertion the older drill makes against a transaction-backed row has
 * to be re-aimed, and the interesting half of this test is the absence.
 *
 * ZERO TRANSACTIONS IS ASSERTED FROM TWO INDEPENDENT DIRECTIONS, because one of
 * them alone can pass for the wrong reason:
 *
 *   - The STANDING indexer indexes the same chain the venue borrows, so if any
 *     ATTEST v1 had been broadcast for this request it would hold an action for
 *     it. Zero there is a statement about the chain.
 *   - The VENUE indexers hold the synthesized action, whose `tx_index` must be
 *     NULL. That is a statement about the applier.
 *
 * Checking only the second would pass on a node that applied the mirror row AND
 * a broadcast v1 landed beside it; checking only the first would pass on a node
 * that did nothing at all.
 *
 * A NOTE ON THE STANDING INDEXER, measured 2026-09-04 and worth re-measuring:
 * the deployed regtest indexer carries neither `ATTEST_MIRROR_RESPONSE` nor
 * `selectApplicableAttestationResponses`, i.e. no applier. That is why the
 * request stays `pending` there for the whole drill, which is what the hubs
 * need, and why NOTHING here waits on the standing indexer for a fulfilled
 * request: it would wait forever and read as a consensus failure. Every
 * positive assertion reads a VENUE indexer.
 *
 * SERIALIZED, not parallel. The venue does not stake; this drill stakes into the
 * one standing regtest roster, so two live venues are each other's pollution and
 * the symptom is a wrong responsible set rather than an obvious clash.
 ********************************************************************/

const assert = require('assert')
const http   = require('http')
const dotenv = require('dotenv')
dotenv.config()

const fs = require('fs')
const { AttestMirrorVenue, assertLlmAvailable } = require('../helpers/attestMirrorVenue')
const {
    stakeDrillIdentities, deployRequestContract, settleStack,
    readAppliedResponse, readContractState,
} = require('./mirrorDrillFixture')
const { findEmittedAttestRequest, captureFederationState } = require('./mirrorDrillWaits')
const vmHelper = require('../helpers/vmHelper')

// The applier's own synthesis, imported rather than reimplemented: the hash is
// consensus, and a literal typed here would agree with a broken applier that
// changed both sides together.
const { synthesizeTxHash, SYNTH_TAGS } = require('../../../xchain-indexer/src/actions/execContext.js')

const FIXED_BODY = '{"score":42,"meta":"at1-mirror"}'

// Generous on purpose. The standing indexer's expiry sweep fires at
// deadline_block + 1 and would mark the request expired mid-drill; that is
// harmless to the venue but pure noise in the logs at the moment something else
// is being diagnosed.
const DEADLINE_BLOCKS = 60

const CONTRACT_CODE = `
module.exports = {
    ask: function(xchain) {
        var requestId = xchain.attestation.request(
            xchain.getInputParam(0),
            xchain.getInputParam(1),
            'handleResponse',
            ['ctx-at1'],
            { redundancy: 3, deadlineBlocks: ${DEADLINE_BLOCKS} }
        );
        xchain.state.set('pending_request_id', requestId);
        return requestId;
    },
    handleResponse: function(xchain) {
        xchain.state.set('callback_request_id',  xchain.getInputParam(0));
        xchain.state.set('callback_provider_id', xchain.getInputParam(1));
        xchain.state.set('callback_status',      xchain.getInputParam(2));
        xchain.state.set('callback_payload',     xchain.getInputParam(3));
        xchain.state.set('callback_context',     xchain.getInputParam(4));
    }
};
`

/**
 * Can THIS box serve the llm provider, asked with the venue's own predicate?
 *
 * Asked rather than assumed because the two halves the provider needs live on
 * different boxes today: the workstation has the `claude` binary and no
 * credential directory, the venue box has the directory and keeps the binary off
 * a non-interactive PATH, and the shared harness .env names a path that is only
 * correct on one of them. Declaring needsLlm unconditionally therefore refuses
 * the WHOLE drill on either box, including the http_get half that needs no
 * credentials at all.
 *
 * So the drill degrades honestly instead: http_get runs anywhere, llm runs where
 * it can and SKIPS WITH THE REASON where it cannot. The skip is loud and names
 * the missing half, because a silent skip here would let AT1 report green while
 * proving half of what it claims. AT1 is not satisfied until both have run
 * somewhere, and the frontier says so rather than counting this file's exit code.
 *
 * The probe uses `assertLlmAvailable` and the same two predicates the venue
 * passes it, so this can never disagree with the refusal it is trying to
 * anticipate.
 */
function llmRunnableHere () {
    const dir = process.env.HUB_CLAUDE_CONFIG_DIR || null
    try {
        assertLlmAvailable({ claudeConfigDir: dir, pathEnv: process.env.PATH }, {
            dirExists: (p) => { try { return fs.statSync(p).isDirectory() } catch (_) { return false } },
            isExecutable: (p) => { try { fs.accessSync(p, fs.constants.X_OK); return true } catch (_) { return false } },
        })
        return { ok: true, why: null }
    } catch (e) {
        return { ok: false, why: (e && e.message) || String(e) }
    }
}

describe('AT1: an ATTEST response finalizes over P2P with no transaction of its own', function () {
    // Staking prologue, five hub processes, two indexers bootstrapping schemas,
    // then a PBFT round per provider.
    this.timeout(45 * 60 * 1000)

    let venue      = null
    let up         = false
    let httpServer = null
    let testUrl    = null
    let contract   = null
    let llm        = { ok: false, why: 'not probed' }

    before(async function () {
        llm = llmRunnableHere()
        if (!llm.ok) console.log('AT1: the llm case will SKIP on this box.\n' + llm.why)

        await new Promise((resolve) => {
            httpServer = http.createServer((_req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(FIXED_BODY)
            })
            httpServer.listen(0, '127.0.0.1', () => {
                testUrl = 'http://127.0.0.1:' + httpServer.address().port + '/score'
                resolve()
            })
        })

        // Staked BEFORE the venue exists, because the venue takes the identities
        // and expects them already selectable.
        const staked = await stakeDrillIdentities({ label: 'at1', count: 5 })

        // needsLlm only when this box can actually serve it. Declared
        // unconditionally it refuses the whole drill, http_get included, on every
        // box we have; probed, the venue still refuses if the probe and the
        // reality ever disagree, because start() re-checks with the same
        // predicate rather than trusting this flag.
        venue = new AttestMirrorVenue({
            label: 'at1', identities: staked.identities, needsLlm: llm.ok,
        })
        up = await venue.start()
        if (!up) {
            console.log('AT1 SKIPPED: ' + venue.unavailable)
            this.skip()
        }

        contract = await deployRequestContract({ label: 'at1', code: CONTRACT_CODE })
    })

    after(async function () {
        if (httpServer) await new Promise((r) => httpServer.close(() => r()))
        if (venue) await venue.stop()
    })

    /**
     * Drive one request to a finalized mirror row and an applied callback on both
     * indexers, then make every AT1 assertion about it.
     *
     * Written once and called per provider rather than duplicated, because the
     * claim is identical for both and only the request differs: a provider whose
     * body comes off the network and one whose body comes off a model must reach
     * the same tx-less settlement.
     */
    async function driveAndAssert (providerId, payload, expectBody) {
        const exec = await vmHelper.sendExecuteV0(
            contract.owner, contract.contractIndex, 'ask', [providerId, payload])
        assert.strictEqual(exec.execution.status, 'valid',
            providerId + ': the EXECUTE that emits the request came back ' + exec.execution.status +
            '. A responsible set smaller than redundancy is rejected at admission and rolls the ' +
            'EXECUTE back, so this is the shape a short stake roster takes.')

        // CORRELATED ON THE EMITTING ACTION, NOT ON THE TRANSACTION HASH. The
        // previous form filtered on `itx.hash = exec.txHash`, and for a
        // P2SH-encoded EXECUTE the broadcast txid does NOT match the on-chain
        // hash in index_transactions. That is not a theory: `sendExecuteV0`
        // carries a 5s strict-txHash wait and a 55s no-txHash fallback for
        // exactly this reason, both of this drill's EXECUTEs tripped that
        // fallback on 2026-09-04, and the llm case then died on
        // `checkAttestationRequest: GAVE UP after 60123ms` looking for a request
        // that existed. It is intermittent, decided by the encode type chosen.
        //
        // The naive repair, dropping txHash and taking a bare pending row, is
        // WORSE than the bug: `LIMIT 1` can return a STALE pending request left
        // by an earlier aborted run, and the drill would then assert against a
        // request the hubs never worked on and could pass for the wrong reason.
        const request = await findEmittedAttestRequest(
            contract.contractIndex, exec.execution.action_index, { label: providerId })
        const requestId = request.requestId

        // The hubs need the request buried by their own confirmations before they
        // fetch, and they poll rather than subscribe.
        await regtestMinerConnector.generateBlocks(6)
        await settleStack()

        // FINALIZATION IS READ OFF THE MIRROR, never off a chain row: the whole
        // claim is that no chain row exists. Both indexers, because AT1 says the
        // callback fires on both and a single-node pass would hide a
        // dissemination failure.
        // CAPTURED BEFORE THE ASSERTION, UNCONDITIONALLY, because run 3 failed
        // here with "indexer 0 holds 0 mirror rows" and the reading that decides
        // WHY could not be taken afterwards: the venue's hub DBs are disposable
        // and go with the run. A missing row has two very different causes, and
        // they are indistinguishable from the row's absence alone:
        //   - the round never finalized, because the responsible set drew a
        //     member with no live signer (the roster carries such keys, and
        //     roll-call eviction is inert here because epochs close without
        //     rolling), or
        //   - the hubs finalized and the row genuinely failed to reach the
        //     indexer, which is a real mirror defect.
        // The responsible set plus each hub's own finalization state separates
        // them. The standing hubs cannot answer this: getattestationresponsibleset
        // landed in hub 71ad2eb and that stack predates it, so only a venue hub
        // can, and only while it is up.
        const federation = await captureFederationState(venue, requestId, providerId + ':pre-assert')
        console.log('AT1 FEDERATION CAPTURE ' + JSON.stringify(federation, null, 1))

        const rowsPerIndexer = []
        for (const ix of venue.indexers) {
            const rows = await venue.readMirrorRows(ix.index, { requestId })
            assert.strictEqual(rows.length, 1,
                providerId + ': indexer ' + ix.index + ' holds ' + rows.length +
                ' mirror rows for ' + requestId + ', expected exactly 1\n' +
                venue.logTail('indexer' + ix.index))
            assert.strictEqual(String(rows[0].status), 'ok',
                providerId + ': mirror row status is ' + rows[0].status + ' on indexer ' + ix.index)
            rowsPerIndexer.push(rows[0])
        }

        // Both indexers followed DIFFERENT hubs, so identical rows here is the
        // dissemination claim and not a re-read of one source.
        assert.strictEqual(rowsPerIndexer[0].response_hash, rowsPerIndexer[1].response_hash,
            providerId + ': the two indexers hold different response hashes, so the federation ' +
            'did not converge on one response')

        // ZERO TRANSACTIONS, DIRECTION 1: the chain itself. The standing indexer
        // indexes the same chain, so a broadcast v1 would be an action here.
        const onChain = await indexerDatabase.checkAttestationResponse({ requestId }).catch(() => null)
        assert.strictEqual(onChain, null,
            providerId + ': the standing indexer holds an on-chain ATTEST v1 row for ' + requestId +
            ' (action ' + (onChain && onChain.action_index) + '). The whole point of the mirror is ' +
            'that a validator pays for no such transaction, so any row here is a regression in the ' +
            "publisher's per-request decline rather than a test problem.")

        // ZERO TRANSACTIONS, DIRECTION 2: the applier's own row, on both nodes.
        const expectedHash = synthesizeTxHash(
            SYNTH_TAGS.ATTEST_MIRROR_RESPONSE, NETWORK, COIN.toUpperCase(), requestId)
        for (const ix of venue.indexers) {
            const applied = await readAppliedResponse(venue, ix.index, requestId)
            assert.ok(applied,
                providerId + ': indexer ' + ix.index + ' never applied the mirror row\n' +
                venue.logTail('indexer' + ix.index))
            assert.strictEqual(applied.tx_index, null,
                providerId + ': the synthesized action on indexer ' + ix.index + ' carries tx_index ' +
                applied.tx_index + ' rather than NULL, so something gave it a transaction')
            assert.strictEqual(String(applied.tx_hash), expectedHash,
                providerId + ': synthetic TX_HASH on indexer ' + ix.index + ' is ' + applied.tx_hash +
                ' but the applier derives ' + expectedHash + " from its own tag, network and request id. " +
                'Every node must derive the same value or anything the callback emits gets ids that ' +
                'resolve differently per node.')
        }

        // The callback fired, and the contract carries what the provider returned.
        const state = await readContractState(venue, venue.indexers[0].index, contract.contractIndex)
        assert.strictEqual(JSON.parse(state.callback_status), 'ok',
            providerId + ': callback_status is ' + state.callback_status)
        assert.strictEqual(JSON.parse(state.callback_context), 'ctx-at1')
        assert.strictEqual(JSON.parse(state.callback_provider_id), providerId)
        expectBody(JSON.parse(state.callback_payload))

        return { requestId, appliedBlock: rowsPerIndexer[0] }
    }

    it('settles an http_get request with no transaction, on both indexers', async function () {
        await driveAndAssert('http_get', testUrl, (body) => {
            assert.strictEqual(body, FIXED_BODY,
                'the callback payload is not the body the provider served')
        })
    })

    it('settles an llm request with no transaction, on both indexers', async function () {
        if (!llm.ok) {
            // Skipped, not passed. AT1 names both providers, so this file going
            // green with this case skipped does NOT satisfy AT1, and the reason
            // is printed above rather than left to whoever reads a pending dot.
            this.skip()
        }
        // Deterministic arithmetic so five hubs' models agree byte for byte;
        // byte-equality is what the round converges on.
        await driveAndAssert('llm', JSON.stringify({ prompt: 'What is 2+2? Reply with only the number.' }),
            (body) => {
                assert.ok(/4/.test(String(body)),
                    'the model answer does not contain 4, so the round converged on something else: ' + body)
            })
    })
})
