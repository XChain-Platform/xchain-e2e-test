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
 * XCALL e2e: stake additional federation validators (standalone driver).
 *
 * For each Ed25519 pubkey passed as an argv, funds a FRESH address and
 * STAKEs 5000 XCHAIN for the cross_chain capability with that pubkey
 * (signingPubkey is 1:1 with the staking address, so each validator gets
 * its own funder). Mines past ACTIVATION_DELAY_BLOCKS at the end.
 *
 * Runs under the BTC regtest e2e env as a one-shot mocha spec (the sdk
 * helpers need the initialCheck bootstrap):
 *
 *   XCALL_STAKE_PUBKEYS=<hex>,<hex> npx mocha --timeout 0 --exit \
 *     --require ./test/initialCheck.test.js test/sdk/xcallStakeValidators.js
 *
 ********************************************************************/

const { expect } = require('chai');
const axios = require('axios');
const { makeSdk, submit, fundedGasAddress, mine, submitOpts } = require('./sdkHelper');

// Source-indexer JSON-RPC endpoint (same default the XCALL suites use).
const SOURCE_INDEXER_URL = 'http://' + (process.env.INDEXER_URL || 'localhost') + ':' + (process.env.INDEXER_API_PORT || '3024');

async function rpc(method, params) {
    const res = await axios.post(SOURCE_INDEXER_URL, { jsonrpc: '2.0', method, params: params || {}, id: 1 }, { timeout: 15000 });
    if (res.data && res.data.error) throw new Error(method + ': ' + JSON.stringify(res.data.error));
    const result = res.data ? res.data.result : null;
    // Federation reads answer an APPLICATION error inside `result` rather than as
    // a JSON-RPC error; reading `.validators` straight off one yields an EMPTY set
    // indistinguishable from "nobody is staked" - the read this must never get wrong.
    if (result && typeof result === 'object' && typeof result.error === 'string')
        throw new Error(method + ': ' + result.error);
    return result;
}

// Live cross_chain stake snapshot, tolerant of the one-block lag between the
// indexer tip and its committed API view (a read at the just-announced tip
// legitimately answers "not yet indexed").
async function crossChainSnapshot(attempts = 40) {
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
        try {
            const tip = (await rpc('getlatestblock', {})).block_index;
            const res = await rpc('getstakeweightsbycapability', { capability: 'cross_chain', block_index: Number(tip) });
            return res.validators || [];
        } catch (err) {
            lastErr = err;
            if (!/not yet indexed/.test(String(err.message))) throw err;
            await new Promise(r => setTimeout(r, 1500)); // poll interval, re-checks the condition
        }
    }
    throw lastErr;
}

// Poll the snapshot until every wanted pubkey is an active validator (or the
// budget runs out, at which point the caller's assertions report exactly which
// pubkey is still missing rather than a bare timeout).
async function waitForActiveValidators(wantPubkeys, attempts = 40) {
    let byPubkey = new Map();
    for (let i = 0; i < attempts; i++) {
        const rows = await crossChainSnapshot();
        byPubkey = new Map(rows.map(r => [String(r.pubkey).toLowerCase(), r]));
        if (wantPubkeys.every(pk => byPubkey.has(pk))) break;
        await new Promise(r => setTimeout(r, 1500)); // poll interval, re-checks the condition
    }
    return byPubkey;
}

describe('[sdk] stake additional XCALL federation validators', function () {
    this.timeout(0);

    it('stakes every pubkey in XCALL_STAKE_PUBKEYS and registers them as active cross_chain validators', async function () {
        // Each entry is `pubkey` (defaults to 5000) or `pubkey:amount` for an
        // uneven federation. Stake-weighted quorum dedupes by SOURCE, so each pubkey
        // gets its own fresh funder (one source per validator); uneven amounts let a
        // 2f+1 drill keep the down-first hub strictly under 1/3 of total stake.
        const specs = String(process.env.XCALL_STAKE_PUBKEYS || '').split(',').map(s => s.trim()).filter(Boolean)
            .map(s => { const [pk, amt] = s.split(':'); return { pubkey: pk, amount: amt || '5000' }; });
        expect(specs.length, 'XCALL_STAKE_PUBKEYS must list at least one `pubkey` or `pubkey:amount` entry').to.be.above(0);
        for (const s of specs) {
            expect(s.pubkey, 'signingPubkey must be a 64-hex Ed25519 key').to.match(/^[0-9a-f]{64}$/);
            expect(s.amount, 'stake amount must be numeric').to.match(/^[0-9]+(\.[0-9]+)?$/);
        }

        const sdk = makeSdk();
        for (const { pubkey, amount } of specs) {
            const staker = await fundedGasAddress(sdk, 1);
            try {
                const res = await submit(sdk,
                    { action: 'STAKE', params: { amount: Number(amount).toFixed(8), signingPubkey: pubkey } },
                    { pubkey: staker.address, change: staker.address },
                    submitOpts({ wif: staker.wif })
                );
                expect(res.indexed.status, 'STAKE of ' + pubkey.substring(0, 16) + '... must index valid').to.equal('valid');
                console.log('    [stake-validators] ' + pubkey.substring(0, 16) + '... staked ' + amount + ' by ' + staker.address);
            } catch (e) {
                if (/SIGNING_PUBKEY \(already in use\)/.test(String(e.message))) {
                    console.log('    [stake-validators] ' + pubkey.substring(0, 16) + '... already staked, skipping');
                } else {
                    throw e;
                }
            }
        }
        await mine(8); // past ACTIVATION_DELAY_BLOCKS (6)

        // Behavioral check: staking for the cross_chain capability must actually
        // make each pubkey an ACTIVE federation validator. Read the source
        // indexer's stake-weight snapshot back and require every pubkey we staked
        // (or found already staked) to be present with a positive weight and its
        // own staking source. Without this the driver could report success while
        // the indexer registered nothing, and every XCALL suite that trusts the
        // federation would then run against a phantom quorum.
        const wantPubkeys = [...new Set(specs.map(s => s.pubkey.toLowerCase()))];
        const byPubkey = await waitForActiveValidators(wantPubkeys);
        const seenSources = new Set();
        for (const pk of wantPubkeys) {
            const row = byPubkey.get(pk);
            expect(row, pk.substring(0, 16) + '... must be an active cross_chain validator after STAKE').to.not.equal(undefined);
            expect(Number(row.weight), 'cross_chain stake weight for ' + pk.substring(0, 16) + '...').to.be.above(0);
            expect(String(row.source || ''), 'staking source for ' + pk.substring(0, 16) + '...').to.not.equal('');
            seenSources.add(String(row.source));
        }
        // The driver funds a FRESH funder per validator (one source per pubkey),
        // so distinct sources must equal distinct pubkeys; a collapse means two
        // validators shared a stake source and the federation is narrower than it
        // was declared to be - exactly the SOURCE-dedup the quorum math relies on.
        expect(seenSources.size, 'each staked pubkey must map to its own staking source').to.equal(wantPubkeys.length);

        console.log('    [stake-validators] done (' + specs.length + ' pubkeys, ' + seenSources.size + ' active source(s) verified)');
    });
});
