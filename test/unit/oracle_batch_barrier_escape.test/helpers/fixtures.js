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
 **********************************************************************
 * Part of test/unit/oracle_batch_barrier_escape.test.js
 ********************************************************************/

const path   = require('path');

const drill = require('../../../drills/lib/oracle_batch_barrier_testnet.js');

const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..', '..');

// The sibling indexer, where it is checked out. Every assertion that depends on
// it is skipped rather than silently weakened when it is not: a false green on
// the consensus half of this file would be worse than a gap.
// ABSENCE may skip; PRESENT-BUT-BROKEN must be red. Resolving is guarded, the
// load is not, so a sibling that exists and throws fails this file rather than
// turning the consensus half of it into a silent pass.
function sibling(rel) {
    const p = path.join(REPO_ROOT, 'xchain-indexer', 'src', rel);
    try { require.resolve(p); } catch (e) { return null; }
    return require(p);
}
const protocolTime = sibling('consensus/protocol_time.js');
// hub_db_sync.js exports the CLASS itself (module.exports = HubDbSync), with the
// constants hung off it as properties.
const HubDbSync    = sibling('hub/hub_db_sync.js');
const haveHubDbSync = typeof HubDbSync === 'function' &&
    typeof HubDbSync.prototype['_priceTimeSyncSatisfied'] === 'function';

// ---------------------------------------------------------------------------
// Run 5's own readings
// ---------------------------------------------------------------------------

// Block 67881904 of TDOGE, the ONE block of run 5's 290 that ever timed out at
// the barrier and therefore the only one whose barrier state the old attribution
// could see at all.
const B = {
    height: 67881904,
    // The chain's raw stamp, as the decoder recorded it and as the public
    // explorer still serves it at /TDOGE/api/block/67881904.
    rawBlockTime: 1788982721,
    // The time the INDEXER was waiting on, quoted from its own deferral line:
    // "waiting for block time 1788982515". This is the protocol time.
    barrierBlockTime: 1788982515,
    // processedAt, from the result file: block time + the recorded stallS 4607.
    processedAt: 1788982721 + 4607
};

// The eleven stamps preceding it, read from the public explorer one block at a
// time, in the DESCENDING order `db.getPreviousBlockTimes` returns them.
const PREV_11_DESC = [
    1788982673, 1788982671, 1788982651, 1788982611, 1788982537, 1788982515,
    1788982511, 1788982496, 1788982471, 1788982456, 1788982383
];

// The three deferral lines run 5 captured for that block, as barrier samples.
// Each is the indexer printing its own priceSyncMaxTimestamp and streamWatermark
// at an instant the predicate was false. The middle one is reconstructed at the
// 60 s retry cadence the other two bracket exactly (1788987133 -> 1788987263).
const RUN5_DEFERRAL_SAMPLES = [
    { at: 1788987133, source: 'deferral', priceSyncMaxTimestamp: 1788982085, streamWatermark: 1788987132 },
    { at: 1788987193, source: 'deferral', priceSyncMaxTimestamp: 1788982085, streamWatermark: 1788987192 },
    { at: 1788987263, source: 'deferral', priceSyncMaxTimestamp: 1788982085, streamWatermark: 1788987262 }
];

const GRACE_S = 4800;

// The /status series the FIXED drill takes, over the same window.
//
// The watermark trajectory is not invented: both real deferral readings above
// show `streamWatermark` exactly one second behind the instant the line was
// parsed (1788987133/1788987132 and 1788987263/1788987262), which is the hub's
// own clock advancing in real time. Extending that measured relationship across
// a 15 s poll grid (POLL_MS) is what the drill would have recorded had it been
// sampling, and it is the only quantity here that is projected rather than read.
function statusSeries(fromAt, toAt, stepS) {
    const out = [];
    for (let t = fromAt; t <= toAt; t += stepS) {
        out.push({
            at: t, source: 'status', bootstrapped: true,
            priceSyncMaxTimestamp: 1788982085,
            streamWatermark: t - 1
        });
    }
    return out;
}

module.exports = { drill, REPO_ROOT, sibling, protocolTime, HubDbSync, haveHubDbSync, B, PREV_11_DESC, RUN5_DEFERRAL_SAMPLES, GRACE_S, statusSeries };
