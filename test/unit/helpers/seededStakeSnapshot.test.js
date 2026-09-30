'use strict';

/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 ********************************************************************/

const assert = require('assert');
const { seedStakeSnapshot } = require('../../helpers/seededStakeSnapshot.js');

describe('seedStakeSnapshot weight snapshots', function () {
    it('installs source-keyed weights on every hub and restores each original method', async function () {
        const originals = [async () => 'first', async () => 'second'];
        const hubs = originals.map((getWeightSnapshot) => ({
            capabilitySnapshot: {
                getActiveValidatorSnapshot: async () => null,
                getSnapshot: async () => null,
                getWeightSnapshot
            },
            resolveBtcLatestBlock: async () => 0
        }));
        const identities = [
            { pubkeyHex: 'validator-a' },
            { pubkeyHex: 'validator-b' },
            { pubkeyHex: 'validator-c' }
        ];
        const expectedValidators = identities.map(({ pubkeyHex }) => ({
            pubkey: pubkeyHex,
            source: pubkeyHex,
            weight: '42.00000000'
        }));

        const seeded = seedStakeSnapshot({ hubs, identities }, {
            amount: '42.00000000',
            blockIndex: 321
        });

        for (let i = 0; i < hubs.length; i++) {
            const installed = hubs[i].capabilitySnapshot.getWeightSnapshot;
            assert.notStrictEqual(installed, originals[i]);

            const snapshot = await installed('cross_chain', 321);
            assert.strictEqual(snapshot.capability, 'cross_chain');
            assert.strictEqual(snapshot.blockIndex, 321);
            assert.strictEqual(snapshot.count, identities.length);
            assert.deepStrictEqual(snapshot.validators, expectedValidators);
        }

        seeded.restore();

        for (let i = 0; i < hubs.length; i++) {
            assert.strictEqual(hubs[i].capabilitySnapshot.getWeightSnapshot, originals[i]);
        }
    });
});
