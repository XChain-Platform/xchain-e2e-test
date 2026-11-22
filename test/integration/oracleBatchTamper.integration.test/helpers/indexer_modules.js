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

const path = require('path');

// The indexer's own consensus modules, read from the repo a landing chain
// actually runs. `slash.js` pulls in only `ed25519.js` and
// `equivocation_header.js`, both of which depend on nothing but `crypto`, so the
// real handler loads here without a database driver or a running node. The handler
// is `actions/slash.js` on an older indexer and `actions/slash/index.js` once it moved
// into its parts directory; moduleEntry takes whichever exists and throws naming both
// when neither does.
const { moduleEntry } = require('../../../support/sibling_source.js');
const INDEXER_ROOT = path.resolve(__dirname, '../../../../../xchain-indexer');
const Slash = require(moduleEntry(path.join(INDEXER_ROOT, 'src', 'actions', 'slash.js')));
const eq      = require(path.join(INDEXER_ROOT, 'src', 'consensus', 'equivocation_header.js'));
const ed25519 = require(path.join(INDEXER_ROOT, 'src', 'consensus', 'ed25519.js'));

module.exports = { Slash, eq, ed25519 };
