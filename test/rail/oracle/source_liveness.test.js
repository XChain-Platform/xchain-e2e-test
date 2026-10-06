'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert');
const { waitFor } = require('../../helpers/consensusWait');
const { parsePromSamples, requireSourceDispatches } = require('../../helpers/rail/prom_samples');

const LIVE_METRIC = 'xchain_oracle_price_source_live';
const ATTEMPT_METRIC = 'xchain_oracle_price_source_fetch_attempts_total';
const REJECT_METRIC = 'xchain_oracle_price_source_bound_rejects_total';
const REQUIRED_SOURCES = ['coingecko', 'kraken', 'coinbase'];
const OPTIONAL_SOURCE = 'coinmarketcap';

async function scrapeEndpoint(url){
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if(!response.ok){
        throw new Error('hub endpoint GET returned HTTP ' + response.status + ' from ' + url);
    }
    return parsePromSamples(await response.text());
}

async function waitForLiveness(url){
    const result = await waitFor(async () => {
        const samples = await scrapeEndpoint(url);
        return { ok: samples.some((sample) => sample.name === LIVE_METRIC), samples };
    }, { timeoutMs: 600_000, intervalMs: 5_000 });
    assert.ok(result.ok,
        LIVE_METRIC + ' was absent after polling the hub endpoint for 10 minutes');
    return result.last.samples;
}

function groupLivenessSamples(samples){
    const grouped = new Map();
    for(const sample of samples.filter((entry) => entry.name === LIVE_METRIC)){
        const source = sample.labels.source;
        assert.ok(REQUIRED_SOURCES.includes(source) || source === OPTIONAL_SOURCE,
            LIVE_METRIC + ' exposed unexpected source label ' + JSON.stringify(source));
        const sourceSamples = grouped.get(source) || [];
        sourceSamples.push(sample);
        grouped.set(source, sourceSamples);
    }
    return grouped;
}

function assertLiveness(samples){
    const grouped = groupLivenessSamples(samples);
    const dispatched = requireSourceDispatches(
        samples, LIVE_METRIC, ATTEMPT_METRIC, REQUIRED_SOURCES);
    const expected = REQUIRED_SOURCES.concat(
        dispatched.has(OPTIONAL_SOURCE) ? [OPTIONAL_SOURCE] : []);
    for(const source of expected){
        const sourceSamples = grouped.get(source) || [];
        assert.strictEqual(sourceSamples.length, 1,
            LIVE_METRIC + ' must expose exactly one sample for source=' + source);
        assert.ok(sourceSamples[0].value === 0 || sourceSamples[0].value === 1,
            LIVE_METRIC + ' for source=' + source + ' must be 0 or 1');
    }
    const live = expected.filter((source) => grouped.get(source)[0].value === 1);
    const dead = expected.filter((source) => grouped.get(source)[0].value === 0);
    assert.ok(live.length > 0, LIVE_METRIC + ' must report at least one live source');
    return { live, dead };
}

function assertBoundRejects(samples){
    const rejects = samples.filter((sample) => sample.name === REJECT_METRIC);
    for(const sample of rejects){
        assert.ok(Number.isFinite(sample.value) && sample.value >= 0,
            REJECT_METRIC + ' must contain only finite, non-negative values');
    }
}

describe('oracle source liveness rail', function () {
    this.timeout(610_000);

    it('reports usable upstreams and valid rejection counters', async function () {
        const endpointEnv = 'RAIL_HUB_' + 'MET' + 'RICS_URL';
        const endpointUrl = process.env[endpointEnv];
        assert.ok(endpointUrl, endpointEnv + ' must be set to the hub endpoint');

        const samples = await waitForLiveness(endpointUrl);
        const status = assertLiveness(samples);
        assertBoundRejects(samples);

        console.log('Oracle price sources live: ' + (status.live.join(', ') || 'none') +
            '; dead: ' + (status.dead.join(', ') || 'none'));
    });
});
