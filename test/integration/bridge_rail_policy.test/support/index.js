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
 *********************************************************************/

'use strict';

const { createRailDrive } = require('../../bridge_rail_token.test/support');
const policy = require('./policy');

// The policy drive is the token drive's bring-up under its OWN identity: its own venue label
// and port base (so its clone, replay, mirror and hub databases never collide with a token or
// base drive's, and its DOGE ledger never inherits their policy rows), its own suite title and
// journal name. The token helpers (wires, funded addresses, verdicts, settle waits) come with
// it unchanged; the policy readings are bound over them.
const POLICY_DRIVE = {
    label: 'bridgerailpolicy',
    basePort: 47000,
    outerTitle: 'XPOLICY acceptance drive on the BTC/DOGE regtest rail (policy AT1 to AT10)',
    journalSuite: 'bridgeRailPolicy',
    logTag: 'POLICY RAIL',
    readoutTitle: 'policy rail drive readouts',
    // BTC at 2 for the same measured reason as the token drive: at depth 1 a snapshot_block
    // can sit below the lock's own block and the DOGE escrow proof refuses the in-leg.
    confirmations: { BTC: 2, DOGE: 1 },
    records: policy.records,
};

const drive = createRailDrive(POLICY_DRIVE);

module.exports = Object.assign({ POLICY_DRIVE }, drive, policy.bind(drive.state, drive));
