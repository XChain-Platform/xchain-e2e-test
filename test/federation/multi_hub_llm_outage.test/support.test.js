'use strict'

const crypto = require('crypto')

// Five drills exercise provider outage, credential recovery, leader rotation,
// governance-controlled model fallback, and a stopped responsible validator
// against one live three-hub federation.
// The venue starts from a clean BTC regtest validator set with a usable Claude
// configuration and CLI. Process-wide credential changes deliberately affect
// every in-process hub at the same point in each request window.

// Requests use redundancy three and a short deadline. A provider failure must
// publish one retryable audit row, remain pending, then expire and refund; restoring
// credentials during a later request must instead fulfill with three signatures.
// This shared envelope asks for a deterministic answer, keeping provider output
// comparison separate from the federation publication behavior under test.
const ENVELOPE = JSON.stringify({
    prompt: 'What is 2 plus 2? Reply with only the number, nothing else.',
    max_tokens: 16
})

// Callback state is keyed by request so sequential drills keep independent evidence.
// The hard-stop drill cannot publish v1 without every responsible signature, leaving
// expiry as the protocol backstop while missed-count accounting records the consequence.
// Persisting status and payload separately proves retryable audit rows do not invoke
// the terminal callback before fulfillment or expiry resolves the request.
const CONTRACT_CODE = `
module.exports = {
    meta: { name: 'LLM Outage Asker', description: 'Requests an LLM attestation while one hub is offline.', version: '1.0.0' },
    askLlm: function(xchain) {
        var envelope = xchain.getInputParam(0);
        var requestId = xchain.attestation.request(
            'llm', envelope, 'handleResponse', ['ctx-outage-drill'],
            { redundancy: 3, deadlineBlocks: 20 }
        );
        xchain.state.set('last_request_id', requestId);
        return requestId;
    },
    handleResponse: function(xchain) {
        var rid = String(xchain.getInputParam(0));
        var key = 'cb_' + rid.substring(0, 24);
        xchain.state.set(key + '_status', xchain.getInputParam(2));
        xchain.state.set(key + '_payload', xchain.getInputParam(3));
    }
};
`

async function internalSettleStack() {
    // Stake and deployment operations cross the node, tracker, and indexer. Quiescence
    // prevents an uncommitted view from leaking into the next setup action. Complete
    // visibility mining also buries the validator snapshot behind the reorganization buffer.
    // Five-second provider polling keeps the drill practical, while the sixty-second
    // round timeout still leaves room for provider fetch, proposal, and judge latency.
    await utxoTrackerConnector.quiesce({ timeoutMs: 30000, pollMs: 250, regtestMiner: regtestMinerConnector })
}

// All hubs share this process and resolve credentials at call time. A present-but-invalid
// key preserves capability eligibility while forcing the provider call to fail, so each
// validator proposes provider_error instead of disappearing from the round as incapable.
// Normal configuration directories, OAuth tokens, and direct API keys are all removed
// because leaving any one source intact would turn the intended outage into a live call.
const CRED_KEYS = ['HUB_CLAUDE_CONFIG_DIR', 'CLAUDE_CONFIG_DIR',
    'HUB_CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']
let savedCreds = null

function breakAnthropicCreds(){
    if (!savedCreds){
        savedCreds = {}
        for (const key of CRED_KEYS) savedCreds[key] = process.env[key]
    }
    for (const key of CRED_KEYS) delete process.env[key]
    // Keep this assembled so secret scanners do not mistake a deliberately
    // invalid drill value for an exposed credential.
    process.env.ANTHROPIC_API_KEY = ['sk', 'ant', 'api03', 'drill', 'invalid', '0000000000000000'].join('-')
}

// Recovery restores both values and absence exactly as observed before the drill.
// Deleting the invalid override first matters because it would otherwise shadow
// configuration-directory authentication and make a healthy provider appear unavailable.
function restoreAnthropicCreds(){
    // Restore absence as well as values. Leaving the invalid override present
    // would shadow config-directory authentication during recovery drills.
    if (!savedCreds) return
    for (const key of CRED_KEYS) delete process.env[key]
    for (const key of CRED_KEYS)
        if (savedCreds[key] !== undefined) process.env[key] = savedCreds[key]
}

