'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const POLICY_ROOT = ['policy AT1 precondition:', 'policy AT8 control'];
const POLICY_AT1 = 'policy AT1 \\((?:opt-in|mirror|enforced)\\):';
const POLICY_AT5_LAG = 'policy AT5 \\((?:barrier|release)\\):';
const TOKEN_ROOT = ['token AT1 precondition:', 'token AT8 control'];
const TOKEN_AT1 = 'token AT1:';

const RAIL_DRIVES = {
    policy: {
        root: 'test/integration/bridge_rail_policy.test.js',
        glob: 'test/integration/bridge_rail_policy.test/*.test.js',
        legs: {
            at1: {
                grep: [...POLICY_ROOT, POLICY_AT1].join('|'),
                minPassed: 5,
            },
            at2_chain: {
                grep: [...POLICY_ROOT, POLICY_AT1, 'policy AT2 \\(', 'policy AT3:',
                    'policy AT4 \\(falsification\\):'].join('|'),
                minPassed: 14,
            },
            at6_at9: {
                grep: [...POLICY_ROOT, POLICY_AT1, 'policy AT2 \\(', 'policy AT6 \\(',
                    'policy AT9 \\('].join('|'),
                minPassed: 13,
            },
            at4_gap: {
                grep: [...POLICY_ROOT, 'policy AT4 \\(seq gap(?: setup)?\\):'].join('|'),
                minPassed: 4,
            },
            at5_barrier: {
                grep: [...POLICY_ROOT, POLICY_AT5_LAG].join('|'),
                minPassed: 4,
            },
            at8_invariant: {
                grep: [...POLICY_ROOT, 'policy AT4 \\(seq gap(?: setup)?\\):',
                    POLICY_AT5_LAG,
                    'policy AT8 \\(invariant\\):'].join('|'),
                minPassed: 7,
            },
            at5_abstain: {
                grep: [...POLICY_ROOT, POLICY_AT5_LAG, 'policy AT5 \\(abstain\\):'].join('|'),
                minPassed: 5,
            },
            at7_at8: {
                grep: [...POLICY_ROOT, POLICY_AT1, POLICY_AT5_LAG,
                    'policy AT7 \\(above the flag\\):',
                    'policy AT8 \\((?:cap|reorg)\\):'].join('|'),
                minPassed: 10,
            },
            at11_detach: {
                grep: [...POLICY_ROOT, 'policy AT11:'].join('|'),
                minPassed: 8,
            },
            full: { grep: null, minPassed: 34 },
        },
    },
    token: {
        root: 'test/integration/bridge_rail_token.test.js',
        glob: 'test/integration/bridge_rail_token.test/*.test.js',
        legs: {
            retract_at1_at2: {
                grep: [...TOKEN_ROOT, TOKEN_AT1, 'token AT2:', 'token AT8:',
                    'token AT8 \\(ride-back\\):'].join('|'),
                minPassed: 8,
            },
            at3_at4: {
                grep: [...TOKEN_ROOT, TOKEN_AT1, 'token AT3:', 'token AT4:'].join('|'),
                minPassed: 10,
            },
            at5_at6: {
                grep: [...TOKEN_ROOT, TOKEN_AT1, 'token AT2:', 'token AT3:',
                    'token AT5 \\(', 'token AT6 \\('].join('|'),
                minPassed: 16,
            },
            at7_at8: {
                grep: [...TOKEN_ROOT, TOKEN_AT1, 'token AT2:', 'token AT7:',
                    'token AT8 \\((?:cap|invariant)\\):'].join('|'),
                minPassed: 9,
            },
            full: { grep: null, minPassed: 27 },
        },
    },
};

module.exports = { RAIL_DRIVES };

if (require.main === module) {
    const [driveName, legName] = process.argv.slice(2);
    const drive = RAIL_DRIVES[driveName];
    if (!drive) {
        console.error('Unknown bridge rail drive: ' + String(driveName));
        process.exitCode = 1;
    } else if (!drive.legs[legName]) {
        console.error('Unknown ' + driveName + ' bridge rail leg: ' + String(legName));
        process.exitCode = 1;
    } else {
        console.log(drive.legs[legName].grep || '');
    }
}
