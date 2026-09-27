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
const { classifyHubPingResponse } = require('../../../helpers/rail_preflight/hub_ping_response');

describe('classifyHubPingResponse', function () {
    it('reports a non-200 HTTP status before reading the body', function () {
        assert.deepStrictEqual(classifyHubPingResponse(503, 'not json'), {
            ok: false,
            detail: 'HTTP 503'
        });
    });

    it('reports an unparseable response body', function () {
        assert.deepStrictEqual(classifyHubPingResponse(200, 'not json'), {
            ok: false,
            detail: 'bad json'
        });
    });

    it('reports a JSON-RPC error code', function () {
        const body = JSON.stringify({ error: { code: -32601 } });
        assert.deepStrictEqual(classifyHubPingResponse(200, body), {
            ok: false,
            detail: 'rpc error -32601'
        });
    });

    it('reports the hub status from a successful result', function () {
        const body = JSON.stringify({ result: { status: 'healthy' } });
        assert.deepStrictEqual(classifyHubPingResponse(200, body), {
            ok: true,
            detail: 'healthy'
        });
    });

    it('falls back to ok when a successful result has no status', function () {
        const body = JSON.stringify({ result: {} });
        assert.deepStrictEqual(classifyHubPingResponse(200, body), {
            ok: true,
            detail: 'ok'
        });
    });
});
