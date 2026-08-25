// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const CryptoNetworks = require('../../../src/CryptoNetworks')

describe('CryptoNetworks', () => {

    describe('getBitcoinJsNetwork', () => {
        // Per-chain dust floors: Bitcoin 546 sats; Litecoin 5460 litoshis
        // (10× Bitcoin's dust relay fee); Dogecoin 100000 koinu (Dogecoin Core
        // hard dust limit DEFAULT_HARD_DUST_LIMIT = COIN/100/10).
        const validNetworks = {
            'bitcoin-mainnet': 546, 'bitcoin-testnet': 546, 'bitcoin-regtest': 546,
            'dogecoin-mainnet': 100000, 'dogecoin-testnet': 100000, 'dogecoin-regtest': 100000,
            'litecoin-mainnet': 5460, 'litecoin-testnet': 5460, 'litecoin-regtest': 5460
        }

        Object.entries(validNetworks).forEach(([name, expectedDust]) => {
            it(`should return a valid config for "${name}"`, () => {
                const config = CryptoNetworks.getBitcoinJsNetwork(name)
                assert(config, `Expected config for ${name}`)
                assert.strictEqual(typeof config.pubKeyHash, 'number')
                assert.strictEqual(typeof config.scriptHash, 'number')
                assert.strictEqual(typeof config.wif, 'number')
                assert(config.bip32, `Expected bip32 for ${name}`)
                assert.strictEqual(typeof config.bip32.public, 'number')
                assert.strictEqual(typeof config.bip32.private, 'number')
            })

            it(`should have dustThreshold ${expectedDust} for "${name}"`, () => {
                const config = CryptoNetworks.getBitcoinJsNetwork(name)
                assert.strictEqual(config.dustThreshold, expectedDust)
            })
        })

        it('should return undefined for unknown network', () => {
            assert.strictEqual(CryptoNetworks.getBitcoinJsNetwork('ethereum-mainnet'), undefined)
        })

        it('should return undefined for empty string', () => {
            assert.strictEqual(CryptoNetworks.getBitcoinJsNetwork(''), undefined)
        })

        it('should return undefined for null', () => {
            assert.strictEqual(CryptoNetworks.getBitcoinJsNetwork(null), undefined)
        })

        it('should return correct pubKeyHash for bitcoin-mainnet', () => {
            const config = CryptoNetworks.getBitcoinJsNetwork('bitcoin-mainnet')
            assert.strictEqual(config.pubKeyHash, 0x00)
        })

        it('should return correct pubKeyHash for dogecoin-mainnet (0x1e)', () => {
            const config = CryptoNetworks.getBitcoinJsNetwork('dogecoin-mainnet')
            assert.strictEqual(config.pubKeyHash, 0x1e)
        })

        it('should return correct pubKeyHash for litecoin-mainnet (0x30)', () => {
            const config = CryptoNetworks.getBitcoinJsNetwork('litecoin-mainnet')
            assert.strictEqual(config.pubKeyHash, 0x30)
        })

        it('should include bech32 for litecoin networks', () => {
            assert.strictEqual(CryptoNetworks.getBitcoinJsNetwork('litecoin-mainnet').bech32, 'ltc')
            assert.strictEqual(CryptoNetworks.getBitcoinJsNetwork('litecoin-testnet').bech32, 'tltc')
            assert.strictEqual(CryptoNetworks.getBitcoinJsNetwork('litecoin-regtest').bech32, 'rltc')
        })

        it('should return canonical dogecoin testnet and regtest configs', () => {
            // DOGE testnet and regtest share the P2SH version (0xc4) but use distinct
            // pubKeyHash/wif prefixes: testnet 0x71/0xf1, regtest the bitcoin-regtest
            // 0x6f/0xef. These values are byte-identical across every service repo
            // (guarded by the cross-repo parity test below); they are NOT interchangeable.
            const testnet = CryptoNetworks.getBitcoinJsNetwork('dogecoin-testnet')
            const regtest = CryptoNetworks.getBitcoinJsNetwork('dogecoin-regtest')
            assert.strictEqual(testnet.pubKeyHash, 0x71)
            assert.strictEqual(testnet.scriptHash, 0xc4)
            assert.strictEqual(testnet.wif, 0xf1)
            assert.strictEqual(regtest.pubKeyHash, 0x6f)
            assert.strictEqual(regtest.scriptHash, 0xc4)
            assert.strictEqual(regtest.wif, 0xef)
        })
    })

    describe('getFirstBlock', () => {
        it('should return the canonical mainnet start heights', () => {
            assert.strictEqual(CryptoNetworks.getFirstBlock('bitcoin-mainnet'), 950000)
            assert.strictEqual(CryptoNetworks.getFirstBlock('litecoin-mainnet'), 3120000)
            assert.strictEqual(CryptoNetworks.getFirstBlock('dogecoin-mainnet'), 6240000)
        })

        it('should return the canonical testnet start heights', () => {
            // Repinned 2026-08-24 by the pre-announcement testnet re-genesis:
            // each testnet chain again starts just under its live tip, so the
            // public testnet carries no pre-announcement test actions. Moved in
            // the same wave as the vendored registry this time.
            assert.strictEqual(CryptoNetworks.getFirstBlock('bitcoin-testnet'), 149700)
            assert.strictEqual(CryptoNetworks.getFirstBlock('litecoin-testnet'), 4862500)
            assert.strictEqual(CryptoNetworks.getFirstBlock('dogecoin-testnet'), 67847500)
        })

        it('should return 0 for regtest networks', () => {
            assert.strictEqual(CryptoNetworks.getFirstBlock('bitcoin-regtest'), 0)
            assert.strictEqual(CryptoNetworks.getFirstBlock('litecoin-regtest'), 0)
            assert.strictEqual(CryptoNetworks.getFirstBlock('dogecoin-regtest'), 0)
        })

        it('should return 0 as default for unknown networks', () => {
            assert.strictEqual(CryptoNetworks.getFirstBlock('ethereum-mainnet'), 0)
            assert.strictEqual(CryptoNetworks.getFirstBlock('unknown'), 0)
        })
    })

    // Cross-repo drift guard. CryptoNetworks.getBitcoinJsNetwork is hand-copied into
    // several services; the per-network params it returns (address prefixes, dust
    // thresholds, relay-policy flags) MUST be identical across every copy or encode and
    // decode disagree. This compares each sibling copy's output to this one for every
    // network, AND anchors this local copy against the canonical coins registry
    // (xchain-encoder/src/coins) so two legacy copies drifting the same way from
    // canonical can no longer mutually agree and slip through. getFirstBlock is
    // compared too, against both the sibling copies and the canonical registry's
    // firstBlock field, for the siblings that vendor it (encoder/decoder; utxo-tracker
    // and regtest-miner never needed indexing start heights). Any sibling repo not
    // checked out is skipped.
    describe('cross-repo getBitcoinJsNetwork parity', () => {
        const path = require('path'), fs = require('fs')
        const SIBLINGS = ['xchain-encoder', 'xchain-decoder', 'xchain-utxo-tracker', 'xchain-regtest-miner']
        const FIRST_BLOCK_SIBLINGS = ['xchain-encoder', 'xchain-decoder']
        const NETS = ['bitcoin-mainnet', 'bitcoin-testnet', 'bitcoin-regtest',
                      'dogecoin-mainnet', 'dogecoin-testnet', 'dogecoin-regtest',
                      'litecoin-mainnet', 'litecoin-testnet', 'litecoin-regtest']
        // net key -> canonical (tick, network) pair, per xchain-encoder/src/coins/index.js
        const NET_MAP = {
            'bitcoin-mainnet':  { tick: 'BTC',  network: 'mainnet' },
            'bitcoin-testnet':  { tick: 'BTC',  network: 'testnet' },
            'bitcoin-regtest':  { tick: 'BTC',  network: 'regtest' },
            'dogecoin-mainnet': { tick: 'DOGE', network: 'mainnet' },
            'dogecoin-testnet': { tick: 'DOGE', network: 'testnet' },
            'dogecoin-regtest': { tick: 'DOGE', network: 'regtest' },
            'litecoin-mainnet': { tick: 'LTC',  network: 'mainnet' },
            'litecoin-testnet': { tick: 'LTC',  network: 'testnet' },
            'litecoin-regtest': { tick: 'LTC',  network: 'regtest' },
        }

        SIBLINGS.forEach((repo) => {
            it(`${repo} getBitcoinJsNetwork matches this copy for every network`, function () {
                const p = path.resolve(__dirname, '../../../../' + repo + '/src/CryptoNetworks.js')
                if (!fs.existsSync(p)) return this.skip()
                const Sib = require(p)
                for (const net of NETS) {
                    assert.deepStrictEqual(
                        Sib.getBitcoinJsNetwork(net), CryptoNetworks.getBitcoinJsNetwork(net),
                        `${repo} CryptoNetworks.getBitcoinJsNetwork('${net}') has drifted; keep the per-network params identical across every copy`)
                }
            })
        })

        FIRST_BLOCK_SIBLINGS.forEach((repo) => {
            it(`${repo} getFirstBlock matches this copy for every network`, function () {
                const p = path.resolve(__dirname, '../../../../' + repo + '/src/CryptoNetworks.js')
                if (!fs.existsSync(p)) return this.skip()
                const Sib = require(p)
                for (const net of NETS) {
                    assert.strictEqual(
                        Sib.getFirstBlock(net), CryptoNetworks.getFirstBlock(net),
                        `${repo} CryptoNetworks.getFirstBlock('${net}') has drifted from this copy's start height`)
                }
            })
        })

        // Unknown-network error-path contract guard. The parity checks above iterate
        // only the 9 valid keys, so the unknown/empty/null path was never asserted even
        // though the copies DISAGREE on it: the legacy switch here and
        // xchain-regtest-miner return `undefined` (falsy, so consumers using the
        // `getBitcoinJsNetwork(x) || fallback` idiom keep working), while
        // xchain-encoder, xchain-decoder and now xchain-utxo-tracker
        // `throw new TypeError`. Standardizing that contract fleet-wide is an open
        // operator decision (touches encoder/decoder production code); until it is
        // made, lock each copy's CURRENT contract so any future drift on the error
        // path is caught instead of slipping through. `undefined` copies are also
        // asserted not to throw.
        //
        // utxo-tracker moved undefined -> throws on 2026-08-25, deliberately: bitcoinjs-lib
        // reads an undefined network as BTC MAINNET, so the falsy-fallback idiom turns a
        // typo'd network into real mainnet parameters. This guard caught that change,
        // which is what it is for; the row records the new contract rather than reverting it.
        const UNKNOWN_INPUTS = ['ethereum-mainnet', '', null]
        // repo -> current unknown-network contract: 'undefined' or 'throws'.
        const UNKNOWN_CONTRACT = {
            'xchain-utxo-tracker': 'throws',
            'xchain-regtest-miner': 'undefined',
            'xchain-encoder': 'throws',
            'xchain-decoder': 'throws',
        }

        it('this (legacy) copy returns undefined for unknown/empty/null network', function () {
            for (const bad of UNKNOWN_INPUTS) {
                assert.strictEqual(CryptoNetworks.getBitcoinJsNetwork(bad), undefined,
                    `legacy getBitcoinJsNetwork(${JSON.stringify(bad)}) must stay undefined`)
            }
        })

        Object.entries(UNKNOWN_CONTRACT).forEach(([repo, contract]) => {
            it(`${repo} getBitcoinJsNetwork honors its unknown-network contract (${contract})`, function () {
                const p = path.resolve(__dirname, '../../../../' + repo + '/src/CryptoNetworks.js')
                if (!fs.existsSync(p)) return this.skip()
                const Sib = require(p)
                for (const bad of UNKNOWN_INPUTS) {
                    if (contract === 'undefined') {
                        assert.strictEqual(Sib.getBitcoinJsNetwork(bad), undefined,
                            `${repo} getBitcoinJsNetwork(${JSON.stringify(bad)}) drifted; expected undefined (falsy-fallback contract)`)
                    } else {
                        assert.throws(() => Sib.getBitcoinJsNetwork(bad), TypeError,
                            `${repo} getBitcoinJsNetwork(${JSON.stringify(bad)}) drifted; expected a thrown TypeError`)
                    }
                }
            })
        })

        it('getBitcoinJsNetwork and getFirstBlock match the canonical coins registry for every network', function () {
            const p = path.resolve(__dirname, '../../../../xchain-encoder/src/coins/index.js')
            if (!fs.existsSync(p)) return this.skip()
            const canonical = require(p)
            for (const net of NETS) {
                const { tick, network } = NET_MAP[net]
                const config = canonical.getCoinConfig(tick, network)
                assert.deepStrictEqual(
                    CryptoNetworks.getBitcoinJsNetwork(net), config.net,
                    `CryptoNetworks.getBitcoinJsNetwork('${net}') has drifted from the canonical coins registry`)
                assert.strictEqual(
                    CryptoNetworks.getFirstBlock(net), config.firstBlock,
                    `CryptoNetworks.getFirstBlock('${net}') has drifted from the canonical coins registry`)
            }
        })
    })
})
