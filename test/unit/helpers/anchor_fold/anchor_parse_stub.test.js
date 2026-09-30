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

const {
    makeAnchorParseContext,
    anchorParseArgs
} = require('../../../helpers/anchor_fold/anchor_parse_stub');

const ROOT = path.resolve(__dirname, '../../../../..');
const INDEXER_ANCHOR = path.join(ROOT, 'xchain-indexer/src/actions/anchor/index.js');
const VECTOR_PATH = path.join(
    ROOT, 'xchain-documentation/protocol/test-vectors/anchor_canonical.json');

async function withFreshModule(modulePath, run){
    const before = new Map(Object.entries(require.cache));
    const resolved = require.resolve(modulePath);
    delete require.cache[resolved];
    try {
        return await run(require(resolved));
    } finally {
        for(const key of Object.keys(require.cache)){
            if(!before.has(key)) delete require.cache[key];
        }
        for(const [key, value] of before) require.cache[key] = value;
    }
}

describe('anchor parse stub', function () {
    it('records shallow row copies in call order', async function () {
        const { action, rows } = makeAnchorParseContext({ coin: 'DOGE', network: 'regtest' });
        const first = { CHAIN: 'BTC', nested: { value: 1 } };
        const second = { CHAIN: 'LTC' };

        await action.indexerDb.createAnchorAction(first);
        await action.indexerDb.createAnchorAction(second);
        first.CHAIN = 'DOGE';

        assert.deepStrictEqual(rows.map(row => row.CHAIN), ['BTC', 'LTC']);
        assert.notStrictEqual(rows[0], first);
        assert.strictEqual(rows[0].nested, first.nested);
    });

    it('returns no capability or stake snapshot', async function () {
        const { action } = makeAnchorParseContext({ coin: 'DOGE', network: 'regtest' });
        assert.strictEqual(
            await action.indexerDb.getValidatorsByCapability('oracle_publish', 100), null);
        assert.strictEqual(
            await action.indexerDb.getStakeWeightsByCapability('oracle_publish', 100), null);
    });

    it('throws when the anchor parser reaches an undefined database method', function () {
        const { action } = makeAnchorParseContext({ coin: 'DOGE', network: 'regtest' });
        assert.throws(
            () => action.indexerDb.unexpectedRead(),
            /anchor parse stub: unexpected indexerDb\.unexpectedRead/);
    });

    it('drives the frozen v0 wire through the sibling indexer parser', async function () {
        if(!fs.existsSync(INDEXER_ANCHOR)){
            console.log('skipped: sibling indexer is absent');
            this.skip();
            return;
        }

        const golden = require(VECTOR_PATH);
        const { action, rows } = makeAnchorParseContext({ coin: 'DOGE', network: 'regtest' });
        const args = anchorParseArgs(golden.vectors.v0, {
            blockIndex: 1000000000,
            txHash: 'anchor-v0-vector',
            source: 'anchor-v0-publisher'
        });

        await withFreshModule(INDEXER_ANCHOR, async Anchor => {
            const anchor = new Anchor(action);
            await anchor.parse(args.params, args.data, args.error);
        });

        const chains = new Set(golden.fixture.bundle.sections.map(section => section.chain));
        assert.ok(rows.length > 0, 'the v0 parser must record at least one row');
        assert.ok(rows.every(row => chains.has(row.CHAIN)), 'every row must name a bundle chain');
        assert.ok(rows.every(row => row.STATUS === 'unverified'),
            'missing validator snapshots must store unverified rows');
    });
});
