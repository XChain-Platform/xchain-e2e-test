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
 * XChain Platform E2E (unit) - contract-template deploy plans
 *
 * The flagship template drills (crowdsale, amm) deploy sources that no longer
 * fit one action. Two ways that regresses without a live stack noticing:
 *
 *   1. the plan itself goes bad (too many chunks to carry, or slices that do
 *      not reassemble byte-exact), and
 *   2. a suite quietly reverts to a size check that SKIPS itself, which lets
 *      amm report green for weeks while never deploying.
 *
 * Both are checked here, off-chain, so a red venue is not a prerequisite.
 *
 ********************************************************************/

'use strict';

const fs     = require('fs');
const path   = require('path');
const assert = require('assert');

const { loadCompactTemplate, templateCandidates } = require('../../sdk/templateHelper');
const { chunkHelper } = require('../../sdk/sdkHelper').loadSDK();

const SDK_DIR = path.join(__dirname, '..', '..', 'sdk');

// Constructor params the live suites pass, at their realistic widths: they ride
// in the same action as the code, so a plan sized without them is a plan that
// can still overflow on-chain.
const TEMPLATES = [
    {
        name: 'crowdsale',
        suite: 'crowdsaleTemplate.sdk.test.js',
        gasLimit: 500000,
        constructorParams: ['mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef', 'PAY123456789', 'SALE12345678', '2', '100', '200', '1000', '0'],
    },
    {
        name: 'amm',
        suite: 'ammTemplate.sdk.test.js',
        gasLimit: 400000,
        constructorParams: ['AMA123456789', 'AMB123456789', 'AMLP12345678'],
    },
];

function haveTemplates() {
    return templateCandidates('crowdsale').some(c => fs.existsSync(c));
}

describe('[unit] contract-template deploy plans', function () {

    TEMPLATES.forEach(function (t) {

        describe(t.name, function () {

            it('plans a deploy the protocol can actually carry', function () {
                if (!haveTemplates()) return this.skip(); // no xchain-contracts checkout beside this repo
                const src  = loadCompactTemplate(t.name);
                const plan = chunkHelper.planDeploy(src, { gasLimit: t.gasLimit, constructorParams: t.constructorParams });

                if (plan.single) {
                    // Fine (a slimmed template is the other valid fix here),
                    // but then there is nothing to reassemble.
                    assert.strictEqual(plan.parts, null, 'single-shot plan carries no parts');
                    return;
                }

                assert.ok(plan.totalChunks > 1, t.name + ' needs more than one chunk');
                assert.ok(plan.totalChunks <= chunkHelper.MAX_DEPLOY_CHUNKS,
                    t.name + ' needs ' + plan.totalChunks + ' chunks, over MAX_DEPLOY_CHUNKS ' + chunkHelper.MAX_DEPLOY_CHUNKS);
                plan.parts.forEach(function (p, i) {
                    assert.ok(Buffer.byteLength(p, 'utf8') <= chunkHelper.MAX_DEPLOYCHUNK_PART_BYTES,
                        t.name + ' chunk ' + i + ' exceeds MAX_DEPLOYCHUNK_PART_BYTES');
                });

                // What the indexer does: concatenate in order, base64-decode,
                // sha256 against CODE_HASH. Byte-exact or the constructor runs
                // on a different program than the one the author wrote.
                const rebuilt = Buffer.from(plan.parts.join(''), 'base64').toString('utf8');
                assert.strictEqual(rebuilt, src, t.name + ' chunks do not reassemble byte-exact');
                assert.strictEqual(chunkHelper.codeHashOf(rebuilt), plan.codeHash, t.name + ' reassembled CODE_HASH mismatch');
            });

            it('drives its DEPLOY through deployContract rather than skipping on size', function () {
                const suite = fs.readFileSync(path.join(SDK_DIR, t.suite), 'utf8');
                assert.ok(/deployContract\(/.test(suite), t.suite + ' must deploy via sdkHelper.deployContract');
                assert.ok(!/Needs chunked DEPLOY/.test(suite), t.suite + ' still self-skips instead of chunking');
                assert.ok(!/MAX_DATA_BYTES/.test(suite), t.suite + ' still gates itself on a hand-rolled payload-size check');
            });
        });
    });
});
