'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// src/config is the one place src/ reads the environment. These pin every
// value it resolves under a fixed env set, unset and malformed spellings
// included, to the literal values the old inline read sites produced, so the
// move into one home cannot quietly change a default, a coercion or which
// empty string counts as unset.

const assert = require('assert');

const config = require('../../../src/config');
const Database = require('../../../src/db.js');

const VARS = [
    'NETWORK', 'HUB_API_KEY', 'HUB_CONFIG_SECRETS_API_KEY', 'HUB_VALIDATORS',
    'HUB_URL', 'HUB_API_HOST', 'HUB_PORT',
    'E2E_WAIT_MAX_EXTENSIONS', 'E2E_WAIT_LAG_BLOCKS', 'E2E_WAIT_LAG_PROBE_MS',
    'E2E_WAIT_MIN_FOR_EXTENSION', 'E2E_WAIT_PROBE_INTERVAL_MS', 'E2E_WAIT_PROBE_MIN_MS',
    'E2E_WAIT_WRITE_IDLE_MS', 'E2E_DB_CONNECT_ATTEMPTS', 'E2E_DB_CONNECT_BUDGET_MS',
    'E2E_DB_CONNECT_RETRY_MS',
];

// Which config key each wait and connect variable feeds, with its default.
const WAIT = {
    E2E_WAIT_MAX_EXTENSIONS:    ['WAIT_MAX_EXTENSIONS', 3],
    E2E_WAIT_LAG_BLOCKS:        ['WAIT_LAG_BLOCKS', 0],
    E2E_WAIT_LAG_PROBE_MS:      ['WAIT_LAG_PROBE_MS', 2000],
    E2E_WAIT_MIN_FOR_EXTENSION: ['WAIT_MIN_FOR_EXTENSION', 5000],
    E2E_WAIT_PROBE_INTERVAL_MS: ['WAIT_PROBE_INTERVAL_MS', 10000],
    E2E_WAIT_PROBE_MIN_MS:      ['WAIT_PROBE_MIN_MS', 1000],
    E2E_WAIT_WRITE_IDLE_MS:     ['WAIT_WRITE_IDLE_MS', 20000],
};
const CONNECT = {
    E2E_DB_CONNECT_ATTEMPTS:  ['CONNECT_MAX_ATTEMPTS', 10],
    E2E_DB_CONNECT_BUDGET_MS: ['CONNECT_BUDGET_MS', 30000],
    E2E_DB_CONNECT_RETRY_MS:  ['CONNECT_RETRY_MS', 1000],
};

// Raw value to resolved value. A wait tunable takes only a non-negative
// integer (0 included) and falls back otherwise; a connect budget takes
// parseInt's leading integer (radix-less, so a 0x prefix reads as hex) and
// falls back on anything falsy, 0 included. null in the table means "the
// variable's default".
const NUMERIC_CASES = [
    // raw            wait    connect
    [undefined,       null,   null],
    ['',              null,   null],
    ['0',             0,      null],
    ['5',             5,      5],
    [' 7 ',           7,      7],
    ['12abc',         null,   12],
    ['-5',            null,   -5],
    ['3.5',           null,   3],
    ['1e3',           1000,   1],
    ['0x10',          16,     16],
    ['abc',           null,   null],
    ['true',          null,   null],
];

let saved;
function setEnv(vars) {
    for (const k of VARS) delete process.env[k];
    for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
}

// Each suite body below is a named function so no one callback carries the
// whole file; src/config wires them under one describe with a shared env reset.
function waitTunableCases() {
    for (const [envName, [key, def]] of Object.entries(WAIT)) {
        for (const [raw, wait] of NUMERIC_CASES) {
            it(`${key} for ${envName}=${JSON.stringify(raw)}`, function () {
                setEnv({ [envName]: raw });
                assert.strictEqual(config[key], wait === null ? def : wait);
            });
        }
    }
}

function connectBudgetCases() {
    for (const [envName, [key, def]] of Object.entries(CONNECT)) {
        for (const [raw, , connect] of NUMERIC_CASES) {
            it(`${key} for ${envName}=${JSON.stringify(raw)}`, function () {
                setEnv({ [envName]: raw });
                assert.strictEqual(config[key], connect === null ? def : connect);
            });
        }
    }
}

