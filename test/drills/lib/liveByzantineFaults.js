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
 * Live byzantine fault injectors for an OUT-OF-PROCESS drill validator.
 *
 * test/helpers/byzantineFaults.js does the same job for the in-process mesh,
 * where the test file holds every hub object. Here the injectors run INSIDE
 * the validator's own process (lib/drillNode.js applies them on command), so
 * the harness on the far end of an ssh pipe never touches victim memory. That
 * distinction is the whole point of the physical drill: an auditor can see
 * that the honest boxes were never reached into.
 *
 * Modelled on the live relay-mesh hook that produced the N=3 result recorded
 * in claude/reports/launch/c2-residuals-handover.md: forge only the CONSENSUS
 * signatures, leave transport auth intact, so the victim stays an ACTIVE
 * voter rather than degrading into a crash fault.
 *
 * No production code is modified; every injector returns a restore().
 ********************************************************************/

'use strict';

// Consensus traffic is exactly the PBFT_* envelope family (Consensus.js
// broadcasts PRE_PREPARE / PREPARE / COMMIT / VIEW_CHANGE / NEW_VIEW).
// Heartbeats, handshakes and gossip are deliberately NOT forged: corrupting
// those would get the victim disconnected, and a disconnected node is a crash
// fault, which is a strictly weaker adversary than the one being drilled.
function shouldForge(type) {
    return typeof type === 'string' && type.startsWith('PBFT_');
}

// Flip the low nibble of the last byte. Deterministic (a drill result has to
// be reproducible), still a valid 128-hex-char Ed25519 signature shape, and
// guaranteed to differ from the real signature so verification fails on the
// signature check rather than on a length/parse guard.
function corruptSignature(sigHex) {
    if (typeof sigHex !== 'string' || sigHex.length === 0) return sigHex;
    const head = sigHex.slice(0, -1);
    const tail = sigHex.slice(-1);
    const flipped = (parseInt(tail, 16) ^ 0x1).toString(16);
    return head + (Number.isNaN(parseInt(tail, 16)) ? tail : flipped);
}

/**
 * CRASH / PARTITION. The victim stops reacting to every consensus message: it
 * never PREPAREs, COMMITs or applies. Consensus.start() registers an arrow
 * listener that reads `this._handleMessage` at call time, so replacing the
 * method on the instance mutes the node without detaching the listener.
 */
function silenceConsensus(hub) {
    const consensus = hub && hub.consensus;
    if (!consensus) throw new Error('silenceConsensus: hub has no started consensus engine');
    const orig = consensus._handleMessage;
    consensus._handleMessage = () => {};
    return () => { consensus._handleMessage = orig; };
}

/**
 * ACTIVE BYZANTINE. The victim keeps voting, but every PBFT envelope it emits
 * carries a signature that does not verify, so honest peers drop its votes at
 * the transport verification step while it counts itself as having voted.
 *
 * Wraps PeerManager._buildEnvelope, which is the single place an outbound
 * envelope is signed. Restoring puts the original method back.
 */
function forgeConsensusSignatures(hub) {
    const pm = hub && hub.peerManager;
    if (!pm || typeof pm._buildEnvelope !== 'function') {
        throw new Error('forgeConsensusSignatures: hub has no started peer manager');
    }
    const orig = pm._buildEnvelope;
    let forged = 0;
    pm._buildEnvelope = function (type, data) {
        const env = orig.call(this, type, data);
        if (env && env.sig && shouldForge(type)) {
            env.sig = corruptSignature(env.sig);
            forged++;
        }
        return env;
    };
    const restore = () => { pm._buildEnvelope = orig; };
    restore.forgedCount = () => forged;
    return restore;
}

/**
 * EQUIVOCATION. Build the second of two conflicting PRE_PREPAREs for one seq.
 * The caller drives both through the victim's own peer manager; honest nodes
 * must stay locked to whichever config they saw first.
 */
function prePrepareEnvelope(consensus, seq, view, config, btcBlockHeight) {
    return {
        sender: consensus.peerManager.validatorAddr,
        type:   'PBFT_PRE_PREPARE',
        data: {
            seq:            seq,
            view:           view,
            configDigest:   consensus._digest(config),
            config:         config,
            btcBlockHeight: btcBlockHeight
        }
    };
}

/**
 * FORGED PROPOSAL. A PRE_PREPARE whose digest does not match its config. An
 * honest node must reject it on the digest check and create no pending
 * proposal.
 */
function forgedPrePrepare(seq, config, btcBlockHeight, sender) {
    return {
        sender: sender || '127.0.0.1:59999',
        type:   'PBFT_PRE_PREPARE',
        data: {
            seq:            seq,
            configDigest:   'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
            config:         config,
            btcBlockHeight: btcBlockHeight || 100
        }
    };
}

module.exports = {
    shouldForge,
    corruptSignature,
    silenceConsensus,
    forgeConsensusSignatures,
    prePrepareEnvelope,
    forgedPrePrepare
};
