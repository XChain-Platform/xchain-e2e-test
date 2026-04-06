const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')

describe('SMOKE: Cryptographic Toolchain', () => {
    it('should generate a valid wallet address', async () => {
        const addressInfo = await cryptoHelper.getNewAddress(
            'SMOKE.CRYPTO', COIN, NETWORK, null, 'legacy', 0
        )

        assert(addressInfo, 'getNewAddress should return an address object')
        assert(addressInfo.address, 'Address should be a non-empty string')
        assert(addressInfo.privateKey, 'Private key should be present')
        assert(addressInfo.publicKey, 'Public key should be present')
        assert(addressInfo.mnemonic, 'Mnemonic should be present')
    })

    it('should derive deterministic addresses from the same mnemonic', async () => {
        const addr0 = await cryptoHelper.getNewAddress(
            'SMOKE.DETERMINISTIC', COIN, NETWORK, null, 'legacy', 0
        )
        const addr1 = await cryptoHelper.getNewAddress(
            'SMOKE.DETERMINISTIC', COIN, NETWORK, null, 'legacy', 1
        )

        assert(addr0.address !== addr1.address, 'Different indexes should produce different addresses')
        assert(addr0.mnemonic === addr1.mnemonic, 'Same wallet label should reuse the same mnemonic')
    })
})
