'use strict';

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
 * Test-only byzantine fault injectors for a booted MultiValidatorHub.
 *
 * Within the "no production-code changes" constraint, these model the spec's
 * MockMaliciousValidator by monkey-patching individual hub instances (the same
 * technique as the seeded-snapshot fixture) rather than adding hooks to
 * PeerManager. Each injector returns a restore() that undoes the fault.
 */

// Crash / partition a validator: it stops reacting to ALL consensus messages,
// so it never PREPAREs, COMMITs, or applies. The consensus listener is an arrow
// that reads `_handleMessage` at call time, so replacing it on the instance
// silences the node without detaching the listener. Models a dead/partitioned
// follower. The federation must still finalize on the honest majority.
function silenceValidator(hub) {
    const orig = hub.consensus._handleMessage;
    hub.consensus._handleMessage = () => {};
    return () => { hub.consensus._handleMessage = orig; };
}

// As silenceValidator, but for the cross-chain DEX PBFT engine (a separate
// consensus instance from the config Consensus). CrossChainDexConsensus.start()
// registers an arrow listener that calls `this._handleMessage` at call time, so
// replacing it on the instance mutes the node's DEX votes (PROPOSE/PREPARE/
// COMMIT/VIEW_CHANGE) while leaving its config/oracle consensus untouched.
function silenceDexValidator(hub) {
    const dex = hub.getCrossChainDex && hub.getCrossChainDex();
    if (!dex || !dex.consensus) throw new Error('silenceDexValidator: hub has no started cross-chain DEX engine');
    const orig = dex.consensus._handleMessage;
    dex.consensus._handleMessage = () => {};
    return () => { dex.consensus._handleMessage = orig; };
}

// As silenceValidator, but for the oracle PBFT engine (a separate consensus
// instance from the config Consensus). OracleConsensus.start() registers an arrow
// listener that calls `this._handleMessage` at call time, so replacing it on the
// instance mutes the node's oracle votes (ORACLE_PROPOSE/PREPARE/COMMIT) while
// leaving its config/DEX consensus untouched.
//
// Resolves the oracle consensus from either bring-up path: a test's attachOracle()
// helper (hub._wtOracle) or the harness's startOracle: true toggle, which
// leaves it on hub.oracleConsensus.
function silenceOracleValidator(hub) {
    const oc = hub._wtOracle || hub.oracleConsensus;
    if (!oc) throw new Error('silenceOracleValidator: hub has no oracle consensus; attachOracle() or start the harness with startOracle: true first');
    const orig = oc._handleMessage;
    oc._handleMessage = () => {};
    return () => { oc._handleMessage = orig; };
}

// Build a PRE_PREPARE envelope with a deliberately WRONG digest for its config
// (a forged proposal). A correct follower must reject it on the digest check and
// create no pending proposal. `seq` should be above any already-applied seq.
//
// Pass `signer` ({addr, pubkey}, normally a real member of the target's validator
// set) to make the DIGEST the only thing wrong with the envelope. Admission is
// keyed on the proven signing key, so an envelope carrying none is dropped as
// unattributable before the digest is ever compared, and the test would then pass
// without exercising what it names. A member sending a forged digest is also the
// scenario worth testing: an outsider cannot get this far at all.
function forgedPrePrepare(seq, config, blockIndex, signer) {
    return {
        sender: (signer && signer.addr) || '127.0.0.1:59999',
        sig_pubkey: signer && signer.pubkey,
        type:   'PBFT_PRE_PREPARE',
        data: {
            seq:            seq,
            configDigest:   'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
            config:         config,
            btcBlockHeight: blockIndex || 100
        }
    };
}

module.exports = { silenceValidator, silenceDexValidator, silenceOracleValidator, forgedPrePrepare };
