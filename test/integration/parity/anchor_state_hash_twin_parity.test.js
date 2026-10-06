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

const TWIN_ROOTS = [
    'xchain-indexer/src/consensus',
    'xchain-sync/src/consensus'
];

// The state-hash code is the facade state_hash.js plus every file under the
// state_hash/ directory it delegates to. Returns them as relative-path keyed bytes,
// sorted so two twins compare file by file.
function readStateHash (twinRoot) {
    const base = path.join(ROOT, twinRoot);
    const files = { 'state_hash.js': fs.readFileSync(path.join(base, 'state_hash.js')) };
    const walk = (dir, prefix) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const rel = prefix + entry.name;
            if (entry.isDirectory()) walk(path.join(dir, entry.name), rel + '/');
            else files[rel] = fs.readFileSync(path.join(dir, entry.name));
        }
    };
    walk(path.join(base, 'state_hash'), 'state_hash/');
    return Object.fromEntries(Object.keys(files).sort().map(name => [name, files[name]]));
}

const twins = TWIN_ROOTS.map(readStateHash);

describe('anchor state-hash twin parity', function () {
    it('keeps the indexer and sync state-hash sources byte-identical', function () {
        assert.deepStrictEqual(Object.keys(twins[1]), Object.keys(twins[0]),
            'xchain-sync state-hash file set drifted from the xchain-indexer source');
        for (const name of Object.keys(twins[0])) {
            assert.deepStrictEqual(twins[1][name], twins[0][name],
                'xchain-sync ' + name + ' drifted from the xchain-indexer source');
        }
    });

    it('defines both anchor row-family predicates in each twin', function () {
        const predicates = ['archiveHeadPredicate', 'checkpointSectionPredicate'];

        for (const [index, files] of twins.entries()) {
            const source = Object.values(files).map(bytes => bytes.toString('utf8')).join('\n');
            for (const predicate of predicates) {
                const definition = new RegExp('function\\s+' + predicate + '\\s*\\(');
                assert.match(source, definition,
                    TWIN_ROOTS[index] + ' state_hash must define ' + predicate);
            }
        }
    });
});
