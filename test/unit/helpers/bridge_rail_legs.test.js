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

function dryRun(files, extraEnv = {}) {
    const child = spawnSync(MOCHA,
        ['--no-config', '--dry-run', '--reporter', 'json', ...files], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            env: {
                COIN: 'bitcoin',
                NETWORK: 'regtest',
                PATH: process.env.PATH,
                XCHAIN_HUB_PATH: process.env.XCHAIN_HUB_PATH,
                ...extraEnv,
            },
            maxBuffer: 64 * 1024 * 1024,
        });
    assert.strictEqual(child.status, 0, child.stderr || child.stdout);
    const reportStart = child.stdout.indexOf('{\n  "stats":');
    assert.notStrictEqual(reportStart, -1, child.stdout);
    return JSON.parse(child.stdout.slice(reportStart));
}

function matchesFile(file, pattern) {
    const absolutePattern = path.resolve(REPO_ROOT, pattern);
    const wildcardAt = absolutePattern.indexOf('*');
    if (wildcardAt === -1) return file === absolutePattern;
    const prefix = absolutePattern.slice(0, wildcardAt);
    const suffix = absolutePattern.slice(wildcardAt + 1);
    const middle = file.slice(prefix.length, file.length - suffix.length);
    return file.startsWith(prefix) && file.endsWith(suffix) && !middle.includes(path.sep);
}

