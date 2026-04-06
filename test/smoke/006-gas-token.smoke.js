const assert = require('assert')

describe('SMOKE: GAS Token', () => {
    it('should have the XCHAIN GAS token in the indexer database', async () => {
        const gasToken = await indexerDatabase.checkIssue({ tick: 'XCHAIN', status: 'valid' })
        assert(gasToken, 'GAS token (XCHAIN) should exist with status valid — bootstrap should have created it')
    })
})