function hubValueCases() {
    const HOST_CASES = [
        // HUB_URL,  HUB_API_HOST, HUB_PORT,  host,        port
        [undefined,  undefined,    undefined, 'localhost', '10000'],
        ['',         '',           '',        'localhost', '10000'],
        ['h1',       'h2',         '0',       'h1',        '0'],
        ['',         'h2',         '20000',   'h2',        '20000'],
        [undefined,  '0',          undefined, '0',         '10000'],
    ];
    for (const [url, apiHost, port, host, wantPort] of HOST_CASES) {
        it(`HUB_HOST/HUB_PORT for ${JSON.stringify([url, apiHost, port])}`, function () {
            setEnv({ HUB_URL: url, HUB_API_HOST: apiHost, HUB_PORT: port });
            assert.strictEqual(config.HUB_HOST, host);
            assert.strictEqual(config.HUB_PORT, wantPort);
        });
    }

    const KEY_CASES = [
        // HUB_API_KEY, HUB_CONFIG_SECRETS_API_KEY, bulk,      secrets
        [undefined,     undefined,                  undefined, undefined],
        ['',            undefined,                  '',        ''],
        [undefined,     '',                         undefined, undefined],
        ['bulk',        undefined,                  'bulk',    'bulk'],
        ['bulk',        '',                         'bulk',    'bulk'],
        ['bulk',        'sec',                      'bulk',    'sec'],
        [undefined,     'sec',                      undefined, 'sec'],
    ];
    for (const [bulk, sec, wantBulk, wantSec] of KEY_CASES) {
        it(`HUB_API_KEY/HUB_SECRETS_API_KEY for ${JSON.stringify([bulk, sec])}`, function () {
            setEnv({ HUB_API_KEY: bulk, HUB_CONFIG_SECRETS_API_KEY: sec });
            assert.strictEqual(config.HUB_API_KEY, wantBulk);
            assert.strictEqual(config.HUB_SECRETS_API_KEY, wantSec);
        });
    }

    it('hands HUB_VALIDATORS and NETWORK on raw, empty string included', function () {
        setEnv({ HUB_VALIDATORS: '', NETWORK: '' });
        assert.strictEqual(config.HUB_VALIDATORS, '');
        assert.strictEqual(config.NETWORK, '');
        setEnv({ HUB_VALIDATORS: ' a:1,,b:2 ', NETWORK: 'regtest' });
        assert.strictEqual(config.HUB_VALIDATORS, ' a:1,,b:2 ');
        assert.strictEqual(config.NETWORK, 'regtest');
        setEnv({});
        assert.strictEqual(config.HUB_VALIDATORS, undefined);
        assert.strictEqual(config.NETWORK, undefined);
    });

    it('reads the environment when asked, not when first required', function () {
        setEnv({ HUB_PORT: '1' });
        assert.strictEqual(config.HUB_PORT, '1');
        setEnv({ HUB_PORT: '2' });
        assert.strictEqual(config.HUB_PORT, '2');
    });
}

// Database still resolves its own tunables; these must agree with the home
// so its constructor can read them from config without a behaviour change.
function databaseAgreementCases() {
    const all = Object.assign({}, WAIT, CONNECT);
    for (const [envName, [key]] of Object.entries(all)) {
        it(`${key} matches for every numeric case of ${envName}`, function () {
            for (const [raw] of NUMERIC_CASES) {
                setEnv({ [envName]: raw });
                const db = new Database('h', 1, 'd', 'u', 'p');
                assert.strictEqual(config[key], db[key], `${envName}=${JSON.stringify(raw)}`);
            }
        });
    }
}

describe('src/config', function () {
    before(function () {
        saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
    });
    afterEach(function () {
        setEnv(saved);
    });

    describe('wait tunables honour an explicit 0 and reject non-integers', waitTunableCases);
    describe('connect budgets take parseInt and treat 0 as unset', connectBudgetCases);
    describe('hub endpoint and key values', hubValueCases);
    describe('agrees with the Database constructor', databaseAgreementCases);
});
