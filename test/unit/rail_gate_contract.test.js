'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const loadRailGateContract = require('../integration/lib/rail_gate_contract');
const fixture = require('../fixtures/rail/ci_gate_contract.json');

function dispatcherWith(exit95 = 95) {
    return `while :; do
    case $rc in
      99) continue ;;
      97) continue ;;
      ${exit95}) exit $rc ;;
      94) exit $rc ;;
      93) exit $rc ;;
      92) exit $rc ;;
      2) exit $rc ;;
      255) exit $rc ;;
      *) exit $rc ;;
    esac
  if [ $now -ge $deadline ]; then
    exit 3
  fi
done
`;
}

describe('rail gate contract loader', function () {
    let scratch;
    let originalHome;

    beforeEach(function () {
        scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rail-gate-contract-'));
        originalHome = process.env.HOME;
        process.env.HOME = scratch;
    });

    afterEach(function () {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        fs.rmSync(scratch, { recursive: true, force: true });
    });

    it('returns and names the checked-in fixture when HOME has no host tooling', function () {
        const lines = [];
        const actual = loadRailGateContract({ log: (line) => lines.push(line) });

        assert.deepStrictEqual(actual, fixture);
        assert.strictEqual(lines.length, 1);
        assert.ok(lines[0].includes(loadRailGateContract.FIXTURE_PATH), lines[0]);
    });

    it('accepts a host dispatcher whose exit table matches the fixture', function () {
        const dispatcher = path.join(scratch, '.claude', 'bin', 'ci-dispatch.sh');
        fs.mkdirSync(path.dirname(dispatcher), { recursive: true });
        fs.writeFileSync(dispatcher, dispatcherWith());

        assert.deepStrictEqual(loadRailGateContract(), fixture);
    });

    it('rejects exit-table drift and names both copies', function () {
        const dispatcher = path.join(scratch, '.claude', 'bin', 'ci-dispatch.sh');
        fs.mkdirSync(path.dirname(dispatcher), { recursive: true });
        fs.writeFileSync(dispatcher, dispatcherWith(96));

        assert.throws(() => loadRailGateContract(), (error) => {
            assert.ok(error.message.includes(loadRailGateContract.FIXTURE_PATH), error.message);
            assert.ok(error.message.includes(dispatcher), error.message);
            return true;
        });
    });
});
