'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert');
const { parsePromSamples, requireSourceDispatches } = require('../../helpers/rail/prom_samples');

describe('text sample parser', function () {
    it('parses sample values, timestamps, labels, and label escapes', function () {
        const fixture = [
            '',
            '# HELP ignored comments and blank lines are not samples',
            'namespace:plain 42',
            'escaped{quote="say \\"hi\\"", slash="c:\\\\tmp", line="first\\nsecond"} 1.25e+3',
            'negative_exponent -2E-2 1700000000000',
            'not_a_number NaN',
            'positive_infinity +Inf',
            'negative_infinity -Inf',
            ''
        ].join('\n');

        const samples = parsePromSamples(fixture);

        assert.deepStrictEqual(samples, [
            { name: 'namespace:plain', labels: {}, value: 42 },
            {
                name: 'escaped',
                labels: { quote: 'say "hi"', slash: 'c:\\tmp', line: 'first\nsecond' },
                value: 1250
            },
            { name: 'negative_exponent', labels: {}, value: -0.02 },
            { name: 'not_a_number', labels: {}, value: NaN },
            { name: 'positive_infinity', labels: {}, value: Infinity },
            { name: 'negative_infinity', labels: {}, value: -Infinity }
        ]);
    });

    it('names the physical line when a sample cannot be parsed', function () {
        const fixture = '# a comment\nvalid 1\nbroken{label="unterminated} 2';
        assert.throws(() => parsePromSamples(fixture), /sample line 3 is unparseable/);
    });

    it('does not treat a liveness sample as dispatch evidence', function () {
        const fixture = [
            'xchain_oracle_price_source_live{source="coingecko"} 1',
            'xchain_oracle_price_source_live{source="kraken"} 1',
            'xchain_oracle_price_source_live{source="coinbase"} 1',
            'xchain_oracle_price_source_live{source="coinmarketcap"} 1',
            'xchain_oracle_price_source_fetch_attempts_total{source="coingecko"} 2',
            'xchain_oracle_price_source_fetch_attempts_total{source="kraken"} 2',
            'xchain_oracle_price_source_fetch_attempts_total{source="coinbase"} 2'
        ].join('\n');
        const samples = parsePromSamples(fixture);

        assert.throws(() => requireSourceDispatches(
            samples,
            'xchain_oracle_price_source_live',
            'xchain_oracle_price_source_fetch_attempts_total',
            ['coingecko', 'kraken', 'coinbase']
        ), /source=coinmarketcap without dispatch evidence/);
    });
});
