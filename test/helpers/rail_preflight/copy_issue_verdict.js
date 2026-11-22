// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

// The verdict a user ISSUE of any format gets on a bridged copy such as BTC.<tick>:
// the indexer checks the parent owner (the keyless bridge role) before the tick owner.
const COPY_ISSUE_REFUSED = 'invalid: TICK (parent issued by another address)';

module.exports = { COPY_ISSUE_REFUSED };
