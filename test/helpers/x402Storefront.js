/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * Reference x402 storefront for e2e tests — the seller side of the
 * agent-payment flow. Wraps the SDK's X402Gateway in a raw in-process
 * HTTP server (ephemeral port; same pattern as mockCrossChainOfferBook):
 *
 *   GET /data       paid JSON resource (per-call / deposit / dispenser,
 *                   per the gateway's configured schemes)
 *   GET /gated-key  after payment, returns the gated-FILE symmetric key
 *                   as a serializeKeyPayload hex blob — the buyer then
 *                   fetches the ciphertext from the explorer and
 *                   decrypts client-side
 *
 * This is also the canonical example of running a storefront: real
 * deployments swap the in-process server for their own app and keep
 * the gateway + guard() calls identical.
 *
 ********************************************************************/

'use strict';

const http = require('http');

class X402Storefront {

    // options: { gateway: X402Gateway, resource?: object, keyPayloadHex?: string }
    constructor(options) {
        this.gateway       = options.gateway;
        this.resource      = options.resource || { ok: true, secret: 'paid-content' };
        this.keyPayloadHex = options.keyPayloadHex || null;
        this.server        = null;
        this.port          = null;
        this.hits          = [];   // [{ url, paid, status }] for test assertions
    }

    start() {
        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => {
                this._handle(req, res).catch((e) => {
                    res.statusCode = 500;
                    res.end(JSON.stringify({ error: e.message }));
                });
            });
            this.server.on('error', reject);
            this.server.listen(0, '127.0.0.1', () => {
                this.port = this.server.address().port;
                resolve({ url: 'http://127.0.0.1:' + this.port, port: this.port });
            });
        });
    }

    async _handle(req, res) {
        const paid = await this.gateway.guard(req, res);
        this.hits.push({ url: req.url, paid, status: res.statusCode });
        if (!paid) return;                      // guard already sent the 402 challenge

        res.setHeader('Content-Type', 'application/json');
        if (req.url.startsWith('/gated-key')) {
            if (!this.keyPayloadHex) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'no key configured' })); }
            return res.end(JSON.stringify({ key_payload: this.keyPayloadHex, payment: req.x402 }));
        }
        return res.end(JSON.stringify(Object.assign({}, this.resource, { payment: req.x402 })));
    }

    stop() {
        this.gateway.stopSweeper();
        return new Promise((resolve) => {
            if (!this.server) return resolve();
            if (this.server.closeAllConnections) this.server.closeAllConnections();
            this.server.close(() => resolve());
        });
    }
}

module.exports = X402Storefront;
