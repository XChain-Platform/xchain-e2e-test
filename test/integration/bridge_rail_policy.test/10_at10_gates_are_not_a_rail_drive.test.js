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
 * Policy AT10: gates green on hub, indexer, sync, explorer, sdk, wallet, e2e-test,
 * documentation on Node 22; the base and token specs' acceptance tests still green with this
 * code present and the activation at the sentinel; both ordering asserts present.
 *
 * Registered here, skipped, so the drive's case list maps every acceptance test. None of it
 * is a regtest rail reading: the gates are each repository's CI, the ordering asserts live in
 * xchain-indexer's activationConstantsParity test, and "the activation at the sentinel" is a
 * testnet and mainnet fact that regtest (activation 0) cannot show.
 *
 ********************************************************************/

'use strict';

const { bridgeRailSuite } = require('./support');

bridgeRailSuite('policy AT10: gates and ordering asserts', function () {
    // Spec AT10: "gates green on hub, indexer, sync, explorer, sdk, wallet, e2e-test, documentation on Node 22".
    it.skip('policy AT10 (gates): every repository gate is green on Node 22. NOT A RAIL DRIVE: ' +
        '"gates green on hub, indexer, sync, explorer, sdk, wallet, e2e-test, documentation", read from each repository\'s CI');

    // Spec AT10: "the base and token specs' acceptance tests still green with this code present and
    // the activation at the sentinel". Regtest holds the activation at 0, never at the sentinel.
    it.skip('policy AT10 (sentinel): the base and token acceptance tests stay green with the activation at the sentinel. ' +
        'NOT DRIVABLE on regtest: "the activation at the sentinel", and regtest pins it at 0');

    // Spec AT10: "both ordering asserts present". A source read of the parity test, not a chain reading.
    it.skip('policy AT10 (ordering asserts): both TOKEN_POLICY_INHERITANCE_ACTIVATION ordering asserts are present. ' +
        'NOT A RAIL DRIVE: "both ordering asserts present", held by xchain-indexer activationConstantsParity.test.js');
});
