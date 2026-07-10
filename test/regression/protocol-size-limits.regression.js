'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// ═══════════════════════════════════════════════════════════════════════════
// Protocol size-limit drift guard
//
// Several services independently declare the same protocol-level size caps.
// They have drifted before: most notably the ACTION data cap, where the
// encoder accepted compiled payloads the decoder silently dropped (an 8190–8192
// byte payload compiles to an 8193–8195 byte on-chain push, which the encoder
// once permitted but the decoder always dropped). These tests assert every
// service's local copy matches the canonical protocol constant, so the limits
// can never silently diverge again.
// ═══════════════════════════════════════════════════════════════════════════

const assert  = require('assert')
const fs      = require('fs')
const path    = require('path')
const bitcoin = require('bitcoinjs-lib')

const protocol = require('../../../xchain-documentation/protocol/constants.js')

const encoderValidator = require('../../../xchain-encoder/src/validator.js')
const XChainDecoder     = require('../../../xchain-decoder/src/XChainDecoder.js')
const sdkValidator      = require('../../../xchain-sdk/src/validator.js')
const indexerDeploy     = require('../../../xchain-indexer/src/actions/deploy.js')
const indexerXcall      = require('../../../xchain-indexer/src/actions/xcall.js')
const indexerXexec      = require('../../../xchain-indexer/src/actions/xexec.js')
const hubConstants      = require('../../../xchain-hub/src/constants.js')
const XChainVM          = require('../../../xchain-vm/src/index.js')

// The indexer's execute.js re-validates VM_MAX_CALL_DEPTH/VM_MIN_CALL_GAS host-side
// as literal `const`s, not module exports, so pull the declared values by scanning
// the source text (mirrors how a drift guard must read an un-exported copy).
function readIndexerExecuteCallCaps() {
    const src = fs.readFileSync(
        path.join(__dirname, '../../../xchain-indexer/src/actions/execute.js'), 'utf8')
    const depthMatch = src.match(/const\s+MAX_CALL_DEPTH\s*=\s*(\d+)/)
    const gasMatch   = src.match(/const\s+MIN_CALL_GAS\s*=\s*(\d+)/)
    assert.ok(depthMatch, 'could not find indexer execute.js MAX_CALL_DEPTH declaration')
    assert.ok(gasMatch, 'could not find indexer execute.js MIN_CALL_GAS declaration')
    return { MAX_CALL_DEPTH: Number(depthMatch[1]), MIN_CALL_GAS: Number(gasMatch[1]) }
}

