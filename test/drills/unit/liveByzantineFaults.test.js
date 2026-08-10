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
 * Unit tests for the in-process-of-the-VICTIM byzantine injectors.
 *
 * Driven against duck-typed stand-ins for the hub, so the rules that decide
 * WHAT gets corrupted are pinned without a database or a network. The point
 * being defended: a forging validator must stay CONNECTED and keep voting.
 * If the injector corrupted transport auth too, peers would drop it and the
 * drill would silently degrade into a crash-fault test, which is a strictly
 * weaker adversary than the one the threat model asks about.
 ********************************************************************/

'use strict';

const assert = require('assert');
const byz = require('../lib/liveByzantineFaults');

function fakeHub() {
    const sent = [];
    const hub = {
        consensus: {
            handled: [],
            _handleMessage(m) { this.handled.push(m); },
            _digest: (c) => 'digest:' + JSON.stringify(c),
            peerManager: { validatorAddr: '10.0.0.1:41000' }
        },
        peerManager: {
            validatorAddr: '10.0.0.1:41000',
            _buildEnvelope(type, data) {
                const env = { type, data, sender: this.validatorAddr, sig: 'ab'.repeat(63) + 'c4', sig_pubkey: 'pub' };
                sent.push(env);
                return env;
            }
        }
    };
    return { hub, sent };
}

describe('liveByzantineFaults: what counts as consensus traffic', function () {
    it('forges the whole PBFT family and nothing else', function () {
        for (const t of ['PBFT_PRE_PREPARE', 'PBFT_PREPARE', 'PBFT_COMMIT', 'PBFT_VIEW_CHANGE', 'PBFT_NEW_VIEW']) {
            assert.strictEqual(byz.shouldForge(t), true, t + ' should be forged');
        }
        for (const t of ['HEARTBEAT', 'HANDSHAKE', 'GOV_PROPOSE', 'ATTEST_PREPARE', '', null, undefined]) {
            assert.strictEqual(byz.shouldForge(t), false, String(t) + ' must not be forged');
        }
    });
});

describe('liveByzantineFaults: signature corruption', function () {
    it('produces a different signature of the same length', function () {
        const sig = 'ab'.repeat(63) + 'c4';
        const bad = byz.corruptSignature(sig);
        assert.notStrictEqual(bad, sig);
        assert.strictEqual(bad.length, sig.length);
        assert.match(bad, /^[0-9a-f]+$/);
    });

    it('is deterministic, so a drill result reproduces', function () {
        assert.strictEqual(byz.corruptSignature('00ff'), byz.corruptSignature('00ff'));
    });

    it('leaves an empty or absent signature alone rather than inventing one', function () {
        assert.strictEqual(byz.corruptSignature(''), '');
        assert.strictEqual(byz.corruptSignature(null), null);
    });
});

describe('liveByzantineFaults: silenceConsensus', function () {
    it('drops every consensus message while the listener stays attached', function () {
        const { hub } = fakeHub();
        const listener = (m) => hub.consensus._handleMessage(m);   // the arrow Consensus.start registers
        listener({ type: 'PBFT_PREPARE' });
        assert.strictEqual(hub.consensus.handled.length, 1);

        const restore = byz.silenceConsensus(hub);
        listener({ type: 'PBFT_PREPARE' });
        listener({ type: 'PBFT_COMMIT' });
        assert.strictEqual(hub.consensus.handled.length, 1, 'a silenced node reacted to consensus traffic');

        restore();
        listener({ type: 'PBFT_COMMIT' });
        assert.strictEqual(hub.consensus.handled.length, 2, 'restore() did not put the node back');
    });

    it('refuses a hub with no consensus engine instead of silently doing nothing', function () {
        assert.throws(() => byz.silenceConsensus({}), /no started consensus engine/);
    });
});

describe('liveByzantineFaults: forgeConsensusSignatures', function () {
    it('corrupts PBFT signatures and leaves transport traffic verifiable', function () {
        const { hub } = fakeHub();
        const honest = hub.peerManager._buildEnvelope('PBFT_PREPARE', {}).sig;

        const restore = byz.forgeConsensusSignatures(hub);
        const pbft      = hub.peerManager._buildEnvelope('PBFT_PREPARE', { seq: 1 });
        const heartbeat = hub.peerManager._buildEnvelope('HEARTBEAT', {});

        assert.notStrictEqual(pbft.sig, honest, 'PBFT signature was not forged');
        assert.strictEqual(heartbeat.sig, honest, 'transport signature was forged; the victim will be disconnected');
        assert.strictEqual(restore.forgedCount(), 1);

        restore();
        assert.strictEqual(hub.peerManager._buildEnvelope('PBFT_PREPARE', {}).sig, honest, 'restore() left the victim forging');
    });

    it('keeps the envelope otherwise intact, so the victim is a voter not a stranger', function () {
        const { hub } = fakeHub();
        byz.forgeConsensusSignatures(hub);
        const env = hub.peerManager._buildEnvelope('PBFT_COMMIT', { seq: 9 });
        assert.strictEqual(env.sender, '10.0.0.1:41000');
        assert.strictEqual(env.sig_pubkey, 'pub');
        assert.deepStrictEqual(env.data, { seq: 9 });
    });

    it('refuses a hub with no peer manager', function () {
        assert.throws(() => byz.forgeConsensusSignatures({}), /no started peer manager/);
    });
});

describe('liveByzantineFaults: proposal envelopes', function () {
    it('builds a forged PRE_PREPARE whose digest cannot match its config', function () {
        const config = { BTC: { regtest: { node: { GAS_PRICE: '1' } } } };
        const env = byz.forgedPrePrepare(9100, config, 100);
        assert.strictEqual(env.type, 'PBFT_PRE_PREPARE');
        assert.strictEqual(env.data.seq, 9100);
        assert.strictEqual(env.data.configDigest, 'deadbeef'.repeat(8));
        assert.deepStrictEqual(env.data.config, config);
    });

    it('builds an honest PRE_PREPARE whose digest does match, for equivocation rounds', function () {
        const { hub } = fakeHub();
        const config = { BTC: { regtest: { node: { GAS_PRICE: '2' } } } };
        const env = byz.prePrepareEnvelope(hub.consensus, 42, 0, config, 100);
        assert.strictEqual(env.data.configDigest, hub.consensus._digest(config));
        assert.strictEqual(env.sender, '10.0.0.1:41000');
        assert.strictEqual(env.data.view, 0);
    });
});
