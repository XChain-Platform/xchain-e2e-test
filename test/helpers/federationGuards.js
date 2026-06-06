/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * E2E test helper — Hub-Federation suite guards
 *
 * The hub-federation attestation suites (multiHubAttestation, llmAttestation)
 * have two properties that make them unfit as silently-skippable, freely-
 * ordered members of the default suite:
 *
 *   1. They need extra prerequisites (HUB_DB creds, a privileged DB user, and
 *      for LLM a `claude login` config dir). When absent they `this.skip()`,
 *      which in CI reads as a green pass while testing nothing.
 *   2. The responsible-validator set for a request is chosen by
 *      `top-redundancy by SHA256(request_id‖pubkey)` across ALL staked
 *      attestation validators — so leftover stakes from an earlier suite make
 *      the live test hubs unreliable to select, and the round expires instead
 *      of producing a response (surfacing as a multi-minute timeout).
 *
 * These guards convert both failure modes into loud, immediate, actionable
 * errors when the suite is meant to run.
 *
 * Set E2E_REQUIRE_FEDERATION=1 (the `test:federation` / `test:attestation:llm`
 * npm scripts do) to make a missing prerequisite a hard FAILURE instead of a
 * skip. Unset (local ad-hoc dev), it still skips gracefully.
 ********************************************************************/

'use strict'

const assert = require('assert')

function _mustRun(){
    const v = process.env.E2E_REQUIRE_FEDERATION
    return v === '1' || v === 'true'
}

// Gate a hub-federation suite on its prerequisites. Call from `before()` with
// the mocha context. Returns true when the suite should proceed; otherwise
// throws (when E2E_REQUIRE_FEDERATION is set) or skips via the context.
function requireFederationEnv(ctx, opts){
    opts = opts || {}
    const problems = []
    if (typeof COIN_CODE !== 'undefined' && COIN_CODE !== 'BTC'){
        problems.push('requires BTC chain (attestation rides on BTC-only STAKE + EXECUTE); got ' + COIN_CODE)
    }
    if (!process.env.HUB_DB_USER || !process.env.HUB_DB_PASS){
        problems.push('requires HUB_DB_USER + HUB_DB_PASS (MultiValidatorHub creates per-hub DBs; needs a user with CREATE/DROP DATABASE)')
    }
    if (opts.needsClaudeConfig && !process.env.HUB_CLAUDE_CONFIG_DIR && !process.env.CLAUDE_CONFIG_DIR){
        problems.push('requires HUB_CLAUDE_CONFIG_DIR (or CLAUDE_CONFIG_DIR) pointing at a `claude login`-populated dir for the llm provider\'s claude_spawn')
    }
    if (problems.length === 0) return true

    const msg = 'Federation prerequisites not met: ' + problems.join('; ')
    if (_mustRun()){
        throw new Error('E2E_REQUIRE_FEDERATION is set but ' + msg +
            '. Provision the environment or unset the flag to allow skipping.')
    }
    console.log('[skip] ' + msg)
    ctx.skip()
    return false
}

// Assert the chain has no pre-existing active validators BEFORE the suite
// stakes its own. A polluted chain makes responsible-set selection
// nondeterministic for the test hubs. Fails fast with a fix instruction
// instead of letting the round silently expire deep in the test.
async function assertCleanValidatorSet(indexerDatabase){
    const n = await indexerDatabase.getActiveStakeCount()
    assert.strictEqual(n, 0,
        'Hub-federation tests need a clean validator set, but the chain has ' + n +
        ' active stake(s). Reset to a fresh chain first:\n' +
        '    XCHAIN_NODE_DATA_DIR=<data dir> xchain_node reset all bitcoin regtest\n' +
        '(run each federation suite on its own fresh chain — they are not isolated from prior staking).')
}

module.exports = { requireFederationEnv, assertCleanValidatorSet }
