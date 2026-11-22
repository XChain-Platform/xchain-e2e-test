'use strict'

/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 **********************************************************************/

const fsx = require('fs')
const pathx = require('path')

async function startAttestTestServer (opts) {
    const o = opts || {}
    const body = String(o.body === undefined ? '{}' : o.body)
    const urlPath = String(o.path || '/score')
    const handler = typeof o.handler === 'function' ? o.handler : null
    const https = require('https')
    const os = require('os')
    const { execFileSync } = require('child_process')

    const dir = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'xchain-attest-tls-'))
    const keyPath = pathx.join(dir, 'key.pem')
    const certPath = pathx.join(dir, 'cert.pem')
    try {
        execFileSync('openssl', [
            'req', '-x509', '-newkey', 'rsa:2048',
            '-keyout', keyPath, '-out', certPath,
            '-days', '1', '-nodes', '-subj', '/CN=127.0.0.1',
            '-addext', 'subjectAltName=IP:127.0.0.1',
            '-addext', 'basicConstraints=critical,CA:TRUE',
            '-addext', 'keyUsage=critical,digitalSignature,keyCertSign',
            '-addext', 'extendedKeyUsage=serverAuth',
        ], { stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (e) {
        throw new Error('mirrorDrillFixture: could not mint a throwaway TLS certificate with openssl ' +
            '(' + (e && e.message) + '). The http_get provider refuses non-https payloads, so there ' +
            'is no usable fallback: every round would resolve provider_error and read as a missing ' +
            'mirror row. Install openssl on this box or run the drill where it exists.')
    }

    const server = https.createServer(
        { key: fsx.readFileSync(keyPath), cert: fsx.readFileSync(certPath) },
        handler || ((internalReq, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(body)
        }))
    const port = await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => resolve(server.address().port))
    })

    return {
        url: 'https://127.0.0.1:' + port + urlPath,
        certPath,
        dir,
        hubEnv: {
            NODE_EXTRA_CA_CERTS: certPath,
            ATTESTATION_HTTP_GET_ALLOW_PRIVATE: '1',
        },
        close: async () => {
            await new Promise((resolve) => server.close(() => resolve()))
            try { fsx.rmSync(dir, { recursive: true, force: true }) } catch (internal) { /* tmp */ }
        },
    }
}

module.exports = { startAttestTestServer }
