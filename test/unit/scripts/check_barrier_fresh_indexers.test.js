'use strict'

const assert = require('assert')
const { findReusedLabelBoots } = require('../../../scripts/check-barrier-fresh-indexers')

describe('check-barrier-fresh-indexers', function () {
    it('finds a one-line boot and reports its literal label and line', function () {
        const source = [
            "const first = 'unrelated'",
            "bootFamilyVenue({ label: 'bf5' })",
        ].join('\n')

        assert.deepStrictEqual(findReusedLabelBoots(source), [{ line: 2, label: 'bf5' }])
    })

    it('accepts a multi-line boot with fresh indexers', function () {
        const source = [
            'bootFamilyVenue({',
            "    label: 'bf5',",
            '    venue: { freshIndexers: true },',
            '})',
        ].join('\n')

        assert.deepStrictEqual(findReusedLabelBoots(source), [])
    })

    it('accepts a stated opt-out directly above the call', function () {
        const source = [
            '// fresh-indexers-ok: shares the live venue on purpose',
            "bootFamilyVenue({ label: 'bf5' })",
        ].join('\n')

        assert.deepStrictEqual(findReusedLabelBoots(source), [])
    })

    it('rejects an opt-out with no reason', function () {
        const source = [
            '// fresh-indexers-ok:',
            "bootFamilyVenue({ label: 'bf5' })",
        ].join('\n')

        assert.deepStrictEqual(findReusedLabelBoots(source), [{ line: 2, label: 'bf5' }])
    })
})

describe('check-barrier-fresh-indexers labels', function () {
    it('reports each boot with its own line', function () {
        const source = [
            "bootFamilyVenue({ label: 'bf1' })",
            'const between = true',
            'bootFamilyVenue({ label: "bf2" })',
        ].join('\n')

        assert.deepStrictEqual(findReusedLabelBoots(source), [
            { line: 1, label: 'bf1' },
            { line: 3, label: 'bf2' },
        ])
    })

    it('reports null for a variable label', function () {
        const source = 'bootFamilyVenue({ label: venueLabel })'

        assert.deepStrictEqual(findReusedLabelBoots(source), [{ line: 1, label: null }])
    })

    it('does not treat freshIndexers false as fresh', function () {
        const source = "bootFamilyVenue({ label: 'bf5', freshIndexers: false })"

        assert.deepStrictEqual(findReusedLabelBoots(source), [{ line: 1, label: 'bf5' }])
    })
})
