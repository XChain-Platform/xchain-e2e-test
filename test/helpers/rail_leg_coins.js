'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const DOGECOIN_ANCHOR_STAKE_LEGS = new Set([
    'anchor_fold',
    'anchor_bundle',
    'archive_count',
]);

function driveEnvCoin(drive, leg) {
    if (drive === 'anchor_stake' && DOGECOIN_ANCHOR_STAKE_LEGS.has(leg)) {
        return 'dogecoin';
    }
    return 'bitcoin';
}

module.exports = { driveEnvCoin };

if (require.main === module) {
    const [drive, leg] = process.argv.slice(2);
    if (!drive || !leg) {
        process.exitCode = 2;
    } else {
        console.log(driveEnvCoin(drive, leg));
    }
}
