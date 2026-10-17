'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const FIXTURE_PATH = path.resolve(__dirname, '..', '..', 'fixtures', 'rail', 'ci_gate_contract.json');

function sortedUnique(values) {
    return [...new Set(values)].sort((a, b) => a - b);
}

function contractFromDispatcher(source, dispatcherPath) {
    const dispatchLoop = /while\s+:\s*;\s*do[\s\S]*?case\s+\$rc\s+in([\s\S]*?)^\s{4}esac/m.exec(source);
    assert.ok(dispatchLoop, 'cannot read the exit table from host dispatcher ' + dispatcherPath);

    const reserved = [];
    const armPattern = /^\s+(\d+)\)/gm;
    let arm;
    while ((arm = armPattern.exec(dispatchLoop[1])) !== null) reserved.push(Number(arm[1]));

    const queueBlock = /if \[ \$now -ge \$deadline \]; then([\s\S]*?)^\s{2}fi/m.exec(source);
    const queueExit = queueBlock && /\bexit\s+(\d+)\b/.exec(queueBlock[1]);
    assert.ok(reserved.length && queueExit,
        'cannot read the complete exit table from host dispatcher ' + dispatcherPath);

    const queueTimeout = Number(queueExit[1]);
    const dispatcherReservedExits = sortedUnique([...reserved, queueTimeout]);
    const gateDidNotRunExits = dispatcherReservedExits.filter((code) => code !== 92 && code !== 93);
    return { dispatcherReservedExits, gateDidNotRunExits };
}

function readFixture(fixturePath) {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    assert.deepStrictEqual(Object.keys(fixture).sort(),
        ['dispatcherReservedExits', 'gateDidNotRunExits']);
    for (const key of Object.keys(fixture)) {
        assert.deepStrictEqual(fixture[key], sortedUnique(fixture[key]),
            fixturePath + ' has an invalid ' + key + ' list');
    }
    return fixture;
}

function dispatcherPath(options = {}) {
    const home = options.home || process.env.HOME || os.homedir();
    return options.dispatcherPath || path.join(home, '.claude', 'bin', 'ci-dispatch.sh');
}

function loadRailGateContract(options = {}) {
    const fixturePath = options.fixturePath || FIXTURE_PATH;
    const resolvedDispatcherPath = dispatcherPath(options);
    const log = options.log || console.log;
    const fixture = readFixture(fixturePath);

    if (!fs.existsSync(resolvedDispatcherPath)) {
        log('rail gate contract: host tooling absent; using fixture ' + fixturePath);
        return fixture;
    }

    const hostContract = contractFromDispatcher(
        fs.readFileSync(resolvedDispatcherPath, 'utf8'), resolvedDispatcherPath);
    try {
        assert.deepStrictEqual(hostContract, fixture);
    } catch (cause) {
        const error = new Error('rail gate contract drift: fixture ' + fixturePath +
            ' does not match host dispatcher ' + resolvedDispatcherPath);
        error.cause = cause;
        throw error;
    }
    return fixture;
}

// CI_VENUES entries are "host" or "host:detail"; the host part is what ssh dials.
function venueHostList(spec) {
    return String(spec || '').trim().split(/\s+/).filter(Boolean).map((entry) => entry.split(':')[0]);
}

// Pick where AT9 runs the direct full gate. With CI_VENUES set it is the first venue the
// probe reaches, never the drive host; without it the gate stays on the drive host.
function directGateTarget(ciVenues, options = {}) {
    const hosts = venueHostList(ciVenues);
    const driveHost = options.hostname || os.hostname();
    if (!hosts.length) return { venue: driveHost, transport: 'direct', remote: false, tried: [] };
    const probe = options.probe || function (host) {
        const res = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host, 'true'],
            { encoding: 'utf8', timeout: 20000 });
        return res.status === 0;
    };
    const tried = [];
    for (const host of hosts) {
        tried.push(host);
        if (probe(host)) return { venue: host, transport: 'ssh', remote: true, tried };
    }
    const error = new Error('no CI venue is reachable from ' + driveHost + ' (tried ' + tried.join(', ') + ')');
    error.tried = tried;
    throw error;
}

const VENUE_TREE_ENV = 'CI_VENUE_E2E_TREE';
const VENUE_TREE_DEFAULT = '$HOME/xchain-e2e-test';

// Remote script for the ci-venue-worktree transport. The venue keeps a cached e2e tree whose
// parent holds the sibling checkouts and whose node_modules is installed. The graded head
// arrives as a tar stream on stdin; it is laid over an xchain-e2e-test worktree in a scratch
// directory whose other entries link to the cached siblings, with the cached node_modules linked
// in. The gate runs there, and the worktree is removed on exit whatever the gate returned.
function venueWorktreeScript(options) {
    const tree = options.tree || '${' + VENUE_TREE_ENV + ':-' + VENUE_TREE_DEFAULT + '}';
    return [
        'set -e',
        'tree="' + tree + '"',
        '[ -d "$tree/.git" ] || { echo "ci-venue-worktree: no cached e2e tree at $tree" >&2; exit 1; }',
        'cache_parent=$(dirname "$tree")',
        'scratch=$(mktemp -d "$cache_parent/.at9-wt.XXXXXX")',
        'wt="$scratch/xchain-e2e-test"',
        'trap \'git -C "$tree" worktree remove --force "$wt" >/dev/null 2>&1 || rm -rf "$wt"; ' +
            'rm -rf "$scratch"; git -C "$tree" worktree prune >/dev/null 2>&1\' EXIT',
        'git -C "$tree" worktree add --detach "$scratch/xchain-e2e-test" HEAD >/dev/null',
        'for sibling in "$cache_parent"/*; do',
        '  [ "$sibling" = "$tree" ] || ln -s "$sibling" "$scratch/$(basename "$sibling")"',
        'done',
        'find "$wt" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +',
        'tar -x -C "$wt"',
        'if [ -d "$tree/node_modules" ] && [ ! -e "$wt/node_modules" ]; then ln -s "$tree/node_modules" "$wt/node_modules"; fi',
        'cd "$wt"',
        'CI_TIER=full ' + options.enclosingEnv + '=$(hostname) ' + options.command,
    ].join('\n');
}

module.exports = loadRailGateContract;
module.exports.venueWorktreeScript = venueWorktreeScript;
module.exports.VENUE_TREE_ENV = VENUE_TREE_ENV;
module.exports.directGateTarget = directGateTarget;
module.exports.venueHostList = venueHostList;
module.exports.contractFromDispatcher = contractFromDispatcher;
module.exports.dispatcherPath = dispatcherPath;
module.exports.FIXTURE_PATH = FIXTURE_PATH;