describe('Protocol size-limit drift guard', () => {

    describe('ACTION data cap (root cause behind the encoder/decoder silent-drop gap)', () => {

        it('[regression:p0] encoder compiled-push cap === decoder cap === canonical', () => {
            assert.strictEqual(
                encoderValidator.MAX_COMPILED_ACTION_DATA_LENGTH,
                protocol.MAX_ACTION_DATA_LENGTH,
                'encoder MAX_COMPILED_ACTION_DATA_LENGTH drifted from the canonical protocol constant'
            )
            assert.strictEqual(
                XChainDecoder.MAX_ACTION_DATA_LENGTH,
                protocol.MAX_ACTION_DATA_LENGTH,
                'decoder MAX_ACTION_DATA_LENGTH drifted from the canonical protocol constant'
            )
            // The invariant that #804 was about: what the encoder is willing to
            // produce must equal what the decoder is willing to accept.
            assert.strictEqual(
                encoderValidator.MAX_COMPILED_ACTION_DATA_LENGTH,
                XChainDecoder.MAX_ACTION_DATA_LENGTH,
                'encoder accepts a different compiled ACTION size than the decoder; payloads in the gap would be silently dropped on chain'
            )
        })

        it('[regression:p0] no compiled-size gap between encoder and decoder at the boundary', () => {
            const limit    = protocol.MAX_ACTION_DATA_LENGTH                       // 8192 compiled
            const overhead = protocol.OP_RETURN_PUSH_OVERHEAD                      // 3
            const maxPayload = limit - overhead                                   // 8189 decoded

            // Largest accepted payload: compiles to exactly the limit.
            const atLimit = bitcoin.script.compile([Buffer.alloc(maxPayload, 0x41)])
            assert.strictEqual(atLimit.length, limit,
                `a ${maxPayload}-byte payload should compile to exactly ${limit} bytes`)
            assert.ok(atLimit.length <= encoderValidator.MAX_COMPILED_ACTION_DATA_LENGTH,
                'encoder must accept the at-limit payload')
            assert.ok(atLimit.length <= XChainDecoder.MAX_ACTION_DATA_LENGTH,
                'decoder must accept the at-limit payload')

            // One byte over: must be rejected by BOTH sides (no silent-drop window).
            const overLimit = bitcoin.script.compile([Buffer.alloc(maxPayload + 1, 0x41)])
            assert.ok(overLimit.length > encoderValidator.MAX_COMPILED_ACTION_DATA_LENGTH,
                'encoder must reject the over-limit payload')
            assert.ok(overLimit.length > XChainDecoder.MAX_ACTION_DATA_LENGTH,
                'decoder must reject the over-limit payload; otherwise the encoder could mint a tx the decoder drops')
        })
    })

    describe('Contract code-size cap (MAX_CODE_SIZE)', () => {

        it('[regression:p0] SDK MAX_CODE_SIZE === canonical', () => {
            assert.strictEqual(
                sdkValidator.MAX_CODE_SIZE,
                protocol.MAX_CODE_SIZE,
                'SDK MAX_CODE_SIZE drifted from the canonical protocol constant; the indexer (DEPLOY) and VM isolate limit must also stay equal to this value'
            )
        })

        it('[regression:p0] indexer DEPLOY MAX_CODE_SIZE === canonical', () => {
            // The indexer is the on-chain arbiter for contract code size. It
            // rejects any DEPLOY whose code exceeds this. If it drifts below the
            // SDK/encoder, a contract the SDK accepts would be rejected on chain.
            assert.strictEqual(
                indexerDeploy.MAX_CODE_SIZE,
                protocol.MAX_CODE_SIZE,
                'indexer DEPLOY MAX_CODE_SIZE drifted from the canonical protocol constant'
            )
        })

        it('[regression:p0] VM isolate maxCodeSize === canonical', () => {
            assert.strictEqual(
                XChainVM.MAX_CODE_SIZE,
                protocol.MAX_CODE_SIZE,
                'VM isolate code-size limit drifted from the canonical protocol constant'
            )
        })
    })

    describe('FIAT_CODE allow-list (PRICE actions)', () => {

        it('[regression:p0] SDK VALID_FIAT_CODES === canonical', () => {
            // The indexer's config.FIATS keys are the on-chain arbiter for PRICE
            // FIAT_CODE; the canonical list mirrors them. The SDK validator must be a
            // byte-equal allow-list or it silently refuses a FIAT the chain accepts
            // (it drifted once, missing EUR and KRW). This guard makes that recur loudly.
            assert.deepStrictEqual(
                sdkValidator.VALID_FIAT_CODES,
                protocol.VALID_FIAT_CODES,
                'SDK VALID_FIAT_CODES drifted from the canonical FIAT allow-list (indexer config.FIATS is the arbiter)'
            )
        })
    })

    describe('Gas token TICK (GAS_TICK)', () => {

        // The indexer's config['GAS'] names the token debited for capability STAKE,
        // VOTE deposits/escrows, and contract gas billing. The SDK co-signer policy
        // engine keys capability-STAKE spending caps to its own mirror of this tick
        // (STAKE v1/v2 carry no TICK field). If either copy drifted from consensus,
        // gas-scoped caps would silently stop binding STAKE.
        const indexerConfig = require('../../../xchain-indexer/src/config.js')
        const sdkPolicy     = require('../../../xchain-sdk/src/cosigner/policyEvaluator.js')

        it('[regression:p0] indexer GAS_TICK === canonical', () => {
            assert.strictEqual(
                indexerConfig.GAS_TICK,
                protocol.GAS_TICK,
                'indexer GAS_TICK drifted from the canonical protocol constant'
            )
        })

        it('[regression:p0] SDK co-signer GAS_TICK === canonical', () => {
            assert.strictEqual(
                sdkPolicy.GAS_TICK,
                protocol.GAS_TICK,
                'SDK co-signer GAS_TICK drifted from the canonical protocol constant (capability-STAKE caps would stop binding)'
            )
        })
    })

    describe('XCALL consensus bounds (indexer is the arbiter)', () => {

        // The indexer xcall.js values gate cross-chain calls on chain. They are
        // literal-copied into the canonical module; assert they have not drifted.
        const XCALL_FIELDS = [
            'XCALL_MIN_GAS', 'XCALL_MAX_GAS', 'XCALL_MAX_HOPS',
            'XCALL_MIN_DEADLINE_BLOCKS', 'XCALL_MAX_DEADLINE_BLOCKS', 'XCALL_MAX_CALLS_PER_BLOCK',
        ]
        XCALL_FIELDS.forEach((field) => {
            it('[regression:p0] indexer ' + field + ' === canonical', () => {
                assert.strictEqual(
                    indexerXcall[field],
                    protocol[field],
                    'indexer ' + field + ' drifted from the canonical protocol constant'
                )
            })
        })

        // The hub keeps its own defense-in-depth copy (CrossChainCallEngine.js
        // rejects any relay whose cross_hops exceeds it before ever reaching the
        // indexer arbiter). If the hub relaxed while the indexer stayed strict, the
        // hub would PBFT-sign a relay row the indexer then rejects (wasted round).
        it('[regression:p0] hub XCALL_MAX_HOPS === canonical (uuid 74e6/332)', () => {
            assert.strictEqual(
                hubConstants.XCALL_MAX_HOPS,
                protocol.XCALL_MAX_HOPS,
                'hub XCALL_MAX_HOPS drifted from the canonical protocol constant'
            )
        })

        // XCALL_MAX_RETURN_BYTES is enforced in a different indexer module
        // (xexec.js, not xcall.js): an oversize return becomes status
        // 'payload_too_large' with an empty payload. Asserted separately since it
        // does not live on indexerXcall (uuid 333).
        it('[regression:p0] indexer xexec XCALL_MAX_RETURN_BYTES === canonical (uuid 333)', () => {
            assert.strictEqual(
                indexerXexec.XCALL_MAX_RETURN_BYTES,
                protocol.XCALL_MAX_RETURN_BYTES,
                'indexer xexec.js XCALL_MAX_RETURN_BYTES drifted from the canonical protocol constant'
            )
        })
    })

    describe('VM call-depth / call-gas consensus bounds (VM emit-time vs indexer re-validation)', () => {

        // VM_MAX_CALL_DEPTH / VM_MIN_CALL_GAS are literal-copied into the VM
        // (emit-time enforcement, now exported) and the indexer's host-side
        // re-validation copy (inline consts in execute.js, read via source scan
        // since they are not exported). A drift between VM emit-time and indexer
        // re-validation would fork execution outcomes (uuid 334).
        it('[regression:p0] VM MAX_CALL_DEPTH / MIN_CALL_GAS === canonical', () => {
            assert.strictEqual(
                XChainVM.MAX_CALL_DEPTH,
                protocol.VM_MAX_CALL_DEPTH,
                'VM MAX_CALL_DEPTH drifted from the canonical VM_MAX_CALL_DEPTH protocol constant'
            )
            assert.strictEqual(
                XChainVM.MIN_CALL_GAS,
                protocol.VM_MIN_CALL_GAS,
                'VM MIN_CALL_GAS drifted from the canonical VM_MIN_CALL_GAS protocol constant'
            )
        })

        it('[regression:p0] indexer execute.js re-validation MAX_CALL_DEPTH / MIN_CALL_GAS === canonical', () => {
            const indexerCaps = readIndexerExecuteCallCaps()
            assert.strictEqual(
                indexerCaps.MAX_CALL_DEPTH,
                protocol.VM_MAX_CALL_DEPTH,
                'indexer execute.js MAX_CALL_DEPTH drifted from the canonical VM_MAX_CALL_DEPTH protocol constant'
            )
            assert.strictEqual(
                indexerCaps.MIN_CALL_GAS,
                protocol.VM_MIN_CALL_GAS,
                'indexer execute.js MIN_CALL_GAS drifted from the canonical VM_MIN_CALL_GAS protocol constant'
            )
        })
    })

    describe('Chunked DEPLOY caps (MAX_DEPLOY_CHUNKS / MAX_DEPLOYCHUNK_PART_BYTES)', () => {

        const chunkHelper        = require('../../../xchain-sdk/src/chunkHelper.js')
        const indexerDeployChunk = require('../../../xchain-indexer/src/actions/deploy_chunk.js')

        it('[regression:p0] MAX_DEPLOY_CHUNKS === canonical across SDK + indexer', () => {
            assert.strictEqual(chunkHelper.MAX_DEPLOY_CHUNKS, protocol.MAX_DEPLOY_CHUNKS,
                'SDK chunkHelper MAX_DEPLOY_CHUNKS drifted from the canonical protocol constant')
            assert.strictEqual(indexerDeploy.MAX_DEPLOY_CHUNKS, protocol.MAX_DEPLOY_CHUNKS,
                'indexer DEPLOY MAX_DEPLOY_CHUNKS drifted from the canonical protocol constant')
            assert.strictEqual(indexerDeployChunk.MAX_DEPLOY_CHUNKS, protocol.MAX_DEPLOY_CHUNKS,
                'indexer v4-carrier MAX_DEPLOY_CHUNKS drifted from the canonical protocol constant')
        })

        it('[regression:p0] MAX_DEPLOYCHUNK_PART_BYTES === canonical across SDK + indexer', () => {
            assert.strictEqual(chunkHelper.MAX_DEPLOYCHUNK_PART_BYTES, protocol.MAX_DEPLOYCHUNK_PART_BYTES,
                'SDK chunkHelper MAX_DEPLOYCHUNK_PART_BYTES drifted from the canonical protocol constant')
            assert.strictEqual(indexerDeployChunk.MAX_DEPLOYCHUNK_PART_BYTES, protocol.MAX_DEPLOYCHUNK_PART_BYTES,
                'indexer v4-carrier MAX_DEPLOYCHUNK_PART_BYTES drifted from the canonical protocol constant')
        })

        it('[regression:p0] a max-size v4-carrier part + action overhead fits the compiled cap', () => {
            // The per-chunk budget must leave room for the DEPLOY v4 carrier action overhead
            // (prefix + 64-char CODE_HASH + indices) under MAX_ACTION_DATA_LENGTH, or a
            // full-size chunk the SDK produces would be silently dropped by the decoder.
            const worst = 'DEPLOY|4|' + 'f'.repeat(64) + '|15|16|' + 'A'.repeat(protocol.MAX_DEPLOYCHUNK_PART_BYTES)
            assert.ok(Buffer.byteLength(worst, 'utf8') + protocol.OP_RETURN_PUSH_OVERHEAD <= protocol.MAX_ACTION_DATA_LENGTH,
                'a max-size DEPLOY v4 carrier part + overhead exceeds MAX_ACTION_DATA_LENGTH')
        })
    })
})
