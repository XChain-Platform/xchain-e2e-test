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
 **********************************************************************
 *
 * The three levers the barrier-family legs (bf1 to bf8) are built on, each
 * driven on its own BEFORE any leg exists:
 *
 *   1. the per-INDEX env overlay, which is the only seam that can run indexer 0
 *      under one rule and indexer 1 under another on one venue;
 *   2. the height PIN, the only lever that can hold a watermark-keyed member,
 *      because withholding a table passes watermark and heartbeat frames through
 *      by design;
 *   3. `repoRoot`, which decides whose BYTES the acceptance evidence is about.
 *
 * WHY IT LIVES IN THIS DIRECTORY AND STILL STARTS NOTHING. The legs beside it
 * are the venue's, so the levers belong beside the legs; but a lever proven only
 * by a leg is proven by the most expensive venue in the suite, in a run that also
 * needs the rail, a hub federation and two indexers. Nothing here spawns a child,
 * touches a database or reaches the rail: the pure decision layer is called with
 * synthetic payloads and the proxy is driven against a fake hub on loopback, the
 * same way `test/unit/helpers/hubDbMirrorProxy.test.js` drives the row levers.
 *
 * The one thing it reads from outside the package is the indexer's own source,
 * to derive the barrier family. That is deliberate: the venue pins graces over
 * EIGHT keys while the indexer reports TEN reasons, including the two ungraced
 * members, and a test that hardcoded either number would go green through the
 * exact gap it exists to watch.
 ********************************************************************/

const { registerIndexOverlayLever } = require('./helpers/venue_levers_overlay')
const { registerHeightPinLever } = require('./helpers/venue_levers_pin')
const { registerDrivenHeightPin } = require('./helpers/venue_levers_driven')
const { registerRepoRootLever, registerBarrierFamily } = require('./helpers/venue_levers_repo')

describe('attestMirror venue levers (pure: no venue, no children, no database, no rail)', () => {
    describe('lever 1: the per-INDEX env overlay', registerIndexOverlayLever)
    describe('lever 2: the heights pin, on all three carriers', registerHeightPinLever)
    describe('lever 2, driven: the proxy pins the wire, not just the decision layer', registerDrivenHeightPin)
    describe('lever 3: the tree the venue\'s children are spawned from', registerRepoRootLever)
    describe('the barrier family versus the grace table the venue pins over', registerBarrierFamily)
})
