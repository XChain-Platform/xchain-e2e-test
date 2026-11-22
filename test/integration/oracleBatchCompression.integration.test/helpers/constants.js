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
 ********************************************************************/

const drive = require('../../../helpers/oracleBatchDrive');

// The consensus compression module, as the landing chain runs it.
const priceBatch = drive.priceBatch;

// ---------------------------------------------------------------------------
// The run's numbers
// ---------------------------------------------------------------------------

// "a real six-round batch" is AT9's own wording, so the window stays at six.
const WINDOW_ROUNDS = 6;
// Four validators gives a weighted quorum of three, so a signing round that
// reaches quorum has persuaded peers rather than counted itself.
const VALIDATORS    = 4;
const MIN_SIGNATURES = 3;

// Seconds, not the shipped five minutes: six rounds driven back to back
// in-process have no stragglers for the grace to wait for.
const GRACE_MS = 4000;

// The price-sync grace BOTH nodes run at, in seconds. At the frozen 4800 a node
// reading a freshly published block defers it until its wall clock is 80 minutes
// past that block's time, which no drill budget survives. 600 is the value the
// platform ran on until this spec moved it, so the barrier is real rather than
// switched off, and it is applied IDENTICALLY to both nodes, which is what keeps
// the two-node comparison sound. Exercising the barrier at 4800 is AT5's job.
const PRICE_GRACE_S = 600;

// How far above the run's real rounds the hostile wires' round numbers sit. Big
// enough that no rerun's seconds-since-epoch base can ever reach it, so a ghost
// round found in `price_snapshots` came from THIS drill's hostile wire and from
// nowhere else.
const GHOST_OFFSET = 5_000_000;

// Filler appended to a ghost body to push its inflated size past the caps. Any
// highly compressible run does; the exact length is searched for at runtime
// against the consensus module rather than hard-coded, so a change in zlib's
// output cannot silently turn the breach into a legal payload.
const BREACH_FILLER_CHAR = 'A';

// Budgets. Every one is a poll that returns the moment its condition holds.
const CONFIRM_WAIT_MS  = 300_000;   // one broadcast wire reaching a block
const PRICE_ROW_WAIT_MS = 180_000;  // a node writing its verdict for that wire

// The one verdict a well-formed PRICE can legitimately record on a non-BTC
// indexer while the price-capability rung is still settling. AT9 is a claim
// about wire FORM, not about signer resolution, so the honest batch's clauses
// tolerate this verdict and say so out loud rather than failing on it.
const KNOWN_CAPABILITY_GAP_STATUS = 'invalid: insufficient signer stake';

// The exact status a non-canonical base64 spelling must record, from the module
// that produces it. Never spelled out as a literal here: these strings reach the
// chain inside the action's recorded status, so the module owns them.
const STATUS_BASE64 = 'invalid: COMPRESSION (' +
    priceBatch.PRICE_BATCH_COMPRESSION_FAIL_REASONS.BASE64 + ')';
const REASON_RATIO  = priceBatch.PRICE_BATCH_COMPRESSION_FAIL_REASONS.RATIO_CAP;
const REASON_SIZE   = priceBatch.PRICE_BATCH_COMPRESSION_FAIL_REASONS.SIZE_CAP;

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const BATCH_WIRE_VERSION = 0;

module.exports = {
    drive, priceBatch, WINDOW_ROUNDS, VALIDATORS, MIN_SIGNATURES, GRACE_MS, PRICE_GRACE_S,
    GHOST_OFFSET, BREACH_FILLER_CHAR, CONFIRM_WAIT_MS, PRICE_ROW_WAIT_MS,
    KNOWN_CAPABILITY_GAP_STATUS, STATUS_BASE64, REASON_RATIO, REASON_SIZE, B64_ALPHABET,
    BATCH_WIRE_VERSION,
};
