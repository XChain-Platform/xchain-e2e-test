/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.resolve(__dirname, '../../../..');

const STATE_HASH_PATHS = [
    'xchain-indexer/src/consensus/state_hash.js',
    'xchain-sync/src/consensus/state_hash.js'
];

const stateHashBytes = STATE_HASH_PATHS.map(relativePath =>
    fs.readFileSync(path.join(ROOT, relativePath)));
const stateHashSources = stateHashBytes.map(source => source.toString('utf8'));

describe('anchor state-hash twin parity', function () {
    it('keeps the indexer and sync state-hash sources byte-identical', function () {
        assert.deepStrictEqual(stateHashBytes[1], stateHashBytes[0],
            'xchain-sync state_hash.js drifted from the xchain-indexer source');
    });

    it('defines both anchor row-family predicates in each twin', function () {
        const predicates = ['archiveHeadPredicate', 'checkpointSectionPredicate'];

        for (const [index, source] of stateHashSources.entries()) {
            for (const predicate of predicates) {
                const definition = new RegExp('function\\s+' + predicate + '\\s*\\(');
                assert.match(source, definition,
                    STATE_HASH_PATHS[index] + ' must define ' + predicate);
            }
        }
    });
});
