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

// Registers the assertions of this part inside the caller's describe, reading
// what its before() put on ctx.
const parts = [
    require('./parts/counter'),
    require('./parts/deadletter'),
    require('./parts/loud'),
    require('./parts/neighbours'),
];

module.exports = function register(ctx) {
    for (const part of parts) part(ctx);
};
