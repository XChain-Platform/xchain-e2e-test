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

// Everything the drill's stages leave behind for its assertions. One object, so
// the stage modules and the part files all read the same live values.
module.exports = {
    hubDb: null, venue: null, pinned: null, signerSet: null, replayNode: null,
    liveConn: null, liveDb: null, liveDbError: null,

    // half one
    rounds: [], parsed: null, honest: null,
    landed: {},                 // name -> { wire, txid, bytes, height, tamper }
    liveStatus: {}, replayStatus: {},
    livePriceRows: [], replayPriceRows: [],
    minBlock: null, targetHeight: null,
    priceRowDiff: null,

    // half two
    dual: null, counterfactual: null, batchCanonical: null, rebuiltCanonical: null,
    canonicalFromSigningRound: false,
    honestProof: null, swappedProof: null, sharedTagProof: null
};
