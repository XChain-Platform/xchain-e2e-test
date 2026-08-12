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
 * E2E test: AttestationPublisher operator-signer wiring (F13 regression)
 *
 * Finding F13: XChainHub.startAttestation() constructed AttestationPublisher
 * without wiring the HUB_SIGNER_MODULE hooks, so a real validator deployment
 * (which has no test code calling setBroadcastHook) finalized ATTEST
 * responses but queued them forever. Every other suite masked the bug by
 * injecting setBroadcastHook manually.
 *
 * This suite closes the masking gap: it boots a REAL hub (MultiValidatorHub,
 * count=1) with HUB_SIGNER_MODULE pointing at an operator-style signer
 * module, never calls any test hook setter, and asserts that:
 *   1. the publisher's hooks were wired by startAttestation() itself, and
 *   2. a finalized response actually broadcasts THROUGH the operator
 *      module's broadcast(payload) and is then removed from the WAL queue.
 *
 ********************************************************************/

const dotenv = require('dotenv')
dotenv.config()

const assert = require('assert')
const fs     = require('fs')
const os     = require('os')
const path   = require('path')

const { MultiValidatorHub } = require('../helpers/multiValidatorHubHelper')

describe('[federation] AttestationPublisher operator-signer wiring (F13)', function () {
    this.timeout(0)

    let mvh = null
    let tmpDir = null
    let savedSignerModule, savedQueuePath

    before(async function () {
        if (!process.env.HUB_DB_USER || !process.env.HUB_DB_PASS) {
            console.log('        (skipping: HUB_DB_USER/HUB_DB_PASS not set)')
            this.skip()
        }

        // Operator-style signer module in a temp dir. The hub requires it
        // in-process, so the stub records broadcasts on a global the test
        // can read back. walletSign is REQUIRED by the loader contract;
        // broadcast replaces the encoder pipeline (same shape fed-signer.js
        // uses on the live federation).
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-signer-e2e-'))
        const signerPath = path.join(tmpDir, 'stub-signer.js')
        fs.writeFileSync(signerPath, `
            'use strict';
            global.__f13SignerBroadcasts = [];
            module.exports = {
                walletSign: async (psbtHex) => psbtHex,
                broadcast:  async (payload) => {
                    global.__f13SignerBroadcasts.push(payload);
                    return { txid: 'f13e2e'.padEnd(64, '0') };
                }
            };
        `)

        savedSignerModule = process.env.HUB_SIGNER_MODULE
        savedQueuePath    = process.env.ATTESTATION_QUEUE_PATH
        process.env.HUB_SIGNER_MODULE      = signerPath
        process.env.ATTESTATION_QUEUE_PATH = path.join(tmpDir, 'attestation-queue.jsonl')

        mvh = new MultiValidatorHub({ count: 1 })
        await mvh.start()
    })

    after(async function () {
        if (savedSignerModule === undefined) delete process.env.HUB_SIGNER_MODULE
        else process.env.HUB_SIGNER_MODULE = savedSignerModule
        if (savedQueuePath === undefined) delete process.env.ATTESTATION_QUEUE_PATH
        else process.env.ATTESTATION_QUEUE_PATH = savedQueuePath

        if (mvh) await mvh.stop()
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
        delete global.__f13SignerBroadcasts
    })

    it('startAttestation() wires the operator signer into AttestationPublisher (no test hook injection)', function () {
        const publisher = mvh.hubs[0].getAttestationPublisher()
        assert.ok(publisher, 'hub should expose an AttestationPublisher')
        // These hooks must come from HUB_SIGNER_MODULE via startAttestation();
        // this suite never calls setBroadcastHook/setWalletSignHook.
        assert.strictEqual(typeof publisher.broadcastFn, 'function',
            'broadcast hook should be wired from HUB_SIGNER_MODULE (F13: was never wired)')
        assert.strictEqual(typeof publisher.walletSignFn, 'function',
            'wallet-sign hook should be wired from HUB_SIGNER_MODULE')
        assert.ok(publisher._getBroadcaster(),
            'publisher must have a broadcast pipeline at boot (F13: _getBroadcaster() was null)')
    })

    it('a finalized response broadcasts through the operator module and leaves the WAL queue', async function () {
        const publisher = mvh.hubs[0].getAttestationPublisher()
        const myPubkey  = mvh.getPubkeys()[0].toLowerCase()
        const requestId = 'f13'.padEnd(64, 'a')

        const before = (global.__f13SignerBroadcasts || []).length

        // Finalized-consensus event, with this hub as leader. request.block_index
        // is omitted so the leader comes from the event (no capability-snapshot
        // lookup needed for a single-hub harness).
        await publisher.onRequestFinalized({
            requestId:    requestId,
            providerId:   'http_get',
            responseBody: '{"f13":"e2e"}',
            status:       'ok',
            meta:         '200',
            leaderPubkey: myPubkey,
            signatures:   [{ pubkey: myPubkey, sig: 'ab'.repeat(64) }]
        })

        const broadcasts = global.__f13SignerBroadcasts || []
        assert.strictEqual(broadcasts.length, before + 1,
            'the operator module broadcast(payload) should have been invoked exactly once')
        const wire = broadcasts[broadcasts.length - 1]
        assert.ok(wire.startsWith('ATTEST|1|' + requestId + '|http_get|'),
            'broadcast payload should be the ATTEST v1 wire for this request (got: ' + wire.slice(0, 60) + '...)')

        // Successful leader broadcast drops the entry from the durable queue.
        const queueRaw = fs.readFileSync(process.env.ATTESTATION_QUEUE_PATH, 'utf8')
        assert.ok(!queueRaw.includes(requestId),
            'WAL queue entry should be removed after a successful broadcast')
    })
})
