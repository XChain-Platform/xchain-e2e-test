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
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Test-only byzantine fault injectors for a booted MultiValidatorHub.
 *
 * Within the "no production-code changes" constraint, these model the spec's
 * MockMaliciousValidator by monkey-patching individual hub instances (the same
 * technique as the seeded-snapshot fixture) rather than adding hooks to
 * PeerManager. Each injector returns a restore() that undoes the fault.
 *
 * Spec: claude/reports/specs/2026-05-30_validator-test-spec.md §6 (byzantine).
 */

// Crash / partition a validator: it stops reacting to ALL consensus messages,
// so it never PREPAREs, COMMITs, or applies. The consensus listener is an arrow
// that reads `_handleMessage` at call time, so replacing it on the instance
// silences the node without detaching the listener. Models a dead/partitioned
// follower — the federation must still finalize on the honest majority.
function silenceValidator(hub) {
    const orig = hub.consensus._handleMessage;
    hub.consensus._handleMessage = () => {};
    return () => { hub.consensus._handleMessage = orig; };
}

// Build a PRE_PREPARE envelope with a deliberately WRONG digest for its config
// (a forged proposal). A correct follower must reject it on the digest check and
// create no pending proposal. `seq` should be above any already-applied seq.
function forgedPrePrepare(seq, config, blockIndex) {
    return {
        sender: '127.0.0.1:59999',
        type:   'PBFT_PRE_PREPARE',
        data: {
            seq:            seq,
            configDigest:   'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
            config:         config,
            btcBlockHeight: blockIndex || 100
        }
    };
}

module.exports = { silenceValidator, forgedPrePrepare };