function reportForFiles(report, files) {
    const selected = (tests) => tests.filter((test) =>
        files.some((file) => matchesFile(test.file, file)));
    return {
        ...report,
        tests: selected(report.tests),
        passes: selected(report.passes),
        pending: selected(report.pending),
        failures: selected(report.failures),
    };
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
    it('requires federation for every anchor fold case', function () {
        const leg = RAIL_DRIVES.anchor_stake.legs.anchor_fold;

        assert.deepStrictEqual(leg.env, { E2E_REQUIRE_FEDERATION: '1', COIN: 'dogecoin', E2E_GAS_BOOTSTRAP: 'off' });
        assert.strictEqual(leg.minPassed, 5);
    });

    it('runs every DOGE-only anchor leg as dogecoin and the rest as bitcoin', function () {
        const { driveEnvCoin } = require('../../helpers/rail_leg_coins');
        assert.deepStrictEqual(RAIL_DRIVES.anchor_stake.legs.anchor_bundle.env, { COIN: 'dogecoin', E2E_GAS_BOOTSTRAP: 'off' });
        for (const [legName, leg] of Object.entries(RAIL_DRIVES.anchor_stake.legs)) {
            const coin = (leg.env && leg.env.COIN) || 'bitcoin';
            assert.strictEqual(coin, driveEnvCoin('anchor_stake', legName), legName);
        }
    });

    before(function () {
        this.timeout(120000);
        const allFiles = [...new Set(Object.values(RAIL_DRIVES).flatMap((drive) =>
            Object.values(drive.legs).flatMap((leg) =>
                leg.files || [...(drive.before || []), drive.root, drive.glob])))];
        const report = dryRun(allFiles);
        for (const [driveName, drive] of Object.entries(RAIL_DRIVES)) {
            reports[driveName] = {};
            for (const [legName, leg] of Object.entries(drive.legs)) {
                const files = leg.files || [...(drive.before || []), drive.root, drive.glob];
                const legReport = leg.env ? dryRun(files, leg.env) : report;
                reports[driveName][legName] = reportForFiles(legReport, files);
            }
        }
    });

    it('matches every leg minimum to the non-pending dry-run bare titles', function () {
        for (const [driveName, drive] of Object.entries(RAIL_DRIVES)) {
            for (const [legName, leg] of Object.entries(drive.legs)) {
                const titles = reports[driveName][legName].passes.map((test) => test.title);
                const selected = selectedTitles(titles, leg.grep);
                assert.strictEqual(selected.length, leg.minPassed,
                    driveName + '.' + legName + ' selected:\n' + selected.join('\n'));
            }
        }
    });

    it('full-title selection contains every bare-title selection', function () {
        for (const [driveName, drive] of Object.entries(RAIL_DRIVES)) {
            for (const [legName, leg] of Object.entries(drive.legs)) {
                const titleSelected = reports[driveName][legName].passes.filter((test) =>
                    selectedTitles([test.title], leg.grep).length > 0);
                const fullSelected = new Set(reports[driveName][legName].passes.filter((test) =>
                    selectedTitles([test.fullTitle], leg.grep).length > 0));
                assert.ok(titleSelected.every((test) => fullSelected.has(test)),
                    driveName + '.' + legName);
            }
        }
    });

    it('includes every root T0 case in every split leg', function () {
        // The policy and token drives open with two T0 cases; list_share opens with one.
        const T0_COUNT = { list_share: 1 };
        for (const [driveName, drive] of Object.entries(RAIL_DRIVES)) {
            // A drive that only runs whole has no split leg to carry its T0 cases into.
            if (Object.keys(drive.legs).every((legName) => legName === 'full')) continue;
            if (Object.values(drive.legs).some((leg) => leg.files)) continue;
            const titles = reports[driveName].full.passes.map((test) => test.fullTitle);
            const t0 = titles.filter((title) => title.includes(driveName + ' T0:'));
            assert.strictEqual(t0.length, T0_COUNT[driveName] || 2, driveName + ' root T0 count');
            for (const [legName, leg] of Object.entries(drive.legs)) {
                if (legName === 'full') continue;
                const selected = new Set(selectedTitles(titles, leg.grep));
                assert.ok(t0.every((title) => selected.has(title)), driveName + '.' + legName);
            }
        }
    });

    it('selects, in every split policy leg, the upstream cases each selected case reads', function () {
        const dependencies = [
            ['policy AT1 (mirror):', ['policy AT1 (opt-in):']],
            ['policy AT1 (enforced):', ['policy AT1 (mirror):']],
            ['policy AT2 (edit):', ['policy AT1 (enforced):']],
            ['policy AT2 (reads):', ['policy AT2 (edit):']],
            ['policy AT2 (verdicts flip):', ['policy AT2 (edit):']],
            ['policy AT3:', ['policy AT2 (edit):']],
            ['policy AT4 (falsification):', ['policy AT2 (edit):']],
            ['policy AT4 (seq gap):', ['policy AT4 (seq gap setup):']],
            ['policy AT5 (release):', ['policy AT5 (barrier):']],
            ['policy AT5 (abstain):', ['policy AT5 (barrier):']],
            ['policy AT6 (sleep):', ['policy AT2 (edit):']],
            ['policy AT6 (burn):', ['policy AT6 (sleep):']],
            ['policy AT6 (wake):', ['policy AT6 (sleep):']],
            ['policy AT9 (origin):', ['policy AT2 (edit):']],
            ['policy AT9 (copy):', ['policy AT9 (origin):']],
            ['policy AT8 (cap):', ['policy AT1 (mirror):', 'policy AT5 (barrier):']],
        ];
        const titles = reports.policy.full.passes.map((test) => test.title);
        for (const [legName, leg] of Object.entries(RAIL_DRIVES.policy.legs)) {
            if (legName === 'full') continue;
            const selected = selectedTitles(titles, leg.grep);
            for (const [readerPrefix, prerequisitePrefixes] of dependencies) {
                if (!selected.some((title) => title.startsWith(readerPrefix))) continue;
                for (const prefix of prerequisitePrefixes) {
                    assert.ok(selected.some((title) => title.startsWith(prefix)),
                        legName + ': ' + readerPrefix + ' requires ' + prefix);
                }
            }
        }
    });

    it('selects, in every split token leg, the upstream cases each selected case reads', function () {
        const dependencies = [
            ['token AT8 (ride-back):', ['token AT8: ']],
            ['token AT2:', ['token AT1:']],
            ['token AT4:', ['token AT1:']],
            ['token AT5 (falsification):', ['token AT1:']],
            ['token AT5 (existing row):', ['token AT1:']],
            ['token AT7:', ['token AT1:']],
            ['token AT8 (cap):', ['token AT1:']],
            ['token AT6 (opt-in direction):', ['token AT2:']],
            ['token AT6 (policy direction):',
                ['token AT2:', 'token AT3:', 'token AT5 (depth):']],
            ['token AT8 (invariant):',
                ['token AT1:', 'token AT2:', 'token AT8 (cap):']],
        ];
        const titles = reports.token.full.passes.map((test) => test.title);
        for (const [legName, leg] of Object.entries(RAIL_DRIVES.token.legs)) {
            if (legName === 'full') continue;
            const selected = selectedTitles(titles, leg.grep);
            for (const [readerPrefix, prerequisitePrefixes] of dependencies) {
                if (!selected.some((title) => title.startsWith(readerPrefix))) continue;
                for (const prefix of prerequisitePrefixes) {
                    assert.ok(selected.some((title) => title.startsWith(prefix)),
                        legName + ': ' + readerPrefix + ' requires ' + prefix);
                }
            }
        }
    });

    it('selects, in every split list_share leg, the upstream cases each selected case reads', function () {
        const dependencies = [
            ['list_share AT2:', ['list_share AT1:']],
            ['list_share AT3:', ['list_share AT1:']],
            ['list_share AT4:', ['list_share AT1:']],
            ['list_share AT5:', ['list_share AT4:']],
            ['list_share AT6:', ['list_share AT3:']],
            ['list_share AT7:', ['list_share AT5:']],
            ['list_share AT8:', ['list_share AT7:']],
        ];
        const titles = reports.list_share.full.passes.map((test) => test.title);
        for (const [legName, leg] of Object.entries(RAIL_DRIVES.list_share.legs)) {
            if (legName === 'full') continue;
            const selected = selectedTitles(titles, leg.grep);
            for (const [readerPrefix, prerequisitePrefixes] of dependencies) {
                if (!selected.some((title) => title.startsWith(readerPrefix))) continue;
                for (const prefix of prerequisitePrefixes) {
                    assert.ok(selected.some((title) => title.startsWith(prefix)),
                        legName + ': ' + readerPrefix + ' requires ' + prefix);
                }
            }
        }
    });

    it('covers every split-drivable policy title', function () {
        const drive = RAIL_DRIVES.policy;
        const titles = reports.policy.full.passes.map((test) => test.fullTitle);
        const covered = new Set();
        for (const [legName, leg] of Object.entries(drive.legs)) {
            if (legName === 'full') continue;
            for (const title of selectedTitles(titles, leg.grep)) covered.add(title);
        }
        const uncovered = titles.filter((title) => !covered.has(title));
        assert.strictEqual(uncovered.length, 0, uncovered.join('\n'));
    });

    it('selects the AT8 invariant and its prerequisite ticks', function () {
        const grep = RAIL_DRIVES.policy.legs.at8_invariant.grep;
        const titles = [
            'policy AT4 (seq gap setup):',
            'policy AT5 (barrier):',
            'policy AT5 (release):',
            'policy AT8 (invariant):',
        ];
        assert.deepStrictEqual(selectedTitles(titles, grep), titles);
    });

    it('includes every detach title in the full drive and its split leg', function () {
        const titles = reports.policy.full.passes.map((test) => test.fullTitle);
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
