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
 * SERIALIZED, not parallel. This drill does not stake: it ADOPTS the standing
 * regtest roster, giving every seated key one of this venue's hubs so the draw is
 * venue-only by construction. Two live venues would therefore run hubs for the
 * SAME identities and be each other's equivocation, and a roll-call drive must
 * not overlap one either.
 ********************************************************************/

const assert = require('assert')
const dotenv = require('dotenv')
dotenv.config()

const fs = require('fs')
const { AttestMirrorVenue, assertLlmAvailable } = require('../helpers/attestMirrorVenue')
const {
    provisionDrillIdentities, startAttestTestServer, deployRequestContract, settleStack,
    readAppliedResponse, readContractState,
} = require('./mirrorDrillFixture')
const {
    findEmittedAttestRequest, waitForMirrorRowEverywhere,
} = require('./mirrorDrillWaits')
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
    // Roster adoption, five hub processes, two indexers bootstrapping schemas,
    // then a PBFT round per provider.
    this.timeout(45 * 60 * 1000)

    let venue      = null
    let up         = false
    let testServer = null
    let testUrl    = null
    let contracts  = null
    let llm        = { ok: false, why: 'not probed' }

    before(async function () {
        llm = llmRunnableHere()
        if (!llm.ok) console.log('AT1: the llm case will SKIP on this box.\n' + llm.why)

        // REAL TLS, not http. The provider refuses a non-https payload before it
        // does any network work, so a plain-HTTP server here resolves every round
        // provider_error, which reads downstream as a missing mirror row.
        testServer = await startAttestTestServer({ body: FIXED_BODY })
        testUrl    = testServer.url

        // Staked BEFORE the venue exists, because the venue takes the identities
        // and expects them already selectable.
        const staked = await provisionDrillIdentities({ label: 'at1', count: 5, redundancy: 3 })

        // needsLlm only when this box can actually serve it. Declared
        // unconditionally it refuses the whole drill, http_get included, on every
        // box we have; probed, the venue still refuses if the probe and the
        // reality ever disagree, because start() re-checks with the same
        // predicate rather than trusting this flag.
        venue = new AttestMirrorVenue({
            label: 'at1', identities: staked.identities, needsLlm: llm.ok,
            hubExtraEnv: testServer.hubEnv,
        })
        up = await venue.start()
        if (!up) {
            console.log('AT1 SKIPPED: ' + venue.unavailable)
            this.skip()
        }

        // ONE CONTRACT PER PROVIDER, and this is a correctness requirement rather
        // than tidiness.
        //
        // THE RULE: two executions of the SAME method by the SAME caller on ONE
        // contract cannot be told apart by `sendExecuteV0`'s no-txHash fallback,
        // which searches on (contractIndex, caller, methodName, status) alone.
        // When the strict-txHash wait times out, that fallback returns whichever
        // execution it finds first, which is the EARLIER one, and any correlation
        // built on the returned action_index then resolves the earlier REQUEST
        // faithfully and wrongly. A drill in that state asserts against a request
        // it did not create, so it can pass or fail for a reason unrelated to
        // what it is testing.
        //
        // A contract each makes the fallback unambiguous by construction: one
        // execution of `ask` per contractIndex leaves it nothing to confuse.
        // Cheaper alternative worth knowing for a drill that executes many times:
        // read MAX(action_index) of that contract's v0 rows BEFORE broadcasting
        // and correlate above that watermark, which removes the ambiguity at the
        // source and costs no extra deploy. A watermark read must REFUSE on
        // failure rather than defaulting to zero, since zero re-admits every
        // earlier request as a candidate.
        //
        // A contract each makes the fallback unambiguous by construction: one
        // execution of `ask` per contractIndex, so there is nothing for it to
        // confuse. Cheaper and more durable than teaching the shared helper to
        // disambiguate, which is every e2e suite's code.
        contracts = {
            http_get: await deployRequestContract({ label: 'at1http', code: CONTRACT_CODE }),
            llm:      await deployRequestContract({ label: 'at1llm',  code: CONTRACT_CODE }),
        }
    })

    after(async function () {
        if (testServer) await testServer.close()
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
        // This provider's OWN contract, so the shared helper's ambiguous
        // fallback has exactly one execution of `ask` to find here.
        const contract = contracts[providerId]
        assert.ok(contract, 'AT1: no contract deployed for provider ' + providerId)

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
        // WAITED FOR, NOT READ ONCE, and this was a real defect rather than a
        // tidy-up. The previous form mined past the hubs' confirmation depth and
        // then read the mirror IMMEDIATELY, giving the round no time at all: the
        // hubs poll rather than subscribe, then fetch from the provider, then run
        // PROPOSE/PREPARE/COMMIT across three processes, then write and gossip
        // the row, which the indexers then have to stream and clear their barrier
        // on. That is tens of seconds on a good run. The bare read therefore
        // reported "0 mirror rows" for a round that was working correctly and
        // simply had not finished, which is indistinguishable in the failure
        // output from a mirror that never delivered.
        //
        // The shared helper is what the other drills already use, and it also
        // captures the federation state before AND after, so the responsible set
        // is recorded while the request is still pending, which is the only
        // moment it can be read at all.
        const rowsPerIndexer = await waitForMirrorRowEverywhere(venue, requestId, null, {
            // MINES WHILE WAITING: the responsible-set widening ladder is
            // height-driven, so a still chain sits at widen 0 for the whole
            // budget and a round that needs one more slot never gets it.
            mineWhileWaiting: 40,
        })

        for (const [i, row] of rowsPerIndexer.entries()) {
            assert.strictEqual(String(row.status), 'ok',
                providerId + ': mirror row status is ' + row.status + ' on indexer ' + i +
                ', so the round finalized a NON-OK outcome rather than failing to deliver. ' +
                'provider_error means the fetch itself failed and the hub logs say why.')
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
