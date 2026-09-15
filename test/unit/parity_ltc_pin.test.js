'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Guard: the multi-chain parity harness must pin litecoind to the
// version the DEPLOYED LTC node fleet runs (bump-with-fleet rule), not float
// to the latest upstream release. This test fails if the pin is removed from
// run-multichain-parity.sh or loses its expected shape, so a fleet upgrade
// forces a deliberate, same-change bump of the pin.

const fs      = require('fs');
const path    = require('path');
const { expect } = require('chai');

const SCRIPT = path.join(__dirname, '..', 'parity', 'run-multichain-parity.sh');

describe('parity harness LTC daemon pin', function () {
    let src;
    before(function () { src = fs.readFileSync(SCRIPT, 'utf8'); });

    // Litecoin tags carry three or four numeric components (v0.21.4, v0.21.5.6),
    // so the default is matched loosely rather than to a fixed component count.
    it('pins litecoind via LTC_NODE_VERSION_PIN with a released-tag default', function () {
        const m = src.match(/LTC_NODE_VERSION_PIN="\$\{LTC_NODE_VERSION_PIN:-(v\d+(?:\.\d+){2,3})\}"/);
        expect(m, 'LTC_NODE_VERSION_PIN default missing from run-multichain-parity.sh').to.not.equal(null);
    });

    it('exports the pin to the xchain-node install path', function () {
        expect(src).to.include('export XCHAIN_NODE_NODE_VERSION_LITECOIN="$LTC_NODE_VERSION_PIN"');
    });

    it('documents the bump-with-fleet rule next to the pin', function () {
        expect(src.toLowerCase()).to.include('bump-with-fleet');
    });
});
