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
 * The AT2 rig's EXPLICIT live-chain override, and the barrier drill's env
 * contract, pinned without a chain, a database or a hub.
 *
 * WHY THIS EXISTS. The override's whole reason for being is a host whose
 * standing hub cannot be asked: `_resolveLiveChain` normally dials
 * XChainHubConnector and calls `getAllConfig`, an auth-gated read, and on such a
 * host that call fails and no node can be built at all. An override that
 * "worked" but still dialled the hub would pass every integration run on a
 * machine that HAS a hub and fail only on the one machine it was written for, so
 * the assertion here is not "the shape came back" but "the connector was never
 * constructed".
 *
 * The second half is the launcher's contract. Every endpoint the drill needs
 * arrives by environment-variable NAME, is read once, and is then invisible
 * inside a child process: a variable exported under the wrong name degrades into
 * a node that indexes nothing, hours later, which is indistinguishable from the
 * barrier result the drill exists to measure. So the composition is pure and
 * pinned here, and a missing variable is named rather than defaulted.
 ********************************************************************/

const assert     = require('assert');
const proxyquire = require('proxyquire');

// A full, well-formed override, in the shape `_resolveLiveChain` returns. The
// values are obvious fakes: nothing in this file opens a socket.
function fullOverride() {
    return {
        decoder: { host: '127.0.0.1', port: 13306, name: 'Decoder_Db', user: 'reader', pass: 'decoder-pass' },
        node:    { host: '127.0.0.1', port: 44555, user: 'rpcuser', pass: 'rpc-pass' },
        tracker: { host: '127.0.0.1', port: 3033 },
        btcOracle: { host: '10.0.0.9', port: 3014, url: 'http://10.0.0.9:3014', apiKey: 'btc-key' },
        feeDestination: 'nsFeeDestinationAddressForTheChain'
    };
}

// The rig with its hub connector replaced by a counter. `parseEndpoints` and
// `ping` are present so that a rig which IGNORED the override would take the
// discovery path to its normal end (unavailable, null) instead of dying on a
// missing static, which would make the falsification pass for the wrong reason.
function rigWithCountedConnector() {
    const seen = { constructed: 0, pinged: 0, configRead: 0 };
    class CountingHubConnector {
        constructor() { seen.constructed++; }
        static parseEndpoints() { return ['http://127.0.0.1:1']; }
        async ping() { seen.pinged++; return false; }
        async getAllConfig() { seen.configRead++; return {}; }
    }
    const mod = proxyquire('../helpers/oracleBatchReplay.js', {
        '../../src/XChainHubConnector.js': CountingHubConnector
    });
    return { mod: mod, seen: seen };
}

