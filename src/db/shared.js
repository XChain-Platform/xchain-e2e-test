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
 * Module state shared by the Database parts
 *
 ********************************************************************/

const config = require('../config');
const { getLogger } = require('../lib/logger');
const logger = getLogger();

// Failed queries must stay distinct from successful lookups that found no row.
function rethrowQueryError(err){
    throw err
}

module.exports = { config, logger, rethrowQueryError }
