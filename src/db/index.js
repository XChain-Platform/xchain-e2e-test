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
 * XChain End-to-End Test Suite - Database Class
 *
 * This file handles connecting to databases and running SQL queries.
 * The class is assembled from the named parts in this directory; src/db.js
 * re-exports it so callers keep requiring the same path.
 *
 ********************************************************************/

const DatabaseCore = require('./core')

// Order matters where two parts define the same name: a later part wins,
// as a later method did in the single class body.
const PARTS = [
    require('./tokens'),
    require('./broadcast_list'),
    require('./dispensers'),
    require('./wait'),
    require('./market'),
    require('./orders'),
    require('./contracts'),
    require('./staking')
]

class Database extends DatabaseCore {}

for (const Part of PARTS){
    for (const name of Reflect.ownKeys(Part.prototype)){
        if (name === 'constructor') continue
        Object.defineProperty(Database.prototype, name, Object.getOwnPropertyDescriptor(Part.prototype, name))
    }
}

module.exports = Database
