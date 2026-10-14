'use strict';

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
 **********************************************************************
 * The AT2 rig's credential path: tiers, sentinel, store order, hub config tree.
 ********************************************************************/

const assert     = require('assert');
const proxyquire = require('proxyquire');

/*
 * The credential path.
 *
 * WHAT THESE PIN. The rig discovers every coordinate from the standing stack's
 * config oracle and must not read `pass` off the same tree. That value is the
 * redaction sentinel unless the call asked for, and was authorized for, the
 * oracle's credential tier, so the rig could never have authenticated a spawned
 * indexer against the live decoder: it handed a child the literal string
 * '[redacted]' and the child died on ER_ACCESS_DENIED minutes later, which reads
 * as a rotated password rather than as a redacted read.
 *
 * So the assertions below are about VALUES CROSSING THE BOUNDARY, not about
 * labels: what does the rig hand a child when the oracle serves the credential
 * tier, and what does it do instead when the tier is redacted and no other store
 * holds the credential. A test that only checked "include_secrets was sent"
 * would pass against a rig that then ignored the answer.
 *
 * Nothing here opens a socket, reads a real config sidecar or touches a database:
 * every value is a fabricated fake, and the one sidecar read goes to a temp file
 * this test wrote.
 */
const fs2 = require('fs');
const os2 = require('os');
const path2 = require('path');

// Fabricated, obviously-fake values. The oracle's redacted tier substitutes
// SENTINEL for each of them, which is what the rig has to refuse.
const SENTINEL = '[redacted]';
const LIVE_DECODER_PASS = 'live-decoder-pass-from-the-oracle';
const LIVE_NODE_PASS    = 'live-node-rpc-pass-from-the-oracle';
const LIVE_INDEXER_PASS = 'live-indexer-pass-from-the-oracle';

const COIN = 'dogecoin';
// A network with no config sidecar anywhere in the checkout, so a resolution
// that reaches the sidecar step finds nothing rather than reading a real
// credential off disk into a test.
const NET = 'unitnet';

// The tree `getallconfigs` returns, at whichever tier the caller asked for.
function configTree(redacted) {
    const p = (real) => (redacted ? SENTINEL : real);
    return {
        [COIN]: {
            [NET]: {
                'xchain-decoder': { name: 'XChain_TDOGE_Decoder', user: 'decoder_reader', pass: p(LIVE_DECODER_PASS) },
                'xchain-indexer': { name: 'XChain_TDOGE_Indexer', user: 'indexer_reader', pass: p(LIVE_INDEXER_PASS), port: 3024 },
                'node': { host: 'node.internal', port: 44555, user: 'rpcuser', pass: p(LIVE_NODE_PASS) },
                'xchain-utxo-tracker': { host: 'tracker.internal', port: 3033 }
            }
        },
        bitcoin: {
            [NET]: { 'xchain-indexer': { name: 'XChain_BTC_Indexer', user: 'btc', pass: p('btc'), port: 3014 } }
        }
    };
}

// A hub connector that serves the credential tier only when the call asked
// for it, exactly as xchain-hub/src/api.js gates `include_secrets`.
//
// `authorized` false models the other half of that gate: a hub whose
// HUB_CONFIG_SECRETS_API_KEY the caller does not hold answers nothing to the
// flagged call, and the caller falls back to the ordinary redacted read.
function hubServing(opts) {
    const seen = { calls: [], plainReads: 0 };
    class StubHubConnector {
        constructor() {}
        static parseEndpoints() { return ['http://127.0.0.1:1']; }
        async ping() { return true; }
        async ['_call'](body) {
            seen.calls.push(body);
            const wants = !!(body && body.params && body.params.include_secrets);
            if (wants && !opts.authorized) return null;
            if (!wants) return { configs: configTree(true), seq: 1, secrets_redacted: true };
            return { configs: configTree(false), seq: 1, secrets_redacted: false };
        }
        async getAllConfig() { seen.plainReads++; return configTree(true); }
    }
    return { StubHubConnector, seen };
}

