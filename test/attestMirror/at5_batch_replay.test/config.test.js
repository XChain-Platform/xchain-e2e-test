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
 **********************************************************************/

// AT5's constants, the asking contract and the llm probe, split out of the parent
// drill (../at5_batch_replay.test.js), which carries the story.

const dotenv = require('dotenv')
dotenv.config()

const { assertLlmAvailable, llmProbes, hubCredentialEnv } = require('../../helpers/attestMirrorVenue')
const { resolveAt5ResponseProvider, at5ResponseRedundancy } = require('../helpers/at5ResponseProvider')
const chainRail = require('../../helpers/chainRail')


// Short enough that several windows close inside a drill, and comfortably above
// the four-times-the-hop floor the venue's own timing invariant would impose if
// this hub keyed windows on wall clock rather than on the signed effective time.
const BATCH_WINDOW_S = 30

// Above the gossip hop budget, as the venue requires, AND ABOVE A ROUND: a row's
// effective time is its leader's clock plus this margin, and the row is only
// written at finalization. A round that runs through a leader-slot timeout
// (30 s here) finalizes long after the leader's clock, so with 8 s the second of
// two responses landed in a window hub 3 had already closed and published with
// one row; the re-publish with both was refused on chain as a duplicate head
// (`BATCH_KEY`) and that response never linked (pass 17, 2026-09-05). Ninety
// seconds covers two slots plus gossip and keeps the drill's own waits intact.
const FORWARD_S = 90

// How often the drill re-pushes the node's live BTC tip to every hub. Half the
// miner's 6 s ceiling on the drive venue, so no hub ever holds a tip more than
// one block stale; cheap (five fire-and-forget RPCs).
const TIP_FEED_MS = 3000

// DOGE funded to the publisher, as MANY INDEPENDENT OUTPUTS rather than one. The
// encoder spends confirmed outputs only, and every non-empty window spends the
// wallet's largest output into fresh, unconfirmed change; with one funding output
// the publisher can reach only the small
// carrier outputs earlier windows left behind, and a 3-wire batch needing
// 2,000,000 against `selected inputs total 600000` failed at the one window that
// carried the responses (pass 10, 2026-09-05; the publisher never retries a
// failed broadcast). With PUBLISHER_FUND_OUTPUTS outputs of PUBLISHER_FUND_DOGE
// each, at most one is in flight per window and a confirmed one is always there.
const PUBLISHER_FUND_DOGE    = 1.0
const PUBLISHER_FUND_OUTPUTS = 40

// THE PROVIDER'S CEILING, and it is a ceiling rather than a preference: the
// registry admits a request only while `deadline - block <= deadline_window_blocks`
// (attestation/providerRegistry.js), and the VM gateway rejects an over-limit value
// at CALL time, so the EXECUTE that emits the request comes back `failed` rather
// than the request landing and expiring. Pass 25 proved that the expensive way at
// 150 against http_get's 100: `EXECUTE : contract=1791 : method=ask : failed`.
//
// Twenty is valid for both supported providers. Keeping the smaller llm ceiling
// makes provider selection independent from contract construction and leaves the
// default path byte-for-byte equivalent at the request boundary.
const DEADLINE_BLOCKS = 20
const BURIAL_BLOCKS   = 6

// The request every round here answers.
//
// DETERMINISTIC ARITHMETIC, byte for byte, because that is what the round
// converges on: every responsible hub asks its own model and `AttestationConsensus`
// needs 2f+1 IDENTICAL proposals, so a prompt with any latitude in its answer ends
// `no consensus (proposals diverged)` and the mirror skips a no-quorum round by
// design. This is AT1's llm payload verbatim, which is the one that has been
// driven green on this venue.
const LLM_PAYLOAD = JSON.stringify({ prompt: 'What is 2+2? Reply with only the number.' })
const HTTP_GET_BODY = JSON.stringify({ answer: 4, fixture: 'at5-batch-response' })
const RESPONSE_PROVIDER = resolveAt5ResponseProvider(process.env)
const REQUEST_REDUNDANCY = at5ResponseRedundancy(RESPONSE_PROVIDER)

// The DOGE encoder this venue publishes through, taken from the rail's own port map
// so the drill and the rail cannot disagree about where that service lives.
const DOGE_ENCODER_PORT = chainRail.DEFAULT_PORTS.DOGE.encoder

// The head and continuation versions, and the DOGE-side action formats a drill
// reads them back as.
const BATCH_HEAD_VERSION         = 5
const BATCH_CONTINUATION_VERSION = 6

// The credential this drill forwards to its hub children: the OAuth token when the
// harness environment carries one, nothing otherwise. One function, called by the
// pre-check and by the venue construction, so both see the identical object.
function forwardedHubCredentialEnv () {
    return process.env.HUB_CLAUDE_CODE_OAUTH_TOKEN
        ? { HUB_CLAUDE_CODE_OAUTH_TOKEN: process.env.HUB_CLAUDE_CODE_OAUTH_TOKEN } : {}
}

/**
 * Can THIS box serve the llm provider, asked with the venue's own predicate?
 *
 * Copied in shape from AT1 for the reason AT1 gives: the two halves the provider
 * needs live on different boxes, so declaring `needsLlm` unconditionally refuses
 * the whole drill on either of them. Probed, the venue still refuses if the probe
 * and reality ever disagree, because `start()` re-checks with this same predicate
 * rather than trusting the flag.
 *
 * THE SKIP IS LOUD AND NAMES THE MISSING HALF. The explicit http_get mode does
 * not call this predicate and is never selected automatically.
 */
function llmRunnableHere () {
    const dir = process.env.HUB_CLAUDE_CONFIG_DIR || null
    try {
        // The credential clause judges the env the hubs will GET: the object forwarded below.
        assertLlmAvailable({
            claudeConfigDir: dir,
            pathEnv: process.env.PATH,
            hubEnv: hubCredentialEnv(dir, forwardedHubCredentialEnv())
        }, llmProbes())
        return { ok: true, why: null }
    } catch (e) {
        return { ok: false, why: (e && e.message) || String(e) }
    }
}

const CONTRACT_CODE = `
module.exports = {
    meta: { name: 'Mirror Replay Asker', description: 'Requests an attestation used to replay a mirrored response batch.', version: '1.0.0' },
    ask: function(xchain) {
        var requestId = xchain.attestation.request(
            xchain.getInputParam(0),
            xchain.getInputParam(1),
            'handleResponse',
            [xchain.getInputParam(2)],
            { redundancy: ${REQUEST_REDUNDANCY}, deadlineBlocks: ${DEADLINE_BLOCKS} }
        );
        return requestId;
    },
    handleResponse: function(xchain) {
        var tag = xchain.getInputParam(4);
        xchain.state.set('status_' + tag, xchain.getInputParam(2));
    }
};
`

module.exports = {
    BATCH_WINDOW_S, FORWARD_S, TIP_FEED_MS, PUBLISHER_FUND_DOGE, PUBLISHER_FUND_OUTPUTS,
    DEADLINE_BLOCKS, BURIAL_BLOCKS, LLM_PAYLOAD, HTTP_GET_BODY, RESPONSE_PROVIDER,
    REQUEST_REDUNDANCY, DOGE_ENCODER_PORT, BATCH_HEAD_VERSION, BATCH_CONTINUATION_VERSION,
    CONTRACT_CODE, forwardedHubCredentialEnv, llmRunnableHere,
}
