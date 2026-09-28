'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const { DETACH_STEPS } = require('../../helpers/bridge_detach_plan');
const { RAIL_DRIVES } = require('../../helpers/bridge_rail_legs');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const MOCHA = './node_modules/.bin/mocha';
const HELPER = path.join(REPO_ROOT, 'test', 'helpers', 'bridge_rail_legs.js');
const reports = {};

function dryRun(drive) {
    const child = spawnSync(MOCHA,
        ['--no-config', '--dry-run', '--reporter', 'json', drive.root, drive.glob], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            env: { COIN: 'bitcoin', NETWORK: 'regtest', PATH: process.env.PATH },
            maxBuffer: 64 * 1024 * 1024,
        });
    assert.strictEqual(child.status, 0, child.stderr || child.stdout);
    return JSON.parse(child.stdout);
}

function selectedTitles(titles, grep) {
    if (!grep) return titles.slice();
    const pattern = new RegExp(grep);
    return titles.filter((title) => pattern.test(title));
}

function runCli(drive, leg) {
    return spawnSync(process.execPath, [HELPER, drive, leg], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
    });
}

describe('bridge rail leg map', function () {
    before(function () {
        this.timeout(120000);
        for (const [name, drive] of Object.entries(RAIL_DRIVES)) reports[name] = dryRun(drive);
    });

    it('matches every leg minimum to the non-pending dry-run titles', function () {
        for (const [driveName, drive] of Object.entries(RAIL_DRIVES)) {
            const titles = reports[driveName].passes.map((test) => test.fullTitle);
            for (const [legName, leg] of Object.entries(drive.legs)) {
                const selected = selectedTitles(titles, leg.grep);
                assert.strictEqual(selected.length, leg.minPassed,
                    driveName + '.' + legName + ' selected:\n' + selected.join('\n'));
            }
        }
    });

    it('includes both root T0 cases in every split leg', function () {
        for (const [driveName, drive] of Object.entries(RAIL_DRIVES)) {
            const titles = reports[driveName].passes.map((test) => test.fullTitle);
            const t0 = titles.filter((title) => title.includes(driveName + ' T0:'));
            assert.strictEqual(t0.length, 2, driveName + ' root T0 count');
            for (const [legName, leg] of Object.entries(drive.legs)) {
                if (legName === 'full') continue;
                const selected = new Set(selectedTitles(titles, leg.grep));
                assert.ok(t0.every((title) => selected.has(title)), driveName + '.' + legName);
            }
        }
    });

    it('covers every split-drivable policy title except the AT8 invariant', function () {
        const drive = RAIL_DRIVES.policy;
        const titles = reports.policy.passes.map((test) => test.fullTitle);
        const covered = new Set();
        for (const [legName, leg] of Object.entries(drive.legs)) {
            if (legName === 'full') continue;
            for (const title of selectedTitles(titles, leg.grep)) covered.add(title);
        }
        const uncovered = titles.filter((title) => !covered.has(title));
        assert.strictEqual(uncovered.length, 1, uncovered.join('\n'));
        assert.match(uncovered[0], /policy AT8 \(invariant\):/);
    });

    it('includes every detach title in the full drive and its split leg', function () {
        const titles = reports.policy.passes.map((test) => test.fullTitle);
        const detachTitles = titles.filter((title) => title.includes('policy AT11:'));
        const selected = selectedTitles(titles, RAIL_DRIVES.policy.legs.at11_detach.grep);

        assert.deepStrictEqual(detachTitles.map((title) => title.split('policy AT11: ').pop()),
            DETACH_STEPS.map((step) => step.name));
        assert.ok(detachTitles.every((title) => selected.includes(title)));
    });

    it('prints grep sources and names unknown CLI arguments', function () {
        const known = runCli('policy', 'at1');
        assert.strictEqual(known.status, 0);
        assert.strictEqual(known.stdout.trim(), RAIL_DRIVES.policy.legs.at1.grep);
        const full = runCli('token', 'full');
        assert.strictEqual(full.status, 0);
        assert.strictEqual(full.stdout, '\n');
        const badDrive = runCli('missing', 'full');
        assert.strictEqual(badDrive.status, 1);
        assert.match(badDrive.stderr, /Unknown bridge rail drive: missing/);
        const badLeg = runCli('policy', 'missing');
        assert.strictEqual(badLeg.status, 1);
        assert.match(badLeg.stderr, /Unknown policy bridge rail leg: missing/);
    });
});