// The rig, with its hub connector replaced and its indexer connector stubbed
// so `_resolveFeeDestination` cannot dial anything.
function rigModule(StubHubConnector) {
    class StubIndexerConnector {
        constructor() {}
        async call() { return { error: 'no indexer in a unit test' }; }
    }
    return proxyquire('../../helpers/oracleBatchReplay.js', {
        '../../src/XChainHubConnector.js': StubHubConnector,
        '../../src/XChainIndexerConnector.js': StubIndexerConnector
    });
}

const CRED_ENV = ['DECODER_DB_PASS', 'DECODER_DB_USER', 'INDEXER_DB_PASS', 'INDEXER_DB_USER',
    'NODE_PASSWORD', 'NODE_USER', 'COIN', 'INDEXER_COIN', 'XCHAIN_NODE_CONFIG_DIR'];

// Every credential variable is cleared before each test and restored after it.
function registerCredentialEnvIsolation() {
    let savedEnv = null;
    beforeEach(function () {
        savedEnv = {};
        for (const k of CRED_ENV) { savedEnv[k] = process.env[k]; delete process.env[k]; }
    });
    afterEach(function () {
        for (const k of CRED_ENV) {
            if (savedEnv[k] === undefined) delete process.env[k];
            else process.env[k] = savedEnv[k];
        }
    });
}

// What the rig hands a child when the oracle serves, or refuses, the credential tier.
function registerCredentialTierTests() {
    it('hands a child the LIVE credential the oracle serves, never the sentinel', async function () {
        const { StubHubConnector, seen } = hubServing({ authorized: true });
        const node = new (rigModule(StubHubConnector).OracleBatchReplayNode)(
            { label: 'cred', coin: COIN, network: NET });

        const live = await node['_resolveLiveChain']();

        assert.strictEqual(node.unavailable, null, 'the rig went unavailable: ' + node.unavailable);
        assert.strictEqual(live.decoder.pass, LIVE_DECODER_PASS,
            'the decoder password handed to a child is not the value the oracle served');
        assert.strictEqual(live.node.pass, LIVE_NODE_PASS,
            'the node RPC password handed to a child is not the value the oracle served');
        assert.strictEqual(live.liveIndexer.pass, LIVE_INDEXER_PASS,
            'the live indexer password is not the value the oracle served');
        for (const [what, value] of [['decoder', live.decoder.pass], ['node', live.node.pass],
            ['liveIndexer', live.liveIndexer.pass]]) {
            assert.notStrictEqual(value, SENTINEL, 'the ' + what + ' password is the redaction sentinel');
        }
        assert.strictEqual(node.configSecretsRedacted, false,
            'the rig recorded the tree as redacted although the oracle served the credential tier');
        // The ask itself: a rig that got the values some other way would still be
        // reading a redacted tree on the next host.
        const asked = seen.calls.filter((c) => c.method === 'getallconfigs' &&
            c.params && c.params.include_secrets === true);
        assert.strictEqual(asked.length, 1,
            'the rig did not ask getallconfigs for the credential tier exactly once; it sent ' +
            JSON.stringify(seen.calls));
    });

    it('refuses, naming the tier and the store, when the oracle answers redacted and no store holds the credential',
        async function () {
            const { StubHubConnector, seen } = hubServing({ authorized: false });
            const node = new (rigModule(StubHubConnector).OracleBatchReplayNode)(
                { label: 'cred', coin: COIN, network: NET });

            const live = await node['_resolveLiveChain']();

            assert.strictEqual(live, null, 'the rig built a live chain out of a redacted tree');
            assert.ok(node.unavailable, 'the rig neither built a chain nor said why');
            assert.match(node.unavailable, /DECODER_DB_PASS/,
                'the refusal must name the credential it could not resolve: ' + node.unavailable);
            assert.match(node.unavailable, /HUB_CONFIG_SECRETS_API_KEY/,
                'the refusal must name the credential tier to authorize: ' + node.unavailable);
            assert.strictEqual(node.configSecretsRedacted, true,
                'the rig did not record that the tree came back redacted');
            assert.ok(seen.plainReads > 0,
                'an unauthorized credential-tier ask must fall back to the ordinary read, not give up');
        });
}

