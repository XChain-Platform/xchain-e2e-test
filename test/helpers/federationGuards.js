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
 * E2E test helper: Hub-Federation suite guards
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
 *      attestation validators, so leftover stakes from an earlier suite make
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
    // Opt-in venue bypass: when the only pre-existing stakes are for unrelated
    // capabilities (e.g. a leftover cross_chain stake from a prior drill) they
    // don't pollute a full_node possession-proof run. Default behavior unchanged.
    if (n !== 0 && process.env.E2E_ALLOW_DIRTY_VALIDATOR_SET === '1') {
        console.warn('assertCleanValidatorSet BYPASSED (E2E_ALLOW_DIRTY_VALIDATOR_SET=1): chain has ' + n + ' active stake(s), proceeding')
        return
    }
    assert.strictEqual(n, 0,
        'Hub-federation tests need a clean validator set, but the chain has ' + n +
        ' active stake(s). Reset to a fresh chain first:\n' +
        '    XCHAIN_NODE_DATA_DIR=<data dir> xchain_node reset all bitcoin regtest\n' +
        '(run each federation suite on its own fresh chain; they are not isolated from prior staking).')
}

// ── Per-request responsible-set guards (selection-dependent cases) ──────────
//
// `assertCleanValidatorSet` above is the blunt, suite-wide form: refuse to run
// at all on a polluted chain. That is right for the hub-federation suites,
// which own their venue. It is wrong for a suite that has to share a venue with
// a long-lived seed (the rollcall federation seed lives on the BTC regtest
// chain and is deliberately preserved by an operator ruling):
// most of that suite is deterministic and stays green, and only the cases that
// need the suite's OWN validator to be the elected responder are at the mercy
// of selection.
//
// The indexer pins the elected set on the request row itself
// (`attests.responsible_set_json`, ATT-RECOMP-1), so the suite can read the
// election result rather than guess at it: if the suite's validator is not in
// the set, no signature it produces can ever be valid for that request, the
// request will expire by design, and a failure there says nothing about the
// code under test. Those cases report as PENDING with the elected set named,
// which is honest, instead of as a red assertion, which is not.

// The responsible set pinned on a v0 attestation request row, lower-cased, or
// null when the row carries none (pre-ATT-RECOMP-1 row, or a status that never
// pins one). Null means "unknown", NOT "empty": callers proceed on unknown.
function pinnedResponsibleSet(request){
    if (!request) return null
    const raw = request.responsible_set_json
    if (raw === null || raw === undefined || raw === '') return null
    let parsed = raw
    if (typeof raw === 'string'){
        try { parsed = JSON.parse(raw) } catch (e){ return null }
    }
    if (!Array.isArray(parsed)) return null
    return parsed.map((p) => String(p).toLowerCase())
}

// true / false when the set is known, null when it is not.
function isResponsibleFor(request, pubkey){
    const set = pinnedResponsibleSet(request)
    if (set === null) return null
    return set.indexOf(String(pubkey || '').toLowerCase()) !== -1
}

// Gate a selection-dependent case on the suite's validator having actually been
// elected for `request`. Returns true when the case should proceed.
//
// When it was not elected the case is VENUE-DEPENDENT, not broken: mark it
// pending via `ctx.skip()` and say which pubkey the venue elected instead. Set
// E2E_REQUIRE_FEDERATION=1 (a venue the caller controls and has just reset) to
// turn that into a hard failure, so a suite meant to prove the fulfillment path
// cannot pass by skipping it.
function requireResponsibleValidator(ctx, request, pubkey, label){
    const elected = isResponsibleFor(request, pubkey)
    if (elected === true) return true
    if (elected === null){
        // No pinned set to read: proceed and let the case's own assertions rule.
        console.log('[venue] ' + (label || 'request') +
            ': no responsible_set_json pinned on the request row; running the case unguarded')
        return true
    }

    const set = pinnedResponsibleSet(request) || []
    const msg = (label || 'request') + ' elected responsible set [' + set.join(', ') +
        '], which does not include this suite\'s validator ' + String(pubkey).toLowerCase() +
        '. Selection is top-REDUNDANCY by SHA256(request_id||pubkey) across every staked ' +
        'attestation validator, so a venue carrying other stakes routes some request-ids ' +
        'away from this suite and those requests expire by design.'

    if (_mustRun()){
        throw new Error('E2E_REQUIRE_FEDERATION is set but ' + msg +
            ' Reset to a clean validator set first:\n' +
            '    XCHAIN_NODE_DATA_DIR=<data dir> xchain_node reset all bitcoin regtest')
    }
    console.log('[venue-dependent] ' + msg + ' Reporting as pending rather than failed.')
    ctx.skip()
    return false
}

module.exports = {
    requireFederationEnv,
    assertCleanValidatorSet,
    pinnedResponsibleSet,
    isResponsibleFor,
    requireResponsibleValidator
}
