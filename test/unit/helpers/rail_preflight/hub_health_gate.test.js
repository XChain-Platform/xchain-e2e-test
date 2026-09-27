/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const { requireHealthyHub } = require('../../../helpers/rail_preflight/hub_health_gate');

const healthyBody = JSON.stringify({ result: { status: 'healthy' } });

describe('requireHealthyHub', function () {
    it('returns the first healthy detail after one call', async function () {
        let calls = 0;
        const detail = await requireHealthyHub(async () => {
            calls += 1;
            return { statusCode: 200, bodyText: healthyBody };
        }, { waitMs: 0 });

        assert.strictEqual(detail, 'healthy');
        assert.strictEqual(calls, 1);
    });

    it('returns a healthy third reading after two HTTP failures', async function () {
        let calls = 0;
        const detail = await requireHealthyHub(async () => {
            calls += 1;
            if(calls < 3) return { statusCode: 502, bodyText: 'bad gateway' };
            return { statusCode: 200, bodyText: healthyBody };
        }, { waitMs: 0 });

        assert.strictEqual(detail, 'healthy');
        assert.strictEqual(calls, 3);
    });

    it('throws with the last RPC error detail', async function () {
        let calls = 0;
        await assert.rejects(requireHealthyHub(async () => {
            calls += 1;
            return {
                statusCode: 200,
                bodyText: JSON.stringify({ error: { code: -32000 - calls } }),
            };
        }, { waitMs: 0 }), /hub not healthy: rpc error -32003/);
        assert.strictEqual(calls, 3);
    });

    it('reports a rejected ping as unreachable', async function () {
        let calls = 0;
        await assert.rejects(requireHealthyHub(async () => {
            calls += 1;
            throw new Error('connection refused');
        }, { waitMs: 0 }), /hub not healthy: unreachable: connection refused/);
        assert.strictEqual(calls, 3);
    });
});
