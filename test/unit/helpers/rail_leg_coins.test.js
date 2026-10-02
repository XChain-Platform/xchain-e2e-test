'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const { driveEnvCoin } = require('../../helpers/rail_leg_coins');

const HELPER = path.resolve(__dirname, '..', '..', 'helpers', 'rail_leg_coins.js');

function runCli(...args) {
    return spawnSync(process.execPath, [HELPER, ...args], { encoding: 'utf8' });
}

describe('rail leg drive env coin', function () {
    it('uses dogecoin for the DOGE-only anchor stake legs', function () {
        assert.strictEqual(driveEnvCoin('anchor_stake', 'anchor_fold'), 'dogecoin');
        assert.strictEqual(driveEnvCoin('anchor_stake', 'anchor_bundle'), 'dogecoin');
        assert.strictEqual(driveEnvCoin('anchor_stake', 'archive_count'), 'dogecoin');
    });

    it('uses bitcoin for the other anchor stake legs', function () {
        assert.strictEqual(driveEnvCoin('anchor_stake', 'staking'), 'bitcoin');
        assert.strictEqual(driveEnvCoin('anchor_stake', 'capability_slash'), 'bitcoin');
        assert.strictEqual(driveEnvCoin('anchor_stake', 'vm_contract_slash'), 'bitcoin');
    });

    it('uses bitcoin for legs in other drives', function () {
        assert.strictEqual(driveEnvCoin('list_share', 'core'), 'bitcoin');
        assert.strictEqual(driveEnvCoin('contracts_price', 'dispenser'), 'bitcoin');
    });

    it('prints the selected coin from the CLI', function () {
        const dogecoin = runCli('anchor_stake', 'archive_count');
        assert.strictEqual(dogecoin.status, 0, dogecoin.stderr);
        assert.strictEqual(dogecoin.stdout, 'dogecoin\n');

        const bitcoin = runCli('anchor_stake', 'staking');
        assert.strictEqual(bitcoin.status, 0, bitcoin.stderr);
        assert.strictEqual(bitcoin.stdout, 'bitcoin\n');
    });

    it('exits 2 when either CLI argument is missing', function () {
        assert.strictEqual(runCli().status, 2);
        assert.strictEqual(runCli('anchor_stake').status, 2);
    });
});
