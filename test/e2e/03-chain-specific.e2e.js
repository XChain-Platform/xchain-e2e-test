const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')
const issueHelper = require('../helpers/issueHelper')

// Chain-specific block-format coverage.
//
// The decoder's block-parsing loop must walk every transaction in a block and
// extract XChain ACTIONs regardless of chain-specific block/transaction shapes
// that Bitcoin does not have:
//
//   - Litecoin: post-MWEB blocks end with a "HogEx" (hogaddr) integration
//     transaction that pegs value in/out of the MWEB extension block. The
//     decoder must iterate past it without mis-parsing it as an XChain tx and
//     without aborting the block.
//
//   - Dogecoin: blocks carry an AuxPoW (merged-mining) header appended after
//     the standard 80-byte header. The decoder must parse the block body
//     correctly despite the extra AuxPoW commitment data.
//
// These properties can only be exercised against a live node of the matching
// chain — a Bitcoin regtest node produces neither HogEx outputs nor AuxPoW
// headers. Each case is therefore gated to its chain and skips elsewhere. To
// run them, provision the matching regtest stack (e.g. `xchain-node install
// regtest` for litecoin / dogecoin) and point COIN/NETWORK at it.
//
// The round-trip itself is a plain OP_RETURN ISSUE: a valid ISSUE + Credit row
// proves the decoder read the chain-specific block, found the XChain tx, and
// decoded its ACTION bytes intact. If HogEx/AuxPoW handling were broken the
// block would fail to parse and no row would ever appear.
describe('E2E: Chain-Specific Block Parsing', () => {
    describe('E2E-CHAIN-001: Litecoin HogEx (MWEB) block parsing', () => {
        before(function(){
            if (COIN !== 'litecoin'){
                console.log('Skipping Litecoin HogEx case: COIN is ' + COIN + ', not litecoin')
                this.skip()
            }
        })

        it('should decode and index an XChain ISSUE from a Litecoin block that may contain a HogEx tx', async () => {
            const addr = await cryptoHelper.getNewFundedAddress('E2E.CHAIN.LTC.HOGEX', COIN, NETWORK, null, 'legacy', 0, 1)
            assert(addr.address, 'Funded address should be truthy')

            const tick = 'E2ELTC' + addr.address.substring(addr.address.length - 6)
            const result = await issueHelper.sendIssueV0(
                addr, tick, 100, 10, 0, 'ltc hogex block parse', 10
            )

            assert(result.txHash, 'ISSUE pipeline should return a txHash on litecoin')
            assert.strictEqual(result.txHash.length, 64, 'txHash should be a 64-char hex string')
            assert(result.issue, 'ISSUE DB record should exist (decoder parsed the HogEx-bearing block)')
            assert.strictEqual(result.issue.tick, tick, 'ISSUE tick should match')
            assert.strictEqual(result.issue.status, 'valid', 'ISSUE status should be valid')
            assert(result.credit, 'Credit DB record should exist after the litecoin pipeline')
            assert.strictEqual(result.credit.tx_hash, result.txHash, 'Credit tx_hash should match ISSUE tx_hash')
        })
    })

    describe('E2E-CHAIN-002: Dogecoin AuxPoW block parsing', () => {
        before(function(){
            if (COIN !== 'dogecoin'){
                console.log('Skipping Dogecoin AuxPoW case: COIN is ' + COIN + ', not dogecoin')
                this.skip()
            }
        })

        it('should decode and index an XChain ISSUE from a Dogecoin AuxPoW block', async () => {
            const addr = await cryptoHelper.getNewFundedAddress('E2E.CHAIN.DOGE.AUXPOW', COIN, NETWORK, null, 'legacy', 0, 1)
            assert(addr.address, 'Funded address should be truthy')

            const tick = 'E2EDGE' + addr.address.substring(addr.address.length - 6)
            const result = await issueHelper.sendIssueV0(
                addr, tick, 100, 10, 0, 'doge auxpow block parse', 10
            )

            assert(result.txHash, 'ISSUE pipeline should return a txHash on dogecoin')
            assert.strictEqual(result.txHash.length, 64, 'txHash should be a 64-char hex string')
            assert(result.issue, 'ISSUE DB record should exist (decoder parsed the AuxPoW block)')
            assert.strictEqual(result.issue.tick, tick, 'ISSUE tick should match')
            assert.strictEqual(result.issue.status, 'valid', 'ISSUE status should be valid')
            assert(result.credit, 'Credit DB record should exist after the dogecoin pipeline')
            assert.strictEqual(result.credit.tx_hash, result.txHash, 'Credit tx_hash should match ISSUE tx_hash')
        })
    })
})
