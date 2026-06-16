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
 * XChain Platform E2E - SDK-driven cross-contract calls (emit.execute)
 *
 * Deploys a caller contract (A) and a callee contract (B), then proves:
 *   1. A→B deferred call updates B's state, with B seeing A's derived
 *      address as the source (caller authentication).
 *   2. A→B→A callback round-trip (cycles within the depth budget).
 *   3. A failed callee (revert in B) rolls back the WHOLE tree —
 *      including A's own state writes from the same method.
 *   4. Exceeding MAX_CALL_DEPTH (4) fails the tree deterministically.
 *
 ********************************************************************/

const { expect } = require('chai');
const { makeSdk, submit, fundedGasAddress, mine, submitOpts } = require('./sdkHelper');

// Callee: records who called it; can call back; can revert on demand.
const CONTRACT_B = `
    module.exports = {
        initialize: function() {
            xchain.state.set('pings', '0');
        },
        onPing: function(xchain) {
            xchain.state.set('lastCaller', xchain.getSourceAddress());
            xchain.state.set('pings', xchain.math.add(xchain.state.get('pings') || '0', '1'));
            // Call back into the caller (params[0] = caller's contract index)
            var callerIndex = xchain.getInputParam(0);
            if (callerIndex) {
                xchain.emit.execute({
                    contractIndex: parseInt(callerIndex),
                    method: 'onAck',
                    params: [],
                    gasLimit: 30000
                });
            }
        },
        fail: function(xchain) {
            xchain.revert('B always fails here');
        }
    };
`;

// Caller: calls B (optionally a failing method); supports bounded recursion.
const CONTRACT_A = `
    module.exports = {
        initialize: function() {
            xchain.state.set('acks', '0');
        },
        myIndex: function(xchain) {
            return xchain.getContractAddress().split(':')[2];
        },
        callB: function(xchain) {
            var target = parseInt(xchain.getInputParam(0));
            var self = xchain.getContractAddress().split(':')[2];
            xchain.emit.execute({
                contractIndex: target,
                method: 'onPing',
                params: [self],
                gasLimit: 200000
            });
        },
        onAck: function(xchain) {
            xchain.state.set('acks', xchain.math.add(xchain.state.get('acks') || '0', '1'));
        },
        callFail: function(xchain) {
            // This marker must ROLL BACK when the callee reverts.
            xchain.state.set('marker', 'should-not-survive');
            var target = parseInt(xchain.getInputParam(0));
            xchain.emit.execute({
                contractIndex: target,
                method: 'fail',
                params: [],
                gasLimit: 50000
            });
        },
        recurse: function(xchain) {
            var self = xchain.getContractAddress().split(':')[2];
            var nextLimit = parseInt(xchain.getInputParam(0));
            xchain.state.set('depthMarker', String(xchain.getCallDepth()));
            xchain.emit.execute({
                contractIndex: parseInt(self),
                method: 'recurse',
                params: [String(Math.floor(nextLimit / 2))],
                gasLimit: nextLimit
            });
        }
    };
`;

function contractIndexOf(indexed) {
    const a = indexed && Array.isArray(indexed.actions) ? indexed.actions[0] : null;
    return a ? a.action_index : null;
}

// Per-action status. The waiter's normalized top-level `status` only goes
// non-valid for "invalid:"-prefixed rejections; VM execution failures
// ('failed' / 'reverted' / 'out_of_resource') live on the action row itself.
function actionStatusOf(indexed) {
    const a = indexed && Array.isArray(indexed.actions) ? indexed.actions[0] : null;
    return a ? a.status : (indexed && indexed.status);
}

async function readState(sdk, contractIndex, key) {
    const state = await sdk.getContractState(contractIndex, key);
    const rows = (state && state.data) || [];
    const row = rows.find(r => r.state_key === key);
    return row ? JSON.parse(row.state_value) : null;
}

describe('[sdk] cross-contract calls (emit.execute)', function () {
    this.timeout(0);

    let sdk, deployer, indexA, indexB;

    before(async function () {
        sdk = makeSdk();
        deployer = await fundedGasAddress(sdk, 1);
        console.log('    [sdk] deployer=' + deployer.address);
    });

    it('DEPLOY caller (A) and callee (B)', async function () {
        const resB = await submit(sdk,
            { action: 'DEPLOY', params: { code: CONTRACT_B, gasLimit: 200000, constructorParams: 'initialize' } },
            { pubkey: deployer.address, change: deployer.address },
            submitOpts({ wif: deployer.wif })
        );
        expect(resB.indexed.status).to.equal('valid');
        indexB = contractIndexOf(resB.indexed);

        const resA = await submit(sdk,
            { action: 'DEPLOY', params: { code: CONTRACT_A, gasLimit: 200000, constructorParams: 'initialize' } },
            { pubkey: deployer.address, change: deployer.address },
            submitOpts({ wif: deployer.wif })
        );
        expect(resA.indexed.status).to.equal('valid');
        indexA = contractIndexOf(resA.indexed);
        console.log('    [sdk] A=' + indexA + ' B=' + indexB);
    });

    it('A→B call updates B and authenticates A; B→A callback lands (round trip)', async function () {
        const res = await submit(sdk,
            { action: 'EXECUTE', params: { contractActionIndex: indexA, method: 'callB', params: [String(indexB)] } },
            { pubkey: deployer.address, change: deployer.address },
            submitOpts({ wif: deployer.wif })
        );
        console.log('    [sdk] EXECUTE callB status=' + res.indexed.status);
        expect(res.indexed.status).to.equal('valid');
        await mine(1);

        // B ran, and saw A's derived address as its caller
        expect(String(await readState(sdk, indexB, 'pings'))).to.equal('1');
        const lastCaller = await readState(sdk, indexB, 'lastCaller');
        expect(String(lastCaller)).to.match(new RegExp(':' + indexA + '$'),
            'B must see C:<CHAIN>:' + indexA + ' as its caller');

        // ...and B's callback into A ran too (depth 2)
        expect(String(await readState(sdk, indexA, 'acks'))).to.equal('1');
    });

    it('a reverting callee rolls back the whole tree (strict atomicity)', async function () {
        const res = await submit(sdk,
            { action: 'EXECUTE', params: { contractActionIndex: indexA, method: 'callFail', params: [String(indexB)] } },
            { pubkey: deployer.address, change: deployer.address },
            submitOpts({ wif: deployer.wif })
        );
        console.log('    [sdk] EXECUTE callFail status=' + actionStatusOf(res.indexed));
        // 'emission failed: EXECUTE: reverted' → stable 'failed' token on the action row
        expect(actionStatusOf(res.indexed)).to.equal('failed');
        await mine(1);

        // A's own pre-call state write must NOT survive
        expect(await readState(sdk, indexA, 'marker')).to.equal(null);
        // B was not pinged again
        expect(String(await readState(sdk, indexB, 'pings'))).to.equal('1');
    });

    it('recursion past MAX_CALL_DEPTH fails the tree deterministically', async function () {
        const res = await submit(sdk,
            { action: 'EXECUTE', params: { contractActionIndex: indexA, method: 'recurse', params: ['400000'] } },
            { pubkey: deployer.address, change: deployer.address },
            submitOpts({ wif: deployer.wif })
        );
        console.log('    [sdk] EXECUTE recurse status=' + actionStatusOf(res.indexed));
        expect(actionStatusOf(res.indexed)).to.equal('failed');
        await mine(1);
        // depthMarker would have been written at every level — all rolled back
        expect(await readState(sdk, indexA, 'depthMarker')).to.equal(null);
    });
});
