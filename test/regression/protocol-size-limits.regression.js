'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

// ═══════════════════════════════════════════════════════════════════════════
// Protocol size-limit drift guard
//
// Several services independently declare the same protocol-level size caps.
// They have drifted before — most notably the ACTION data cap, where the
// encoder accepted compiled payloads the decoder silently dropped (an 8190–8192
// byte payload compiles to an 8193–8195 byte on-chain push, which the encoder
// once permitted but the decoder always dropped). These tests assert every
// service's local copy matches the canonical protocol constant, so the limits
// can never silently diverge again.
// ═══════════════════════════════════════════════════════════════════════════

const assert  = require('assert')
const bitcoin = require('bitcoinjs-lib')

// Canonical source of truth.
const protocol = require('../../../xchain-documentation/protocol/constants.js')

// Each service's local declaration.
const encoderValidator = require('../../../xchain-encoder/src/validator.js')
const XChainDecoder     = require('../../../xchain-decoder/src/XChainDecoder.js')
const sdkValidator      = require('../../../xchain-sdk/src/validator.js')
const indexerDeploy     = require('../../../xchain-indexer/src/actions/deploy.js')
const XChainVM          = require('../../../xchain-vm/src/index.js')

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
                'encoder accepts a different compiled ACTION size than the decoder — payloads in the gap would be silently dropped on chain'
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
                'decoder must reject the over-limit payload — otherwise the encoder could mint a tx the decoder drops')
        })
    })

    describe('Contract code-size cap (MAX_CODE_SIZE)', () => {

        it('[regression:p0] SDK MAX_CODE_SIZE === canonical', () => {
            assert.strictEqual(
                sdkValidator.MAX_CODE_SIZE,
                protocol.MAX_CODE_SIZE,
                'SDK MAX_CODE_SIZE drifted from the canonical protocol constant — the indexer (DEPLOY) and VM isolate limit must also stay equal to this value'
            )
        })

        it('[regression:p0] indexer DEPLOY MAX_CODE_SIZE === canonical', () => {
            // The indexer is the on-chain arbiter for contract code size — it
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
})
