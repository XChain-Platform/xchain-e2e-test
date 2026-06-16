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
 *
 * XChain Platform E2E - SDK WebSocket live action events (on-chain)
 *
 * xchain-sdk/src/websocket.js is the real-time client the wallet uses
 * for live balance/action updates. It has only unit tests (mocked
 * sockets) — nothing exercises it end-to-end against the live explorer
 * WebSocket server (xchain-explorer/src/ws/*). This suite closes that
 * gap: it opens a real WS to the running explorer, subscribes to the
 * `actions` channel via the SDK's high-level `onAction`, submits a real
 * ISSUE through the SDK, and asserts the corresponding `NEW_ACTION`
 * event is pushed back over the socket.
 *
 * This exercises the full real-time pipeline: indexer write → explorer
 * ChangeDetector → Broadcaster (coin-keyed fan-out) → WebSocketServer →
 * SDK dispatch. A coin-prefix mismatch (client connects as RBTC, the
 * broadcaster keys events per the indexer's coin) would surface here as
 * "event never arrives".
 *
 *     COIN=bitcoin NETWORK=regtest npm run test:sdk
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const { makeSdk, submit, fundedGasAddress, uniqueTick, submitOpts } = require('./sdkHelper');

function haveConnectors() {
    return global.regtestMinerConnector && global.utxoTrackerConnector && global.nodeConnector;
}

// Poll a predicate over collected events until it matches or we time out.
async function waitFor(predicate, timeoutMs = 60000, pollMs = 250) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const hit = predicate();
        if (hit) return hit;
        if (Date.now() > deadline) return null;
        await new Promise((r) => setTimeout(r, pollMs));
    }
}

describe('[sdk] websocket live action events', function () {
    this.timeout(0);

    let sdk, issuer, events, unsub;

    before(async function () {
        if (!haveConnectors()) this.skip();
        sdk = makeSdk();
        // Connect the real WS (resolves on the explorer's WELCOME frame).
        await sdk.connectWs();
        events = [];
        unsub = sdk.onAction((msg) => { events.push(msg); });
        // Fund + gas an issuer so we can submit a fee-paying ISSUE.
        issuer = await fundedGasAddress(sdk, 1);
    });

    after(function () {
        try { if (unsub) unsub(); } catch (e) { /* ignore */ }
        try { sdk.disconnectWs(); } catch (e) { /* ignore */ }
    });

    it('connects and receives the explorer WELCOME', function () {
        expect(sdk.ws && sdk.ws.isConnected(), 'ws connected after connectWs()').to.equal(true);
    });

    it('pushes a NEW_ACTION event when an action is indexed', async function () {
        const tick = uniqueTick('WS');
        const res = await submit(
            sdk,
            { action: 'ISSUE', params: { tick, maxSupply: 1000, mintSupply: 1000, decimals: 0, description: 'ws-live' } },
            { pubkey: issuer.address, change: issuer.address },
            submitOpts({ wif: issuer.wif }),
        );
        // The action must have been indexed (NEW_ACTION fires for any indexed action
        // regardless of validity). We don't hard-require status==='valid' here — the
        // indexed-status read can race the indexer under regtest load, and this suite
        // is about WebSocket delivery, not submit validity.
        expect(res.indexed, 'ISSUE was indexed').to.be.an('object');

        const evt = await waitFor(() => events.find((e) =>
            e && e.type === 'NEW_ACTION' && e.data
            && e.data.action === 'ISSUE'
            && e.data.source === issuer.address));

        if (!evt) {
            const seen = events.map((e) => e && e.type).filter(Boolean);
            throw new Error(
                'No NEW_ACTION event for the ISSUE arrived over the WebSocket within 60s. '
                + 'Real-time delivery is broken (e.g. broadcaster coin-key mismatch). '
                + 'Events seen: [' + seen.join(', ') + ']');
        }
        expect(evt.data.action, 'event carries the action type').to.equal('ISSUE');
        expect(evt.data.source, 'event carries the source address').to.equal(issuer.address);
        expect(evt.data.action_index, 'event carries a numeric action_index (BigInt-safe)').to.be.a('number');
        // NOTE: the generic actions feed reports status as null — status lives only on
        // the per-ACTION-type tables, not the `actions` table. Clients needing status
        // fetch the action detail; the real-time event is a "something changed" signal
        // carrying type + source + index.
    });
});
