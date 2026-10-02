'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const POLICY_ROOT = ['policy AT1 precondition:', 'policy AT8 control'];
const POLICY_AT1 = 'policy AT1 \\((?:opt-in|mirror|enforced)\\):';
const POLICY_AT5_LAG = 'policy AT5 \\((?:barrier|release)\\):';
const TOKEN_ROOT = ['token AT1 precondition:', 'token AT8 control'];
const TOKEN_AT1 = 'token AT1:';
const ANCHOR_ARM_ENV_KEYS = [
    'XC_ANCHOR_FOLD_REGTEST_ACTIVATION',
    'XC_ANCHOR_STAKE_REGTEST_ACTIVATION',
    'XC_ANCHOR_SLASH_REGTEST_ACTIVATION',
];

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
    // The base spec's AT1 to AT9. Its cases share one venue and read each other's
    // evidence, so it runs whole. The DOGE guards suite goes first on the same command
    // line, as bridge_rail_base.test.js's header requires; its three cases are the
    // federation-free half of AT6, AT7 and AT9.
    base: {
        before: ['test/integration/bridge_rail_doge_guards.test.js'],
        root: 'test/integration/bridge_rail_base.test.js',
        glob: 'test/integration/bridge_rail_base.test/*.test.js',
        legs: {
            full: { grep: null, minPassed: 16 },
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
    list_share: {
        root: 'test/integration/bridge_rail_list_share.test.js',
        glob: 'test/integration/bridge_rail_list_share.test/*.test.js',
        // Split legs run beside `full` on separate runners: each carries the cases its
        // last case depends on (AT2 to AT4 chain on AT1, AT5 reads AT4's union, AT6 needs
        // AT3's seq 2, AT7 needs AT5's seq 3), so a fix is judged without waiting on the whole drive.
        legs: {
            core: { grep: 'list_share T0:|list_share AT1:|list_share AT2:|list_share AT3:|list_share AT4:', minPassed: 10 },
            replay: { grep: 'list_share T0:|list_share AT1:|list_share AT2:|list_share AT3:|list_share AT6:', minPassed: 10 },
            bridged: { grep: 'list_share T0:|list_share AT1:|list_share AT2:|list_share AT3:|list_share AT4:|list_share AT5:|list_share AT7:', minPassed: 16 },
            full: { grep: null, minPassed: 23 },
        },
    },
    anchor_stake: {
        envKeys: ANCHOR_ARM_ENV_KEYS,
        legs: {
            anchor_fold: {
                files: ['test/federation/anchor_fold_acceptance.test.js'],
                minPassed: 3,
            },
            anchor_bundle: {
                files: ['test/federation/flag_days/anchor_bundle_order.test.js'],
                minPassed: 3,
            },
            staking: {
                files: ['test/actions/staking.test.js'],
                minPassed: 7,
            },
            capability_slash: {
                files: ['test/actions/capability_slash.test.js'],
                minPassed: 4,
            },
            vm_contract_slash: {
                files: ['test/actions/vm_contract_slash.test.js'],
                minPassed: 3,
            },
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
