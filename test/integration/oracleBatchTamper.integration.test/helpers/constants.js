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

// Two rounds, not six. AT1 owns "how many rounds fit in one wire"; AT4 owns what
// happens to a signed wire afterwards, and a two-round window is a genuine
// multi-round batch (a real window, a real signing round, per-round bodies the
// tamper can reach into) at a third of the PBFT cost.
const WINDOW_ROUNDS  = 2;
const VALIDATORS     = 4;
const MIN_SIGNATURES = 3;

// Seconds, not the shipped five minutes: rounds driven back to back in-process
// have no stragglers for the grace to wait for.
const GRACE_MS = 4000;

// The price-sync grace BOTH the standing node and the replay node must be judged
// under. MEASURED by the AT2 rig: at the frozen 4800 a chain-only node stops dead
// at the first block younger than 4800 seconds and cannot reach a freshly mined
// tip inside any sensible budget. 600 is the value the platform ran on until this
// spec moved it, so it is a real barrier rather than a barrier switched off, and
// the indexer honours the override on regtest only. AT5 is the drill that must
// exercise the barrier itself; this one must not.
const PRICE_GRACE_S = 600;

// The one verdict a well-formed PRICE can legitimately record on a non-BTC
// indexer while the price-capability gap is open, and, unhelpfully, also the
// verdict a body tamper earns on a stake-weighted network. See the header.
const CAPABILITY_GAP_STATUS = 'invalid: insufficient signer stake';

// The status a header-anchor tamper can ONLY earn from the tamper: it is thrown
// in the structural rules (`price/index.js`, "batch anchor does not match the last
// round"), upstream of every capability, gate and signature.
const ANCHOR_TAMPER_STATUS = 'invalid: batch anchor does not match the last round';

// What `slash.js` records for two canonicals that do not share an EQUIV key
// prefix. This is the whole of AT4's second half: a per-round canonical and a
// batch canonical carry DIFFERENT engine tags, so they cannot be paired at all.
const TAG_SEPARATION_STATUS = 'invalid: EQUIV header/key mismatch';

// The PRICE wire prefix every batch rides under after the v0 collapse
// (`OraclePublisher`: `'PRICE|0|' + body`, or `'PRICE|0|Z|' + base64`).
const WIRE_PREFIX = 'PRICE|0|';

module.exports = {
    WINDOW_ROUNDS, VALIDATORS, MIN_SIGNATURES, GRACE_MS, PRICE_GRACE_S,
    CAPABILITY_GAP_STATUS, ANCHOR_TAMPER_STATUS, TAG_SEPARATION_STATUS, WIRE_PREFIX
};
