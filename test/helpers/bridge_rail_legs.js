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
const CONTRACTS_PRICE_ENV_KEYS = [
    'XC_AMOUNTS_PRICE_REGTEST_ACTIVATION',
    'XC_AMOUNTS_PRICE_REGTEST_TIME',
    'XC_CONTRACTS_REGTEST_ACTIVATION',
    'XC_E2E_PRICE_FEE_BATCH_LANDED',
    'XC_VOTE_CALLBACK_BINDING_EXPECT',
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
            full: { grep: null, minPassed: 28 },
        },
    },
    list_share: {
        root: 'test/integration/bridge_rail_list_share.test.js',
        glob: 'test/integration/bridge_rail_list_share.test/*.test.js',
        // Split legs run beside `full` on separate runners: each carries the cases its
        // last case depends on (AT2 to AT4 chain on AT1, AT5 reads AT4's union, AT6 needs
        // AT3's seq 2, AT7 needs AT5's seq 3, meta adds AT8 on AT7), so a fix is judged
        // without waiting on the whole drive.
        legs: {
            core: { grep: 'list_share T0:|list_share AT1:|list_share AT2:|list_share AT3:|list_share AT4:', minPassed: 10 },
            replay: { grep: 'list_share T0:|list_share AT1:|list_share AT2:|list_share AT3:|list_share AT6:', minPassed: 10 },
            bridged: { grep: 'list_share T0:|list_share AT1:|list_share AT2:|list_share AT3:|list_share AT4:|list_share AT5:|list_share AT7:', minPassed: 16 },
            meta: { grep: 'list_share T0:|list_share AT1:|list_share AT2:|list_share AT3:|list_share AT4:|list_share AT5:|list_share AT7:|list_share AT8:', minPassed: 21 },
            full: { grep: null, minPassed: 23 },
        },
    },
    anchor_stake: {
        envKeys: ANCHOR_ARM_ENV_KEYS,
        legs: {
            // The fold and bundle suites anchor on DOGE. The workflow writes a dogecoin
            // drive .env for these legs (test/helpers/rail_leg_coins.js), and COIN here
            // replaces the bitcoin COIN that scripts/rail_leg_drive.js gives every child,
            // which dotenv would not override (R-3 attempt 4 gaps A and C). Their suites pay only
            // native DOGE, so they skip the off-BTC gas bootstrap, which needs a bridge relay
            // the GitHub rail does not run (R-3 attempt 5).
            anchor_fold: {
                files: ['test/federation/anchor_fold_acceptance.test.js'],
                env: { E2E_REQUIRE_FEDERATION: '1', COIN: 'dogecoin', E2E_GAS_BOOTSTRAP: 'off' },
                minPassed: 5,
            },
            anchor_bundle: {
                files: ['test/federation/flag_days/anchor_bundle_order.test.js'],
                env: { COIN: 'dogecoin', E2E_GAS_BOOTSTRAP: 'off' },
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
            archive_count: {
                files: ['test/federation/flag_days/archive_match_count.test.js'],
                env: { COIN: 'dogecoin', E2E_GAS_BOOTSTRAP: 'off' },
                minPassed: 3,
            },
        },
    },
    contracts_price: {
        envKeys: CONTRACTS_PRICE_ENV_KEYS,
        legs: {
            dispenser: {
                files: [
                    'test/actions/dispenser.test.js',
                    'test/actions/dispenser.test/01_v0_fiat_mode_1_validator_price_oracle.test.js',
                    'test/actions/dispenser.test/02_v0_fiat_mode_2_user_oracle_price_v1_cross_conversion.test.js',
                    'test/actions/dispenser.test/03_v0_fiat_mode_2_user_oracle_price_v1_per_token.test.js',
                    'test/actions/dispenser.test/04_v0_fiat_mode_2_user_oracle_price_v1_oracle_fee.test.js',
                    'test/actions/dispenser.test/05_v0_fiat_mode_2_user_oracle_price_v1_price_window.test.js',
                    'test/actions/dispenser.test/06_v0_fiat_mode_2_user_oracle_price_v1_activation_delay.test.js',
                    'test/actions/dispenser.test/07_v0_fiat_mode_2_user_oracle_price_v1_no_quote.test.js',
                    'test/actions/dispenser.test/08_v1_cancel.test.js',
                    'test/actions/dispenser.test/09_v2_edit.test.js',
                ],
                minPassed: 13,
            },
            order: {
                files: [
                    'test/actions/order.test.js',
                    'test/actions/order.test/02_v1_cancel.test.js',
                    'test/actions/order.test/03_match_full_exchange.test.js',
                    'test/actions/order.test/04_match_repeating_decimal_price.test.js',
                    'test/actions/order.test/05_match_partial_fill.test.js',
                    'test/actions/order.test/06_match_high_precision_decimals.test.js',
                    'test/actions/order.test/07_v2_edit.test.js',
                ],
                minPassed: 7,
            },
            price: {
                files: [
                    'test/actions/price.test.js',
                    'test/actions/price.test/02_invalid_quotes.test.js',
                ],
                minPassed: 7,
            },
            vote_binding: {
                files: ['test/rail/vote_binding/usable_method.test.js'],
                grep: '(?:available|unavailable) callback method',
                env: { COIN: 'bitcoin' },
                minPassed: 2,
            },
        },
    },
    lists_market: {
        envKeys: [
            'XC_LISTS_MARKET_REGTEST_ACTIVATION',
            'XC_LISTS_MARKET_REGTEST_TIME',
        ],
        legs: {
            list: {
                files: ['test/actions/list.test.js'],
                minPassed: 3,
            },
            order: {
                files: [
                    'test/actions/order.test.js',
                    'test/actions/order.test/02_v1_cancel.test.js',
                    'test/actions/order.test/03_match_full_exchange.test.js',
                    'test/actions/order.test/04_match_repeating_decimal_price.test.js',
                    'test/actions/order.test/05_match_partial_fill.test.js',
                    'test/actions/order.test/06_match_high_precision_decimals.test.js',
                    'test/actions/order.test/07_v2_edit.test.js',
                ],
                minPassed: 7,
            },
            swap: {
                files: [
                    'test/actions/swap.test.js',
                    'test/actions/swap.test/02_v1_cancel.test.js',
                    'test/actions/swap.test/03_match_full_exchange.test.js',
                    'test/actions/swap.test/04_v2_edit.test.js',
                ],
                minPassed: 4,
            },
            dispenser: {
                files: [
                    'test/actions/dispenser.test.js',
                    'test/actions/dispenser.test/01_v0_fiat_mode_1_validator_price_oracle.test.js',
                    'test/actions/dispenser.test/02_v0_fiat_mode_2_user_oracle_price_v1_cross_conversion.test.js',
                    'test/actions/dispenser.test/03_v0_fiat_mode_2_user_oracle_price_v1_per_token.test.js',
                    'test/actions/dispenser.test/04_v0_fiat_mode_2_user_oracle_price_v1_oracle_fee.test.js',
                    'test/actions/dispenser.test/05_v0_fiat_mode_2_user_oracle_price_v1_price_window.test.js',
                    'test/actions/dispenser.test/06_v0_fiat_mode_2_user_oracle_price_v1_activation_delay.test.js',
                    'test/actions/dispenser.test/07_v0_fiat_mode_2_user_oracle_price_v1_no_quote.test.js',
                    'test/actions/dispenser.test/08_v1_cancel.test.js',
                    'test/actions/dispenser.test/09_v2_edit.test.js',
                ],
                minPassed: 13,
            },
            callback: {
                files: ['test/actions/callback.test.js'],
                minPassed: 1,
            },
        },
    },
    contracts_vm: {
        envKeys: ['XC_JSON_STRINGIFY_HOOK_EXPECT'],
        legs: {
            json_stringify_hook: {
                files: ['test/contracts/json_stringify_hook.test.js'],
                minPassed: 4,
            },
            custody_guard: {
                files: [
                    'test/rail/custody_guard/deposit.test.js',
                    'test/rail/custody_guard/withdraw.test.js',
                ],
                minPassed: 5,
            },
            broadcast_fee: {
                files: ['test/rail/flag_days/broadcast_fee_length.test.js'],
                minPassed: 3,
            },
            vm_lint: {
                files: ['test/rail/vm_lint/optional_chain_deploy.test.js'],
                minPassed: 2,
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
