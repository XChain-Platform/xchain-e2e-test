'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

function loadRailGateContract(options = {}) {
    const fixturePath = options.fixturePath || FIXTURE_PATH;
    const home = options.home || process.env.HOME || os.homedir();
    const dispatcherPath = options.dispatcherPath ||
        path.join(home, '.claude', 'bin', 'ci-dispatch.sh');
    const log = options.log || console.log;
    const fixture = readFixture(fixturePath);

    if (!fs.existsSync(dispatcherPath)) {
        log('rail gate contract: host tooling absent; using fixture ' + fixturePath);
        return fixture;
    }

    const hostContract = contractFromDispatcher(fs.readFileSync(dispatcherPath, 'utf8'), dispatcherPath);
    try {
        assert.deepStrictEqual(hostContract, fixture);
    } catch (cause) {
        const error = new Error('rail gate contract drift: fixture ' + fixturePath +
            ' does not match host dispatcher ' + dispatcherPath);
        error.cause = cause;
        throw error;
    }
    return fixture;
}

module.exports = loadRailGateContract;
module.exports.contractFromDispatcher = contractFromDispatcher;
module.exports.FIXTURE_PATH = FIXTURE_PATH;
