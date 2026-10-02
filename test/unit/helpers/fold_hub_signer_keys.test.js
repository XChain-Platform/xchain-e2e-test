/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

// The anchor fold suites' in-process hubs must sign with the keys the rail's seed
// tool stakes. The expected keys come from rollcallHelper's roster (the seed
// tool's own source) and its pubkeys from rollcallHelper's own derivation, never
// from constants repeated here, so the test fails if the hubs and the staked set
// part ways.

const assert = require('assert');
const {
    MultiValidatorHub,
    resolvePresetIdentities,
} = require('../../helpers/multiValidatorHubHelper.js');
const rollcall = require('../../helpers/rollcallHelper.js');

const SEEDED_ENV = { E2E_REQUIRE_FEDERATION: '1', XC_ROLLCALL_FEDERATION_MNEMONIC: 'unit test mnemonic' };

function signingRoster() {
    return rollcall.federationRoster().filter((member) => member.index !== rollcall.IDLE_SEED_INDEX);
}

function withEnv(values, run) {
    const saved = {};
    for (const name of Object.keys(values)) { saved[name] = process.env[name]; process.env[name] = values[name]; }
    try { return run(); } finally {
        for (const name of Object.keys(values)) {
            if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
        }
    }
}

describe('anchor fold hub signer keys follow the seeded federation', function () {
    it('signs a seeded federation mesh with the staked signing roster', function () {
        const roster = signingRoster();
        const identities = withEnv(SEEDED_ENV, () => new MultiValidatorHub({ count: 2 }).presetIdentities);

        assert.deepStrictEqual(identities.map((item) => item.pubkeyHex), roster.slice(0, 2).map((m) => m.pubkey));
        assert.deepStrictEqual(identities.map((item) => item.privkeyHex), roster.slice(0, 2).map((m) => m.seed));
    });

    it('takes whatever keys the roster names rather than a fixed list', function () {
        const real = signingRoster();
        const rotated = [real[2], real[0], real[1]];
        const identities = resolvePresetIdentities({ count: 3 }, SEEDED_ENV, () => rotated);

        assert.deepStrictEqual(identities.map((item) => item.pubkeyHex), rotated.map((m) => m.pubkey));
    });

    it('refuses a roster whose staked pubkey the hub identity does not derive', function () {
        const real = signingRoster();
        const forged = [Object.assign({}, real[0], { pubkey: real[1].pubkey })];

        assert.throws(() => resolvePresetIdentities({ count: 1 }, SEEDED_ENV, () => forged),
            /derives .* but the seeded federation staked/);
    });
});

describe('anchor fold hub signer keys outside a seeded run', function () {
    it('keeps generated identities when the run is not a seeded federation run', function () {
        assert.strictEqual(resolvePresetIdentities({ count: 2 }, { XC_ROLLCALL_FEDERATION_MNEMONIC: 'm' }), null);
        assert.strictEqual(resolvePresetIdentities({ count: 2 }, { E2E_REQUIRE_FEDERATION: '1' }), null);
    });

    it('keeps explicit identities ahead of the seeded roster', function () {
        const explicit = [{ pubkeyHex: 'aa', privkeyHex: 'bb' }];
        assert.strictEqual(resolvePresetIdentities({ count: 1, identities: explicit }, SEEDED_ENV), explicit);
    });

    it('does not force the signing roster onto a larger mesh', function () {
        const count = signingRoster().length + 1;
        assert.strictEqual(resolvePresetIdentities({ count }, SEEDED_ENV), null);
    });
});
