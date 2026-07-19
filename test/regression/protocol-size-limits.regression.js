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
const explorerVmQuery   = require('../../../xchain-explorer/src/vm-query.js')

// The indexer's execute.js re-validates VM_MAX_CALL_DEPTH/VM_MIN_CALL_GAS host-side
// as un-exported `const`s. Since  those consts derive from the vendored
// ../protocol/constants.js rather than bare literals, so assert the source is
// wired to the vendored module (no bare literal can re-enter) and read the effective
// values from that same vendored copy. Byte-identity of the vendored copy to the
// canonical source is asserted separately below.
function readIndexerExecuteCallCaps() {
    const src = fs.readFileSync(
        path.join(__dirname, '../../../xchain-indexer/src/actions/execute.js'), 'utf8')
    assert.ok(/require\((['"])\.\.\/protocol\/constants(?:\.js)?\1\)/.test(src),
        'indexer execute.js no longer requires the vendored ../protocol/constants module')
    assert.ok(/MAX_CALL_DEPTH\s*=\s*[A-Za-z_$][\w$]*\.VM_MAX_CALL_DEPTH/.test(src),
        'indexer execute.js MAX_CALL_DEPTH is not derived from the vendored VM_MAX_CALL_DEPTH constant')
    assert.ok(/MIN_CALL_GAS\s*=\s*[A-Za-z_$][\w$]*\.VM_MIN_CALL_GAS/.test(src),
        'indexer execute.js MIN_CALL_GAS is not derived from the vendored VM_MIN_CALL_GAS constant')
    const vendored = require('../../../xchain-indexer/src/protocol/constants.js')
    return { MAX_CALL_DEPTH: vendored.VM_MAX_CALL_DEPTH, MIN_CALL_GAS: vendored.VM_MIN_CALL_GAS }
}

// Vendored protocol-constants byte-identity guard . Each service that
// consumes the shared protocol constants keeps a byte-identical vendored copy in
// its own src/protocol/constants.js (services ship as independent containers with
// no shared node_modules tree), and requires that copy instead of bare literals.
// Assert every vendored copy is byte-for-byte the canonical source, so an edit to
// one copy that was not propagated fails here.
const VENDORED_CONSTANTS_SERVICES = [
    'xchain-vm', 'xchain-indexer', 'xchain-sdk', 'xchain-decoder', 'xchain-explorer',
]

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

        // Previously only asserted by the explorer's own unit test
        // (xchain-explorer/test/unit/vm-query.test.js), not this central
        // tripwire; a skipped explorer suite in the cross-service CI lane
        // could let this copy drift unnoticed (uuid 269217d2).
        it('[regression:p0] explorer vm-query MAX_CODE_SIZE === canonical', () => {
            assert.strictEqual(
                explorerVmQuery.MAX_CODE_SIZE,
                protocol.MAX_CODE_SIZE,
                'explorer vm-query MAX_CODE_SIZE drifted from the canonical protocol constant; the read-only query isolate would reject (or over-accept) contract code the chain itself indexed'
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

    describe('Oracle federation bounds (hub is the arbiter)', () => {

        // PRICE_MAX and ORACLE_DEVIATION_THRESHOLD are declared only in
        // xchain-hub/src/constants.js, which exports all three (with
        // XCALL_MAX_HOPS) together. Mirrors the XCALL_MAX_HOPS parity check
        // above: assert the hub copies against the canonical documentation
        // twin so a hub-side edit or a future consumer re-declaring either
        // literal has a cross-repo tripwire (uuid 2e3ecb5b).

        it('[regression:p0] hub PRICE_MAX === canonical', () => {
            assert.strictEqual(
                hubConstants.PRICE_MAX,
                protocol.PRICE_MAX,
                'hub PRICE_MAX drifted from the canonical protocol constant'
            )
        })

        it('[regression:p0] hub ORACLE_DEVIATION_THRESHOLD === canonical', () => {
            assert.strictEqual(
                hubConstants.ORACLE_DEVIATION_THRESHOLD,
                protocol.ORACLE_DEVIATION_THRESHOLD,
                'hub ORACLE_DEVIATION_THRESHOLD drifted from the canonical protocol constant'
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

        // The VM ships an exported copy of XCALL_MAX_RETURN_BYTES too (index.js
        // declares and exports it for parity). It is informational rather than an
        // enforcement gate today, but an exported copy can drift silently, so
        // assert it against canonical alongside the indexer xexec copy (uuid a27c).
        it('[regression:p0] VM XCALL_MAX_RETURN_BYTES === canonical (uuid a27c)', () => {
            assert.strictEqual(
                XChainVM.XCALL_MAX_RETURN_BYTES,
                protocol.XCALL_MAX_RETURN_BYTES,
                'VM XCALL_MAX_RETURN_BYTES drifted from the canonical protocol constant'
            )
        })

        // The VM is the emit-time arbiter for cross-chain calls (gateway-emit.js
        // crossExecute enforces these bounds before the indexer ever sees the
        // call); the indexer re-validates the same bounds host-side. If the VM's
        // copy drifted from canonical, the VM would emit a crossExecute the
        // indexer then rejects (or vice-versa), forking cross-chain execution
        // with no failing test. This was the last unguarded copy of the XCALL
        // bound family (uuid 922e2a57).
        XCALL_FIELDS.filter((field) => field !== 'XCALL_MAX_CALLS_PER_BLOCK').forEach((field) => {
            it('[regression:p0] VM ' + field + ' === canonical', () => {
                assert.strictEqual(
                    XChainVM[field],
                    protocol[field],
                    'VM ' + field + ' drifted from the canonical protocol constant'
                )
            })
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

        it('[regression:p0] OP_RETURN_PUSH_OVERHEAD === canonical across SDK + encoder', () => {
            // Every service that fits payloads into a single OP_RETURN push carries its own
            // copy of the PUSHDATA2 overhead. The SDK chunkHelper exports it directly; the
            // encoder folds it into MAX_DATA_BYTES = MAX_COMPILED_ACTION_DATA_LENGTH - overhead,
            // so its copy is the difference. Both must equal the canonical constant or the
            // single-tx-fit decision (SDK) and the compiled-data cap (encoder) silently diverge.
            assert.strictEqual(chunkHelper.OP_RETURN_PUSH_OVERHEAD, protocol.OP_RETURN_PUSH_OVERHEAD,
                'SDK chunkHelper OP_RETURN_PUSH_OVERHEAD drifted from the canonical protocol constant')
            assert.strictEqual(
                encoderValidator.MAX_COMPILED_ACTION_DATA_LENGTH - encoderValidator.MAX_DATA_BYTES,
                protocol.OP_RETURN_PUSH_OVERHEAD,
                'encoder PUSHDATA2 overhead (MAX_COMPILED_ACTION_DATA_LENGTH - MAX_DATA_BYTES) drifted from the canonical protocol constant')
        })

        it('[regression:p0] MAX_ACTION_DATA_LENGTH === canonical across SDK chunkHelper + co-signer', () => {
            // chunkHelper's copy drives fitsSingleDeploy() (single-tx vs chunked DEPLOY) and is
            // re-exported by the co-signer psbtActionDecode OVERSIZED gate. The decoder copy is
            // guarded above; without this the SDK/co-signer copy could drift so the co-signer
            // refuses PSBTs the decoder accepts and the chunker splits contracts that fit one tx.
            const psbtActionDecode = require('../../../xchain-sdk/src/cosigner/psbtActionDecode.js')
            assert.strictEqual(chunkHelper.MAX_ACTION_DATA_LENGTH, protocol.MAX_ACTION_DATA_LENGTH,
                'SDK chunkHelper MAX_ACTION_DATA_LENGTH drifted from the canonical protocol constant')
            assert.strictEqual(psbtActionDecode.MAX_ACTION_DATA_LENGTH, protocol.MAX_ACTION_DATA_LENGTH,
                'co-signer psbtActionDecode MAX_ACTION_DATA_LENGTH drifted from the canonical protocol constant')
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

    describe('Vendored protocol-constants byte-identity ', () => {

        // Each consuming service now requires a byte-identical vendored copy of the
        // canonical protocol constants (src/protocol/constants.js) instead of bare
        // literals, so a drift is impossible by construction rather than by
        // discipline. Assert every vendored copy equals the canonical source AND
        // that the module actually loads and re-exports the guarded values.
        const canonSrc = fs.readFileSync(
            path.join(__dirname, '../../../xchain-documentation/protocol/constants.js'), 'utf8')

        VENDORED_CONSTANTS_SERVICES.forEach((svc) => {
            it('[regression:p0] ' + svc + ' src/protocol/constants.js is byte-identical to canonical', () => {
                const vendoredPath = path.join(
                    __dirname, '../../../', svc, 'src/protocol/constants.js')
                assert.ok(fs.existsSync(vendoredPath),
                    svc + ' is missing its vendored src/protocol/constants.js copy')
                const vendoredSrc = fs.readFileSync(vendoredPath, 'utf8')
                assert.strictEqual(vendoredSrc, canonSrc,
                    svc + '/src/protocol/constants.js has drifted from the canonical ' +
                    'xchain-documentation/protocol/constants.js; edit the canonical file and re-vendor all copies')
                // Sanity: the vendored module loads and carries the size-limit anchor.
                const mod = require(vendoredPath)
                assert.strictEqual(mod.MAX_ACTION_DATA_LENGTH, protocol.MAX_ACTION_DATA_LENGTH,
                    svc + ' vendored constants module failed to load or export MAX_ACTION_DATA_LENGTH')
            })
        })
    })
})
