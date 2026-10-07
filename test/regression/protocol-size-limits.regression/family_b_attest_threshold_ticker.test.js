const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { protocol, assertVendored } = require('./support/environment')

void describe('Family-B constant parity (copies the full-export guard does not reach)', () => {

    // ATTEST_MAX_EXPIRIES_PER_BLOCK bounds how many attestation requests one
    // block may expire; the indexer reads it as the default limit of
    // db.getExpiredAttestationRequests, so it is a consensus-visible sweep cap.
    // Four services vendor it and none asserted its value here (uuid 6448/3407).
    it('[regression:p0] ATTEST_MAX_EXPIRIES_PER_BLOCK === canonical in every vendored copy', () => {
        assertVendored('ATTEST_MAX_EXPIRIES_PER_BLOCK',
            ['xchain-indexer', 'xchain-explorer', 'xchain-sdk', 'xchain-decoder'])
    })

    // THRESHOLD_SCALE is the fixed BigInt fractional scale both sides of the
    // GATE_MIN_AMOUNT comparison use. The wallet declares its own bare literal
    // and its only guard is a skip-if-absent unit test that compares against
    // the SDK vendored copy, never against canonical, so a wallet-only checkout
    // passes silently. Same failure shape the explorer vm-query note above
    // records, hence the same remedy: assert it centrally (uuid 3408).
    it('[regression:p0] THRESHOLD_SCALE === canonical across vendored copies + wallet gated-send guard', () => {
        assertVendored('THRESHOLD_SCALE',
            ['xchain-indexer', 'xchain-explorer', 'xchain-sdk', 'xchain-decoder'])
        const guardPath = path.join(
            __dirname, '../../../../xchain-wallet/packages/core/src/flows/gatedSendGuard.js')
        assert.ok(fs.existsSync(guardPath),
            'xchain-wallet gatedSendGuard.js is missing; this tripwire needs the full sibling tree')
        // Read the wallet copy from source: it is a module-private const in an
        // ESM package this CommonJS suite cannot require.
        const walletScale = /^const THRESHOLD_SCALE = (\d+);$/m.exec(
            fs.readFileSync(guardPath, 'utf8'))
        assert.ok(walletScale,
            'wallet gatedSendGuard.js no longer declares THRESHOLD_SCALE as a literal const; re-point this guard')
        assert.strictEqual(Number(walletScale[1]), protocol.THRESHOLD_SCALE,
            'wallet gatedSendGuard THRESHOLD_SCALE drifted from the canonical protocol constant; the wallet and the indexer would disagree on the last digit of a threshold neither considers malformed')
    })

    // PRICE_PAIR_TICKER_MAX_LEGACY / _WIDE bound the ticker side of a PRICE v0
    // pair either side of the widening flag day. The indexer is the
    // on-chain arbiter and the hub keeps a verbatim copy of the same module;
    // both declare bare literals and vendor nothing, so neither the full-export
    // guard nor any other test compared them to canonical (uuids 3409, 3410).
    // A one-sided edit forks the fleet on the first round naming a 6-char ticker.
    it('[regression:p0] PRICE_PAIR_TICKER_MAX_LEGACY / _WIDE === canonical across indexer + hub', () => {
        const indexerPricePair = require('../../../../xchain-indexer/src/consensus/gates/price_pair_gate.js')
        const hubPricePair     = require('../../../../xchain-hub/src/consensus/gates/price_pair_gate.js')
        const bounds = ['PRICE_PAIR_TICKER_MAX_LEGACY', 'PRICE_PAIR_TICKER_MAX_WIDE']
        bounds.forEach((name) => {
            assert.strictEqual(indexerPricePair[name], protocol[name],
                'indexer price_pair_activation ' + name + ' drifted from the canonical protocol constant')
            assert.strictEqual(hubPricePair[name], protocol[name],
                'hub price_pair_activation ' + name + ' drifted from the canonical protocol constant (the hub would sign a round the indexer rejects, or refuse one it accepts)')
        })
        // The widened bound must stay above the legacy one, or the flag day
        // narrows the ticker side instead of widening it.
        assert.ok(protocol.PRICE_PAIR_TICKER_MAX_WIDE > protocol.PRICE_PAIR_TICKER_MAX_LEGACY,
            'the widened ticker bound is not wider than the legacy bound')
    })
})