// The sentinel never reaches a child, and only the optional live indexer is dropped.
function registerSentinelAndOptionalIndexerTests() {
    it('never lets the sentinel reach a child, whatever else it does', async function () {
        // The single property the whole item is about, asserted over every
        // credential the rig passes on rather than over one of them.
        const { StubHubConnector } = hubServing({ authorized: false });
        const node = new (rigModule(StubHubConnector).OracleBatchReplayNode)(
            { label: 'cred', coin: COIN, network: NET });
        const live = await node['_resolveLiveChain']();
        const carried = live ? [live.decoder.pass, live.node.pass, live.liveIndexer && live.liveIndexer.pass] : [];
        for (const v of carried) assert.notStrictEqual(v, SENTINEL, 'the redaction sentinel was passed on as a password');
    });

    it('drops the optional live indexer rather than failing the node when only its credential is missing',
        async function () {
            // `liveIndexer` is read by a cross-node comparison alone. A drill that
            // never opens it must not be blocked by a store it does not need, and a
            // drill that does open it must be told which store to fix.
            const { StubHubConnector } = hubServing({ authorized: true });
            class PartialHub extends StubHubConnector {
                async ['_call'](body) {
                    const out = await StubHubConnector.prototype['_call'].call(this, body);
                    if (out && out.configs) out.configs[COIN][NET]['xchain-indexer'].pass = SENTINEL;
                    return out;
                }
            }
            const node = new (rigModule(PartialHub).OracleBatchReplayNode)(
                { label: 'cred', coin: COIN, network: NET });

            const live = await node['_resolveLiveChain']();

            assert.ok(live, 'the node failed over an optional credential: ' + node.unavailable);
            assert.strictEqual(live.liveIndexer, null, 'an unresolvable live indexer must normalize to null');
            assert.match(String(node.liveIndexerUnavailable), /INDEXER_DB_PASS/,
                'the reason must name the credential that could not be resolved');
        });
}

function sidecarDir(contents) {
    const dir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'xc2114-'));
    fs2.writeFileSync(path2.join(dir, COIN + '-' + NET + '.local'), contents);
    return dir;
}

// Environment ahead of the oracle, the oracle ahead of the sidecar.
function registerStorePrecedenceTests(resolveServiceCredential) {
    it('takes an explicit environment credential ahead of everything else', function () {
        process.env.COIN = 'DOGE';
        process.env.DECODER_DB_PASS = 'from-the-environment';
        const out = resolveServiceCredential({
            oracle: { user: 'decoder_reader', pass: LIVE_DECODER_PASS },
            coin: COIN, network: NET, passKey: 'DECODER_DB_PASS', userKey: 'DECODER_DB_USER'
        });
        assert.strictEqual(out.pass, 'from-the-environment');
        assert.match(out.source, /environment/);
    });

    it('takes the oracle\'s live value ahead of the sidecar, which holds the pre-recreate copy', function () {
        process.env.XCHAIN_NODE_CONFIG_DIR = sidecarDir('DECODER_DB_PASS=stale-sidecar-copy\n');
        const out = resolveServiceCredential({
            oracle: { user: 'decoder_reader', pass: LIVE_DECODER_PASS },
            coin: COIN, network: NET, passKey: 'DECODER_DB_PASS', userKey: 'DECODER_DB_USER'
        });
        assert.strictEqual(out.pass, LIVE_DECODER_PASS,
            'the stale sidecar copy beat the live value the oracle served');
        assert.match(out.source, /config oracle/);
    });
}

