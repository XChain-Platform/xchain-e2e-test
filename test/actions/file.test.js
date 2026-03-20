const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')
const fileHelper = require('../helpers/fileHelper')

describe('FILE', () => {
    describe('v0', () => {
        it('should upload a file v0', async () => {
            let addr = await cryptoHelper.getNewFundedAddress("FILE.V0", COIN, NETWORK, null, "legacy", 0, 1)

            let result = await fileHelper.sendFileV0(
                addr,
                "test.txt",
                "text/plain",
                "E2E Test File",
                "File upload test memo",
                "SGVsbG8gV29ybGQ=" // base64 "Hello World"
            )
            assert(result.file, "File v0 should exist in DB")
        })
    })
})
