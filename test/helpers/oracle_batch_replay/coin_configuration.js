'use strict'

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const fs = require('fs')
const path = require('path')
const { coinCode } = require('./replay_naming')
const helperDir = path.resolve(__dirname, '..')

const HUB_CONFIG_REDACTION = '[redacted]';

/**
 * The config tree, asked for at the CREDENTIAL TIER.
 *
 * Returns `{configs, secretsRedacted}` or null when no tree could be read at
 * all. `secretsRedacted` is true whenever a value was withheld or would have
 * been, which is the hub's own `secrets_redacted` flag; a hub too old to carry
 * the flag is treated as redacting, since assuming otherwise would hand a
 * sentinel onward as a password.
 *
 * The unredacted ask goes through the connector's JSON-RPC transport directly
 * because `getAllConfig()` sends `params: []` and there is nowhere on an array
 * to put the flag. Falling back to `getAllConfig()` keeps this working against
 * a hub that refuses the credential tier (unauthorized, or older than it).
 */
async function readHubConfigTree(hub) {
    if (hub && typeof hub['_call'] === 'function') {
        let envelope = null;
        try {
            envelope = await hub['_call']({
                jsonrpc: '2.0', method: 'getallconfigs',
                params: { include_secrets: true }, id: 1
            });
        } catch (internal) { envelope = null; }
        // Only the enveloped form can be trusted here: without `secrets_redacted`
        // there is no way to tell a served credential from a withheld one.
        if (envelope && typeof envelope === 'object' && envelope.error === undefined &&
            envelope.configs && typeof envelope.configs === 'object' && 'seq' in envelope) {
            return { configs: envelope.configs, secretsRedacted: envelope.secrets_redacted !== false };
        }
    }
    const plain = await hub.getAllConfig();
    return plain ? { configs: plain, secretsRedacted: true } : null;
}

/**
 * The per-coin config sidecar: the xchain-node config file the containers
 * themselves are built from. Tried relative to this checkout the same way the
 * hub source is resolved, because the harness runs both from the monorepo and
 * from an image where the layout differs.
 *
 * With `needKey`, the first EXISTING candidate that carries that key wins and
 * the first existing one at all is the fallback, so a refusal can still name a
 * file. The regtest stack's `dogecoin-regtest.local` exists and holds only the
 * indexer credential, and stopping at it hid the `dogecoin-regtest` beside it.
 */
function resolveCoinConfigSidecar(coin, network, needKey) {
    const rel = 'xchain-node/config/' + coin + '-' + network + '.local';
    const candidates = [
        process.env.XCHAIN_NODE_CONFIG_DIR && path.join(process.env.XCHAIN_NODE_CONFIG_DIR, coin + '-' + network + '.local'),
        process.env.XCHAIN_NODE_CONFIG_DIR && path.join(process.env.XCHAIN_NODE_CONFIG_DIR, coin + '-' + network),
        path.resolve(helperDir, '../../..', rel),
        path.resolve(helperDir, '../../../..', rel)
    ].filter(Boolean);
    let firstExisting = null;
    for (const p of candidates) {
        if (!fs.existsSync(p)) continue;
        if (!needKey) return p;
        if (firstExisting === null) firstExisting = p;
        try {
            if (require('dotenv').parse(fs.readFileSync(p))[needKey]) return p;
        } catch (internal) { /* unreadable: keep looking */ }
    }
    return firstExisting;
}

/**
 * One service credential, from the first store that actually holds one.
 *
 * @param o.oracle      the service's entry in the config tree (`{user, pass}`)
 * @param o.coin/network which chain's sidecar to read
 * @param o.passKey     env var AND sidecar key holding the password
 * @param o.userKey     env var holding the account name (optional)
 * @param o.allowEnv    false IGNORES the environment for this resolution. The
 *                      harness `.env` describes exactly ONE coin, so a venue for
 *                      another coin that takes them authenticates as that coin's
 *                      account and then fails ER_TABLEACCESS_DENIED on a database
 *                      it holds no grant for. An option rather than a comparison
 *                      of coin names, because a rail switch swaps the coin while
 *                      leaving the credentials alone.
 * @param o.what        human name of the credential, for the refusal message
 *
 * Returns `{user, pass, source}`, or `{problem}` naming what to fix. It never
 * logs a value and never puts one on a command line.
 */
function resolveServiceCredential(o) {
    const allowEnv = o.allowEnv !== false;
    const oracle   = o.oracle || {};
    const what     = o.what || o.passKey;
    const user     = (allowEnv && o.userKey && process.env[o.userKey]) || oracle.user;

    if (allowEnv && process.env[o.passKey]) {
        return { user, pass: process.env[o.passKey], source: o.passKey + ' in the environment' };
    }

    // The oracle's own value, ahead of the sidecar: when the credential tier
    // answered, this is the live authority and the sidecar is the stale copy.
    if (oracle.pass && oracle.pass !== HUB_CONFIG_REDACTION) {
        return { user, pass: oracle.pass, source: "the standing hub's config oracle" };
    }

    const sidecar = resolveCoinConfigSidecar(o.coin, o.network, o.passKey);
    if (sidecar) {
        let parsed = {};
        try { parsed = require('dotenv').parse(fs.readFileSync(sidecar)); }
        catch (internal) { /* an unreadable sidecar is treated as absent */ }
        if (parsed[o.passKey]) {
            const u = (allowEnv && o.userKey && process.env[o.userKey]) ||
                (o.userKey && parsed[o.userKey]) || oracle.user;
            return { user: u, pass: parsed[o.passKey], source: sidecar };
        }
    }

    return {
        problem: 'no usable ' + o.coin + '/' + o.network + ' ' + what + '. The standing ' +
            "hub's config oracle redacts every password it serves unless the call is authorized " +
            'for its credential tier (it returned ' + JSON.stringify(HUB_CONFIG_REDACTION) + '), so ' +
            'it supplied coordinates only' +
            (sidecar
                ? ', and the config sidecar ' + sidecar + ' carries no ' + o.passKey
                : ', and no ' + o.coin + '-' + o.network + '.local config sidecar was found') +
            '. Authorize the credential tier (HUB_CONFIG_SECRETS_API_KEY, or the bulk HUB_API_KEY ' +
            'when that is unset) so `getallconfigs` can serve the live value, or set ' + o.passKey +
            ' in the harness environment, or reconcile the sidecar with the credential the running ' +
            'service actually uses; the sidecar and the container drift apart whenever a container ' +
            'is recreated and nothing propagates the new value back.'
    };
}

/**
 * Does the harness environment describe THIS coin?
 *
 * The `.env` a harness run is given carries exactly one coin's credentials and
 * says which in `COIN`. Taking them for a different coin is not a harmless
 * fallback: the account authenticates and then fails ER_TABLEACCESS_DENIED on a
 * database it holds no grant for, which reads as a broken decoder rather than as
 * the wrong account. An environment that declares no coin is treated as
 * describing none, because guessing is the failure this exists to prevent.
 */
function envDescribesCoin(coin) {
    const declared = String(process.env.COIN || process.env.INDEXER_COIN || '').trim().toUpperCase();
    return declared !== '' && declared === coinCode(coin);
}

module.exports = {
    readHubConfigTree, resolveServiceCredential, resolveCoinConfigSidecar,
    envDescribesCoin, HUB_CONFIG_REDACTION
}
