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

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withMiningPaused } = require('../../helpers/bridgeRailVenue');

const BTC_ENV = 'BRIDGE_RAIL_MINER_PAUSE_FILE';
const DOGE_ENV = 'BRIDGE_RAIL_DOGE_MINER_PAUSE_FILE';

describe('bridgeRailVenue: miner pause files', function () {
    let tempDir;
    let priorBtc;
    let priorDoge;

    beforeEach(function () {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-rail-miner-pause-'));
        priorBtc = process.env[BTC_ENV];
        priorDoge = process.env[DOGE_ENV];
        delete process.env[BTC_ENV];
        delete process.env[DOGE_ENV];
    });

    afterEach(function () {
        if (priorBtc === undefined) delete process.env[BTC_ENV];
        else process.env[BTC_ENV] = priorBtc;
        if (priorDoge === undefined) delete process.env[DOGE_ENV];
        else process.env[DOGE_ENV] = priorDoge;
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    function minerStub(events) {
        return {
            async pauseMining() { events.push('pause'); },
            async resumeMining() { events.push('resume'); },
        };
    }

    it('creates and removes only the BTC file when only its variable is set', async function () {
        const btc = path.join(tempDir, 'btc.pause');
        const doge = path.join(tempDir, 'doge.pause');
        const events = [];
        process.env[BTC_ENV] = btc;

        await withMiningPaused(minerStub(events), async () => {
            assert.strictEqual(fs.existsSync(btc), true);
            assert.strictEqual(fs.existsSync(doge), false);
            events.push('fn');
        });

        assert.strictEqual(fs.existsSync(btc), false);
        assert.deepStrictEqual(events, ['pause', 'fn', 'resume']);
    });

    it('creates and removes only the DOGE file when only its variable is set', async function () {
        const btc = path.join(tempDir, 'btc.pause');
        const doge = path.join(tempDir, 'doge.pause');
        process.env[DOGE_ENV] = doge;

        await withMiningPaused(minerStub([]), async () => {
            assert.strictEqual(fs.existsSync(doge), true);
            assert.strictEqual(fs.existsSync(btc), false);
        });

        assert.strictEqual(fs.existsSync(doge), false);
    });

    it('creates and removes both independently configured files', async function () {
        const btc = path.join(tempDir, 'btc.pause');
        const doge = path.join(tempDir, 'doge.pause');
        process.env[BTC_ENV] = btc;
        process.env[DOGE_ENV] = doge;

        await withMiningPaused(minerStub([]), async () => {
            assert.strictEqual(fs.existsSync(btc), true);
            assert.strictEqual(fs.existsSync(doge), true);
        });

        assert.strictEqual(fs.existsSync(btc), false);
        assert.strictEqual(fs.existsSync(doge), false);
    });

    it('writes no file but still pauses and resumes when neither variable is set', async function () {
        const events = [];

        const result = await withMiningPaused(minerStub(events), async () => {
            events.push('fn');
            assert.deepStrictEqual(fs.readdirSync(tempDir), []);
            return 'done';
        });

        assert.strictEqual(result, 'done');
        assert.deepStrictEqual(events, ['pause', 'fn', 'resume']);
        assert.deepStrictEqual(fs.readdirSync(tempDir), []);
    });

    it('removes every created file and resumes when fn throws', async function () {
        const btc = path.join(tempDir, 'btc.pause');
        const doge = path.join(tempDir, 'doge.pause');
        const events = [];
        process.env[BTC_ENV] = btc;
        process.env[DOGE_ENV] = doge;

        await assert.rejects(
            withMiningPaused(minerStub(events), async () => {
                assert.strictEqual(fs.existsSync(btc), true);
                assert.strictEqual(fs.existsSync(doge), true);
                events.push('fn');
                throw new Error('case failed');
            }),
            /case failed/);

        assert.strictEqual(fs.existsSync(btc), false);
        assert.strictEqual(fs.existsSync(doge), false);
        assert.deepStrictEqual(events, ['pause', 'fn', 'resume']);
    });

    it('surfaces a write failure, cleans earlier files, and resumes', async function () {
        const btc = path.join(tempDir, 'btc.pause');
        const missingDirDoge = path.join(tempDir, 'missing', 'doge.pause');
        const events = [];
        process.env[BTC_ENV] = btc;
        process.env[DOGE_ENV] = missingDirDoge;

        await assert.rejects(
            withMiningPaused(minerStub(events), async () => events.push('fn')),
            /ENOENT/);

        assert.strictEqual(fs.existsSync(btc), false);
        assert.deepStrictEqual(events, ['pause', 'resume']);
    });

    it('swallows already-removed flag files and still resumes', async function () {
        const btc = path.join(tempDir, 'btc.pause');
        const doge = path.join(tempDir, 'doge.pause');
        const events = [];
        process.env[BTC_ENV] = btc;
        process.env[DOGE_ENV] = doge;

        await withMiningPaused(minerStub(events), async () => {
            fs.unlinkSync(btc);
            fs.unlinkSync(doge);
            events.push('fn');
        });

        assert.deepStrictEqual(events, ['pause', 'fn', 'resume']);
    });
});
