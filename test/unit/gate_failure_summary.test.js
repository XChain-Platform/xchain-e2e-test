'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert');
const { gateFailureSummary } = require('../integration/lib/gate_failure_summary');

describe('gateFailureSummary', function () {
    it('summarizes failed tiers, the red verdict, and multiline mocha titles', function () {
        const output = [
            'ci:full ----- unit FAIL (3s)',
            'ci:full ----- integration FAIL (12s)',
            '  2 failing',
            '',
            '  1) Suite A',
            '       does b:',
            '     AssertionError: x',
            '',
            '  2) Suite C',
            '       nested context',
            '         does d:',
            '     Error: y',
            'ci:full: RED tiers: [unit integration]',
        ].join('\n');

        assert.deepStrictEqual(gateFailureSummary(output), {
            failTiers: ['unit', 'integration'],
            redTiersLine: 'ci:full: RED tiers: [unit integration]',
            failingTitles: ['Suite A does b:', 'Suite C nested context does d:'],
        });
    });

    it('returns an empty summary for a green run', function () {
        assert.deepStrictEqual(gateFailureSummary('ci:full: all tiers green\n'), {
            failTiers: [],
            redTiersLine: null,
            failingTitles: [],
        });
    });

    it('strips ANSI colour codes before summarizing', function () {
        const output = [
            '\u001b[31mci:full ----- unit FAIL (3s)\u001b[0m',
            '\u001b[31m  1 failing\u001b[0m',
            '',
            '\u001b[31m  1) Coloured Suite\u001b[0m',
            '\u001b[31m       reports failure:\u001b[0m',
            '\u001b[31mci:full: RED tiers: [unit]\u001b[0m',
        ].join('\n');

        assert.deepStrictEqual(gateFailureSummary(output), {
            failTiers: ['unit'],
            redTiersLine: 'ci:full: RED tiers: [unit]',
            failingTitles: ['Coloured Suite reports failure:'],
        });
    });
});