// The sidecar fallback, the other-coin environment, and the sentinel refusal.
function registerStoreFallbackTests(resolveServiceCredential) {
    it('falls back to the sidecar when the oracle served the redacted tier', function () {
        process.env.XCHAIN_NODE_CONFIG_DIR = sidecarDir('DECODER_DB_PASS=only-the-sidecar-has-it\n');
        const out = resolveServiceCredential({
            oracle: { user: 'decoder_reader', pass: SENTINEL },
            coin: COIN, network: NET, passKey: 'DECODER_DB_PASS', userKey: 'DECODER_DB_USER'
        });
        assert.strictEqual(out.pass, 'only-the-sidecar-has-it');
        assert.match(out.source, /xc2114-/);
    });

    it('ignores the environment entirely when it describes another coin', function () {
        // The AT5 trap: taking Bitcoin's decoder account for a DOGE decoder
        // authenticates and then fails ER_TABLEACCESS_DENIED on a database it
        // holds no grant for, which reads as a broken decoder.
        process.env.DECODER_DB_PASS = 'bitcoins-credential';
        const out = resolveServiceCredential({
            oracle: { user: 'decoder_reader', pass: LIVE_DECODER_PASS },
            coin: COIN, network: NET, allowEnv: false,
            passKey: 'DECODER_DB_PASS', userKey: 'DECODER_DB_USER'
        });
        assert.strictEqual(out.pass, LIVE_DECODER_PASS);
        assert.strictEqual(out.user, 'decoder_reader');
    });

    it('never returns the sentinel as a password', function () {
        const out = resolveServiceCredential({
            oracle: { user: 'decoder_reader', pass: SENTINEL },
            coin: 'nosuchcoin', network: 'nosuchnet', passKey: 'DECODER_DB_PASS'
        });
        assert.strictEqual(out.pass, undefined, 'the sentinel was handed back as a password');
        assert.match(out.problem, /redacts every password/);
    });
}

function registerStoreOrderTests() {
    const { resolveServiceCredential } = require('../../helpers/oracleBatchReplay.js');

    registerStorePrecedenceTests(resolveServiceCredential);
    registerStoreFallbackTests(resolveServiceCredential);
}

function registerEnvDescribesCoinTests() {
    const { envDescribesCoin } = require('../../helpers/oracleBatchReplay.js');

    it('is false when the environment declares no coin, rather than guessing', function () {
        delete process.env.COIN;
        delete process.env.INDEXER_COIN;
        assert.strictEqual(envDescribesCoin('dogecoin'), false);
    });

    it('is true only for the coin the environment declares', function () {
        process.env.COIN = 'BTC';
        assert.strictEqual(envDescribesCoin('bitcoin'), true);
        assert.strictEqual(envDescribesCoin('dogecoin'), false);
    });
}

function registerReadHubConfigTreeTests() {
    const { readHubConfigTree } = require('../../helpers/oracleBatchReplay.js');

    it('reports a served credential tier as unredacted', async function () {
        const { StubHubConnector } = hubServing({ authorized: true });
        const out = await readHubConfigTree(new StubHubConnector());
        assert.strictEqual(out.secretsRedacted, false);
        assert.strictEqual(out.configs[COIN][NET]['xchain-decoder'].pass, LIVE_DECODER_PASS);
    });

    it('treats a hub too old to carry the flag as redacting', async function () {
        class OldHub {
            async ['_call']() { return { configs: configTree(true), seq: 1 }; }
            async getAllConfig() { return configTree(true); }
        }
        const out = await readHubConfigTree(new OldHub());
        assert.strictEqual(out.secretsRedacted, true,
            'a tree with no secrets_redacted flag must be assumed redacted, or the sentinel is passed on');
    });

    it('falls back to the ordinary read for a connector with no transport of its own', async function () {
        class PlainOnly {
            async getAllConfig() { return configTree(true); }
        }
        const out = await readHubConfigTree(new PlainOnly());
        assert.strictEqual(out.secretsRedacted, true);
        assert.ok(out.configs[COIN], 'the fallback read returned no tree');
    });

    it('is null when no tree can be read at all', async function () {
        class DeadHub {
            async ['_call']() { return null; }
            async getAllConfig() { return null; }
        }
        assert.strictEqual(await readHubConfigTree(new DeadHub()), null);
    });
}

describe('oracleBatchReplay: the credential path', function () {
    this.timeout(20000);

    registerCredentialEnvIsolation();

    registerCredentialTierTests();

    registerSentinelAndOptionalIndexerTests();

    describe('the store order', registerStoreOrderTests);

    describe('envDescribesCoin: which coin the harness environment is about', registerEnvDescribesCoinTests);

    describe('readHubConfigTree: which tier answered', registerReadHubConfigTreeTests);
});
