const assert = require('assert')
const CryptoNetworks = require('../../../src/CryptoNetworks')

describe('CryptoNetworks', () => {

    describe('getBitcoinJsNetwork', () => {
        const validNetworks = [
            'bitcoin-mainnet', 'bitcoin-testnet', 'bitcoin-regtest',
            'dogecoin-mainnet', 'dogecoin-testnet', 'dogecoin-regtest',
            'litecoin-mainnet', 'litecoin-testnet', 'litecoin-regtest'
        ]

        validNetworks.forEach(name => {
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

            it(`should have dustThreshold 546 for "${name}"`, () => {
                const config = CryptoNetworks.getBitcoinJsNetwork(name)
                assert.strictEqual(config.dustThreshold, 546)
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

        // Verify specific network values
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

        it('should have matching dogecoin testnet and regtest configs', () => {
            const testnet = CryptoNetworks.getBitcoinJsNetwork('dogecoin-testnet')
            const regtest = CryptoNetworks.getBitcoinJsNetwork('dogecoin-regtest')
            assert.strictEqual(testnet.pubKeyHash, regtest.pubKeyHash)
            assert.strictEqual(testnet.scriptHash, regtest.scriptHash)
            assert.strictEqual(testnet.wif, regtest.wif)
        })
    })

    describe('getFirstBlock', () => {
        it('should return 844000 for bitcoin-mainnet', () => {
            assert.strictEqual(CryptoNetworks.getFirstBlock('bitcoin-mainnet'), 844000)
        })

        it('should return 0 for bitcoin-testnet', () => {
            assert.strictEqual(CryptoNetworks.getFirstBlock('bitcoin-testnet'), 0)
        })

        it('should return 0 for bitcoin-regtest', () => {
            assert.strictEqual(CryptoNetworks.getFirstBlock('bitcoin-regtest'), 0)
        })

        it('should return 0 as default for unknown networks', () => {
            assert.strictEqual(CryptoNetworks.getFirstBlock('dogecoin-mainnet'), 0)
            assert.strictEqual(CryptoNetworks.getFirstBlock('unknown'), 0)
        })
    })
})