describe('oracleBatchReplay: the explicit live-chain override (AT5 venue, row 41)', function () {
    this.timeout(20000);

    it('resolves the caller\'s endpoints and never constructs the hub connector', async function () {
        const { mod, seen } = rigWithCountedConnector();
        const override = fullOverride();
        const node = new mod.OracleBatchReplayNode({
            label: 'at5unit', coin: 'dogecoin', network: 'testnet', liveChain: override });

        const live = await node._resolveLiveChain();

        assert.strictEqual(seen.constructed, 0,
            'the rig constructed the hub connector ' + seen.constructed + ' time(s) despite being given an ' +
            'explicit live chain. The override exists precisely for a host whose standing hub carries no key ' +
            'and cannot answer getAllConfig, so any dial at all defeats it.');
        assert.strictEqual(seen.pinged, 0, 'the rig pinged the standing hub despite an explicit live chain');
        assert.strictEqual(seen.configRead, 0,
            'the rig read the standing hub\'s config oracle despite an explicit live chain');
        assert.strictEqual(node.unavailable, null, 'the node reported itself unavailable: ' + node.unavailable);

        assert.deepStrictEqual(live.decoder, override.decoder, 'the decoder endpoints were not passed through');
        assert.deepStrictEqual(live.node, override.node, 'the coin node endpoints were not passed through');
        assert.deepStrictEqual(live.tracker, override.tracker, 'the tracker endpoints were not passed through');
        assert.strictEqual(live.feeDestination, override.feeDestination, 'the fee destination was not passed through');
        assert.strictEqual(live.btcOracle.url, override.btcOracle.url, 'the Bitcoin oracle URL was not passed through');
        assert.strictEqual(live.btcOracle.apiKey, override.btcOracle.apiKey, 'the Bitcoin oracle key was not passed through');
        // Both optional halves are normalized rather than left undefined: the one
        // reader of each has to be able to test them.
        assert.strictEqual(live.liveIndexer, null, 'an omitted liveIndexer must normalize to null, not undefined');
        assert.strictEqual(live.btcOracle.db, null, 'an omitted Bitcoin oracle database must normalize to null');
    });

    it('carries an explicit liveIndexer through when one is given', async function () {
        const { mod } = rigWithCountedConnector();
        const override = fullOverride();
        override.liveIndexer = { host: '127.0.0.1', port: 13306, name: 'Live_Indexer', user: 'r', pass: 'p' };
        const node = new mod.OracleBatchReplayNode({ label: 'at5unit', liveChain: override });
        const live = await node._resolveLiveChain();
        assert.deepStrictEqual(live.liveIndexer, override.liveIndexer);
    });

    describe('a malformed override is refused by the FIELD that is missing', function () {
        // Each case drops exactly one field, so a message that names the wrong one
        // is a real defect: this error is the only signal a launcher gets before
        // the node spends hours indexing nothing.
        const cases = [
            ['decoder.pass',      (o) => { delete o.decoder.pass; }],
            ['decoder.name',      (o) => { o.decoder.name = ''; }],
            ['node.port',         (o) => { delete o.node.port; }],
            ['tracker.host',      (o) => { delete o.tracker.host; }],
            ['btcOracle.apiKey',  (o) => { o.btcOracle.apiKey = null; }],
            ['btcOracle',         (o) => { delete o.btcOracle; }],
            ['feeDestination',    (o) => { delete o.feeDestination; }],
            ['liveIndexer.name',  (o) => { o.liveIndexer = { host: 'h', port: 1, user: 'u', pass: 'p' }; }]
        ];
        for (const [field, breakIt] of cases) {
            it('names `' + field + '`', async function () {
                const { mod, seen } = rigWithCountedConnector();
                const override = fullOverride();
                breakIt(override);
                const node = new mod.OracleBatchReplayNode({ label: 'at5unit', liveChain: override });
                await assert.rejects(() => node._resolveLiveChain(), (err) => {
                    assert.ok(err instanceof Error, 'a malformed override must reject with an Error');
                    assert.ok(err.message.indexOf(field) !== -1,
                        'the refusal must name the missing field `' + field + '`; it said: ' + err.message);
                    return true;
                });
                assert.strictEqual(seen.constructed, 0,
                    'a malformed override must be refused outright, never fall back to dialling the standing hub');
            });
        }

        it('refuses a feeDestination that is neither an address nor null', async function () {
            const { mod } = rigWithCountedConnector();
            const override = fullOverride();
            override.feeDestination = 12345;
            const node = new mod.OracleBatchReplayNode({ label: 'at5unit', liveChain: override });
            await assert.rejects(() => node._resolveLiveChain(), /feeDestination/);
        });

        it('accepts an explicitly null feeDestination, which means the pinned default', async function () {
            const { mod } = rigWithCountedConnector();
            const override = fullOverride();
            override.feeDestination = null;
            const node = new mod.OracleBatchReplayNode({ label: 'at5unit', liveChain: override });
            const live = await node._resolveLiveChain();
            assert.strictEqual(live.feeDestination, null);
        });
    });

    it('refuses to read the standing chain\'s fee coordinates when the override names no liveIndexer', async function () {
        // The one reader of `liveIndexer`. AT2's cross-node comparison needs it;
        // the barrier drill does not, and the difference has to be legible rather
        // than surfacing as a null host inside the MariaDB driver.
        const { mod } = rigWithCountedConnector();
        const node = new mod.OracleBatchReplayNode({ label: 'at5unit', liveChain: fullOverride() });
        node._live = await node._resolveLiveChain();
        await assert.rejects(() => node.liveChainFeeCoordinates({}), /liveIndexer/);
    });
});

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
describe('oracleBatchReplay: the credential path', function () {
    this.timeout(20000);

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
            async _call(body) {
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
        return proxyquire('../helpers/oracleBatchReplay.js', {
            '../../src/XChainHubConnector.js': StubHubConnector,
            '../../src/XChainIndexerConnector.js': StubIndexerConnector
        });
    }

    const CRED_ENV = ['DECODER_DB_PASS', 'DECODER_DB_USER', 'INDEXER_DB_PASS', 'INDEXER_DB_USER',
        'NODE_PASSWORD', 'NODE_USER', 'COIN', 'INDEXER_COIN', 'XCHAIN_NODE_CONFIG_DIR'];
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

    it('hands a child the LIVE credential the oracle serves, never the sentinel', async function () {
        const { StubHubConnector, seen } = hubServing({ authorized: true });
        const node = new (rigModule(StubHubConnector).OracleBatchReplayNode)(
            { label: 'cred', coin: COIN, network: NET });

        const live = await node._resolveLiveChain();

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

            const live = await node._resolveLiveChain();

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

    it('never lets the sentinel reach a child, whatever else it does', async function () {
        // The single property the whole item is about, asserted over every
        // credential the rig passes on rather than over one of them.
        const { StubHubConnector } = hubServing({ authorized: false });
        const node = new (rigModule(StubHubConnector).OracleBatchReplayNode)(
            { label: 'cred', coin: COIN, network: NET });
        const live = await node._resolveLiveChain();
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
                async _call(body) {
                    const out = await StubHubConnector.prototype._call.call(this, body);
                    if (out && out.configs) out.configs[COIN][NET]['xchain-indexer'].pass = SENTINEL;
                    return out;
                }
            }
            const node = new (rigModule(PartialHub).OracleBatchReplayNode)(
                { label: 'cred', coin: COIN, network: NET });

            const live = await node._resolveLiveChain();

            assert.ok(live, 'the node failed over an optional credential: ' + node.unavailable);
            assert.strictEqual(live.liveIndexer, null, 'an unresolvable live indexer must normalize to null');
            assert.match(String(node.liveIndexerUnavailable), /INDEXER_DB_PASS/,
                'the reason must name the credential that could not be resolved');
        });

    describe('the store order', function () {
        const { resolveServiceCredential } = require('../helpers/oracleBatchReplay.js');

        function sidecarDir(contents) {
            const dir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'xc2114-'));
            fs2.writeFileSync(path2.join(dir, COIN + '-' + NET + '.local'), contents);
            return dir;
        }

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
    });

    describe('envDescribesCoin: which coin the harness environment is about', function () {
        const { envDescribesCoin } = require('../helpers/oracleBatchReplay.js');

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
    });

    describe('readHubConfigTree: which tier answered', function () {
        const { readHubConfigTree } = require('../helpers/oracleBatchReplay.js');

        it('reports a served credential tier as unredacted', async function () {
            const { StubHubConnector } = hubServing({ authorized: true });
            const out = await readHubConfigTree(new StubHubConnector());
            assert.strictEqual(out.secretsRedacted, false);
            assert.strictEqual(out.configs[COIN][NET]['xchain-decoder'].pass, LIVE_DECODER_PASS);
        });

        it('treats a hub too old to carry the flag as redacting', async function () {
            class OldHub {
                async _call() { return { configs: configTree(true), seq: 1 }; }
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
                async _call() { return null; }
                async getAllConfig() { return null; }
            }
            assert.strictEqual(await readHubConfigTree(new DeadHub()), null);
        });
    });
});

