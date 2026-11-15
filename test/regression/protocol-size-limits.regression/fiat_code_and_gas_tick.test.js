// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const { protocol, sdkValidator } = require('./support/environment')

void describe('FIAT_CODE allow-list (PRICE actions)', () => {
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

void describe('Gas token TICK (GAS_TICK)', () => {
    // The indexer's config['GAS'] names the token debited for capability STAKE,
    // VOTE deposits/escrows, and contract gas billing. The SDK co-signer policy
    // engine keys capability-STAKE spending caps to its own mirror of this tick
    // (STAKE v1/v2 carry no TICK field). If either copy drifted from consensus,
    // gas-scoped caps would silently stop binding STAKE.
    const indexerConfig = require('../../../../xchain-indexer/src/config.js')
    const sdkPolicy     = require('../../../../xchain-sdk/src/cosigner/policy_evaluator.js')

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
