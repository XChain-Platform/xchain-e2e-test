// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict'

const { registerHooks } = require('./db.test/setup.test')

registerHooks()

require('./db.test/connections.test')
require('./db.test/check_transactions.test')
require('./db.test/check_advanced.test')
require('./db.test/waits.test')
require('./db.test/state_and_lists.test')
