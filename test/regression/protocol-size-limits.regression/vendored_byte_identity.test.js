const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { protocol } = require('./support/environment')
const { VENDORED_CONSTANTS_SERVICES, VENDORED_CONSTANT_NAMES, canonicalExportsForService, assertFullVendoredExportIdentity } = require('./support/family_b')

void describe('Vendored protocol-constants full-export identity', () => {

    it('[regression:p0] rejects missing canonical exports, extra vendored exports, and changed values', () => {
        const check = (v, c, pinned) => assertFullVendoredExportIdentity(v, c, 'fixture', pinned)
        check({ A: 1 }, { A: 1, B: 2 }, ['A'])
        assert.throws(() => check({ A: 1 }, { A: 1 }, ['A', 'GONE']),
            /no longer export/)
        assert.throws(() => check({ A: 1 }, { A: 1, B: 2 }, ['A', 'B']),
            /export names drifted/)
        assert.throws(() => check({ A: 1, B: 2 }, { A: 1, B: 2 }, ['A']),
            /export names drifted/)
        assert.throws(() => check({ A: 1, EXTRA: 2 }, { A: 1 }, ['A']),
            /export names drifted/)
        assert.throws(() => check({}, { A: 1 }, ['A']),
            /export names drifted/)
        assert.throws(() => check({ A: 2 }, { A: 1 }, ['A']),
            /values drifted from canonical/)

        const vendoredVm = require('../../../../xchain-vm/src/protocol/constants.js')
        const canonicalVm = canonicalExportsForService('xchain-vm')
        const dropped = VENDORED_CONSTANT_NAMES['xchain-vm'][0]
        const canonicalMissing = Object.assign({}, canonicalVm)
        delete canonicalMissing[dropped]
        assert.throws(
            () => assertFullVendoredExportIdentity(
                vendoredVm, canonicalMissing, 'xchain-vm', VENDORED_CONSTANT_NAMES['xchain-vm']),
            /no longer export/)
    })

    VENDORED_CONSTANTS_SERVICES.forEach((svc) => {
        it('[regression:p0] ' + svc + ' full vendored export set equals canonical', () => {
            const vendoredPath = path.join(
                __dirname, '../../../../', svc, 'src/protocol/constants.js')
            assert.ok(fs.existsSync(vendoredPath),
                svc + ' is missing its vendored src/protocol/constants.js copy')
            const mod = require(vendoredPath)
            assertFullVendoredExportIdentity(
                mod, canonicalExportsForService(svc), svc, VENDORED_CONSTANT_NAMES[svc])
        })
    })
})