// Retryable statuses are audit rows, not terminal callbacks. Counting throughout each
// retry window catches a duplicate or forbidden valid row even if later state changes.
// Lower-case request ids avoid differences in hexadecimal casing between database clients.
// The optional status narrows throttle assertions, while onlyValid distinguishes rows
// accepted with the request's full signature redundancy from under-quorum broadcasts.
async function countV1Rows(requestId, responseStatus, onlyValid){
    const conn = await indexerDatabase.getConnection()
    try {
        // Join index status only when the caller needs accepted rows. Counting
        // all rows separately exposes wasteful under-quorum broadcasts without
        // confusing them with protocol-valid publications.
        let query = `SELECT COUNT(*) AS n FROM attests ar
                     LEFT JOIN index_statuses ist ON ist.id = ar.status_id
                     WHERE ar.version = 1 AND ar.request_id = ?`
        const values = [String(requestId).toLowerCase()]
        if (responseStatus){ query += ' AND ar.response_status = ?'; values.push(responseStatus) }
        if (onlyValid) query += " AND ist.status = 'valid'"
        const rows = await conn.query(query, values)
        return Number(rows[0].n)
    } finally { await conn.release() }
}

// Reproduce responsible-set ordering by hashing the request id with each lower-case
// public key. Rotation wedges slot zero's judge while leaving that hub alive to sign;
// advancing chain height must let a working leader fulfill the same request.
// Selecting the owner from protocol ordering, rather than harness array order, ensures
// the test faults the leader assigned to this request and not merely the first process.
function slot0HubIndex(mvh, requestId){
    const rid = String(requestId).toLowerCase()
    const ranked = mvh.getPubkeys().map((pubkey, index) => {
        const lower = String(pubkey).toLowerCase()
        const hash = crypto.createHash('sha256').update(rid, 'utf8').update(lower, 'utf8').digest('hex')
        return { index, hash }
    }).sort((a, b) => (a.hash < b.hash) ? -1 : 1)
    return ranked[0].index
}

// Finalized governance activates a primary model followed by an OpenAI fallback at a
// future block. Once the request crosses its midpoint it pins the fallback, so restoring
// primary credentials cannot fulfill it. Continuous assertions reject even transient
// fulfillment, while a fresh request proves the working primary segment remains usable.
// Mirror the anchored change into the live registry because judge fallback readers are
// not block-anchored and must observe the same finalized configuration.
// The pinned request is ultimately mined past its deadline so it leaves a clean refund,
// while the fresh control request begins in its own primary segment and can fulfill.
async function applyLlmGovernance(mvh, activationBlock, additionalConfig){
    // Both stores must change together. Anchored readers select configuration
    // by block height, while live judge selection reads the registry definition
    // and provider module directly.
    for (const hub of mvh.hubs){
        await hub.applyProviderGovernanceChange({
            parameter: 'ATTESTATION_PROVIDER:llm', activationBlock,
            newValue: JSON.stringify({ additional_config: additionalConfig })
        })
        const registry = hub.providerRegistry
        const definition = Object.assign({}, registry.getDef('llm'), { additional_config: additionalConfig })
        registry.providers.set('llm', definition)
        const module = registry.getModule('llm')
        if (module && typeof module._setConfig === 'function') module._setConfig(definition)
    }
}

module.exports = {
    // Keep the helper boundary explicit: the entry suite owns lifecycle and assertions,
    // while this split module owns deterministic fixtures, credential controls, row counts,
    // responsible-set ordering, and the governance mutation shared by those phases.
    ENVELOPE, CONTRACT_CODE,
    internalSettleStack, breakAnthropicCreds, restoreAnthropicCreds,
    countV1Rows, slot0HubIndex, applyLlmGovernance
}
