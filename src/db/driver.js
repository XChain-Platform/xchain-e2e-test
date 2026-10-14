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
 * Lazy mariadb driver lookup
 *
 ********************************************************************/

// The driver is resolved when a pool is created, NOT when this module is
// loaded. Tests mock mariadb by injecting a synthetic module into require.cache,
// and a module-level binding froze whichever driver happened to be cached the
// first time anything in the mocha process required this file. A new test file
// sorting alphabetically earlier than the injecting one left db.js bound to the
// REAL driver, so every `new Database()` opened a real pool against a dead host:
// 55 failures across unrelated describes, all timeouts pointing nowhere near the
// cause, and the injecting file still passed alone. require() re-reads
// require.cache on every call, so looking the driver up here makes injection
// order-independent: it only has to happen before the first `new Database()`.
const MARIADB_MODULE = 'mariadb';

function mariadbDriver(){ return require(MARIADB_MODULE); }

module.exports = { mariadbDriver }
