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

const { AsyncLocalStorage } = require('async_hooks');
const config = require('../config');
const { getLogger } = require('../lib/logger');
const logger = getLogger();

// Set while a _waitFor poll runs its check, per async call chain, so a direct
// check* caller running at the same moment keeps the null-on-error contract.
const insideWaitPoll = new AsyncLocalStorage();

// Answer a failed lookup query: rethrow it inside a _waitFor poll, so a wait can
// tell "the database never answered" from "no row", and return `fallback` elsewhere.
function rethrowInsideWait(err, fallback = null){
    if (insideWaitPoll.getStore()) throw err
    return fallback
}

module.exports = { config, logger, insideWaitPoll, rethrowInsideWait }