describe('oracleBatchBarrierTestnet: the launcher environment contract (row 41)', function () {

    const drill = require('../drills/oracleBatchBarrierTestnet.drill.js');

    // The complete set the launcher exports, by name.
    function fullEnv() {
        return {
            AT5_DECODER_DB_HOST: 'db.internal', AT5_DECODER_DB_PORT: '3306',
            AT5_DECODER_DB_NAME: 'XChain_TDOGE_Decoder', AT5_DECODER_DB_USER: 'decoder_reader',
            AT5_DECODER_DB_PASS: 'decoder-secret',
            AT5_NODE_HOST: 'node.internal', AT5_NODE_PORT: '44555',
            AT5_NODE_USER: 'rpc', AT5_NODE_PASS: 'rpc-secret',
            AT5_TRACKER_HOST: 'tracker.internal', AT5_TRACKER_PORT: '3033',
            AT5_FEE_DESTINATION: 'nsFeeDestinationAddress',
            BTC_SERVICE_HOST: 'btc.internal', BTC_INDEXER_API_PORT: '3014',
            BTC_INDEXER_API_KEY: 'btc-secret'
        };
    }

    it('composes exactly the shape the rig\'s override validator accepts', function () {
        const live = drill.composeLiveChainFromEnv(fullEnv());
        assert.deepStrictEqual(live, {
            decoder: { host: 'db.internal', port: '3306', name: 'XChain_TDOGE_Decoder',
                user: 'decoder_reader', pass: 'decoder-secret' },
            node: { host: 'node.internal', port: '44555', user: 'rpc', pass: 'rpc-secret' },
            tracker: { host: 'tracker.internal', port: '3033' },
            btcOracle: { host: 'btc.internal', port: '3014', url: 'http://btc.internal:3014',
                apiKey: 'btc-secret', db: null },
            feeDestination: 'nsFeeDestinationAddress',
            liveIndexer: null
        });

        // The two halves must agree, which is the only thing that makes the
        // launcher's contract and the rig's contract one contract: what the drill
        // composes is what the rig accepts, checked by the rig itself.
        const { mod } = rigWithCountedConnector();
        const node = new mod.OracleBatchReplayNode({ label: 'at5unit', network: 'testnet', liveChain: live });
        return node._resolveLiveChain();
    });

    it('throws naming the FIRST variable the launcher failed to export', function () {
        // Read order is the documented contract order, so the message points at
        // the first gap rather than at whichever field the code happened to touch.
        const order = ['AT5_DECODER_DB_HOST', 'AT5_DECODER_DB_PORT', 'AT5_DECODER_DB_NAME',
            'AT5_DECODER_DB_USER', 'AT5_DECODER_DB_PASS', 'AT5_NODE_HOST', 'AT5_NODE_PORT',
            'AT5_NODE_USER', 'AT5_NODE_PASS', 'AT5_TRACKER_HOST', 'AT5_TRACKER_PORT',
            'AT5_FEE_DESTINATION', 'BTC_SERVICE_HOST', 'BTC_INDEXER_API_PORT', 'BTC_INDEXER_API_KEY'];
        for (const name of order) {
            const env = fullEnv();
            delete env[name];
            assert.throws(() => drill.composeLiveChainFromEnv(env), (err) => {
                assert.ok(err.message.indexOf(name) !== -1,
                    'dropping ' + name + ' must be reported by name; it said: ' + err.message);
                return true;
            }, 'dropping ' + name + ' was accepted silently');
        }
        // An empty value is a missing value: an exported-but-blank variable is the
        // commonest launcher failure and the one a truthiness test lets through.
        const blank = fullEnv();
        blank.AT5_NODE_PASS = '   ';
        assert.throws(() => drill.composeLiveChainFromEnv(blank), /AT5_NODE_PASS/);
    });

    it('defaults the observation budget, the origin control and the explorer', function () {
        const s = drill.readSettings({});
        assert.strictEqual(s.observeBlocks, 6);
        assert.strictEqual(s.maxMinutes, 240);
        assert.strictEqual(s.basePort, 61000);
        assert.strictEqual(s.label, 'at5');
        assert.strictEqual(s.resultPath, './at5-result.json');
        // No built-in origin host: the control endpoint is deployment-specific and
        // an unset value must take the explorer fallback, never a hard-coded dial.
        assert.strictEqual(s.originIndexerUrl, '');
        assert.strictEqual(s.explorerUrl, 'https://explorer.xchain.io');
        const over = drill.readSettings({ AT5_OBSERVE_BLOCKS: '2', AT5_MAX_MINUTES: '30',
            AT5_EXPLORER_URL: 'https://explorer.xchain.io/', AT5_LABEL: 'at5-b',
            AT5_ORIGIN_INDEXER_URL: 'http://origin.example.invalid:3114' });
        assert.strictEqual(over.observeBlocks, 2);
        assert.strictEqual(over.maxMinutes, 30);
        assert.strictEqual(over.originIndexerUrl, 'http://origin.example.invalid:3114');
        assert.strictEqual(over.label, 'at5b', 'the label lands in database names, so it must be an identifier');
        assert.strictEqual(over.explorerUrl, 'https://explorer.xchain.io', 'a trailing slash must not double up');
    });

    it('reads the barrier deferral line the indexer actually prints', function () {
        // Verbatim shape from xchain-indexer: XChainIndexer.js logs the defer and
        // hub_db_sync's waitForPriceSyncTime supplies the state in the message.
        const line = 'Deferring block 67879480 (price time-sync):  Error: price time-sync barrier timed out ' +
            'after 60000ms waiting for block time 1788914673 (mirror max round timestamp 1788910800, ' +
            'stream watermark at 1788914000)';
        const d = drill.parseDeferral(line);
        assert.ok(d, 'the price time-sync deferral line was not recognized at all');
        assert.strictEqual(d.height, 67879480);
        assert.strictEqual(d.mirrorMaxRoundTs, 1788910800);
        assert.strictEqual(d.streamWatermark, 1788914000);
        // A different barrier's deferral must not be counted as this one's: the
        // indexer defers blocks on nine separate barriers with the same prefix.
        assert.strictEqual(drill.parseDeferral('Deferring block 12 (oracle sync):  Error: x'), null);
        assert.strictEqual(drill.parseDeferral('Parsed block 67879480'), null);
    });

    it('classifies which escape opened the barrier, from what the node held', function () {
        const blockTime = 1_788_914_673;
        const deferral = [{ height: 1, mirrorMaxRoundTs: 0, streamWatermark: 0, line: 'x' }];
        // Never deferred: the barrier was satisfied on arrival.
        assert.strictEqual(drill.classifyEscape([], null, blockTime, 12).escape, 'none');
        // Deferred, and the mirror ended up holding a round at or past the block's
        // time: the CONTENT escape, which D61 says a chain-only node cannot reach
        // at the tip, so seeing it is a finding rather than a pass.
        assert.strictEqual(drill.classifyEscape(deferral, blockTime, blockTime, 4900).escape, 'content');
        assert.strictEqual(drill.classifyEscape(deferral, blockTime + 1, blockTime, 4900).escape, 'content');
        // Deferred and the mirror never caught up: the watermark is the only
        // escape the code has left.
        const w = drill.classifyEscape(deferral, blockTime - 600, blockTime, 4900);
        assert.strictEqual(w.escape, 'watermark');
        assert.strictEqual(w.corroborated, true, 'a 4900s stall is consistent with a 4800s grace');
        // A watermark escape that fired before the grace could have elapsed is not
        // consistent with the code, and the record must say so rather than smooth
        // it over.
        assert.strictEqual(drill.classifyEscape(deferral, null, blockTime, 90).corroborated, false);
    });

    it('summarizes only what the per-block records actually carry', function () {
        const summary = drill.summarize({
            observations: [
                { height: 10, stallS: 4801, escape: 'watermark', verdictAgreements: 3, verdictDisagreements: [],
                  actions: [{ coordinateAligned: true }, { coordinateAligned: true }, { coordinateAligned: true }],
                  holes: { missingFromHub: { count: 0 }, missingFromMirror: { count: 0 }, roundsCarried: 40 } },
                { height: 11, stallS: 4900, escape: 'watermark', verdictAgreements: 1,
                  verdictDisagreements: [{ actionIndex: 7, nodePricedAgainstRound: 1730, originPricedAgainstRound: 1732 }],
                  actions: [{ coordinateAligned: true }, { coordinateAligned: true }, { coordinateAligned: false }],
                  holes: { missingFromHub: { count: 0 }, missingFromMirror: { count: 2 }, roundsCarried: 42 } }
            ],
            originLagSeries: [{ lag: 0 }, { lag: 3 }, { unavailable: 'unauthorized (-32001)' }]
        });
        assert.strictEqual(summary.blocksObserved, 2);
        assert.strictEqual(summary.maxStallS, 4900);
        assert.strictEqual(summary.minStallS, 4801);
        assert.deepStrictEqual(summary.escapes, { watermark: 2 });
        assert.strictEqual(summary.stallsWithinGracePlusConfirm, 2, 'both stalls are at or past the 4800s grace');
        // The hole count comes from the LATEST observation, since coverage is
        // cumulative and an earlier clean read does not survive a later gap.
        assert.strictEqual(summary.holesTotal, 2);
        assert.strictEqual(summary.holesInMirror, 2);
        assert.strictEqual(summary.verdictsCompared, 5, 'only coordinate-aligned actions are comparable');
        assert.strictEqual(summary.verdictsAgreed, 4);
        assert.strictEqual(summary.verdictsDiverged, 1);
        assert.strictEqual(summary.divergences[0].originPricedAgainstRound, 1732,
            'a divergence must carry the round each side priced against (D61), or it is an anecdote');
        assert.strictEqual(summary.originMaxLag, 3);
        assert.strictEqual(summary.originIndexerUnavailable, 'unauthorized (-32001)',
            'an unreadable control must be reported, never smoothed into "no lag"');
    });
});
