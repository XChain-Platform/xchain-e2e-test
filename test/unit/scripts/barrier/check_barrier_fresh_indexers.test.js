'use strict'

const assert = require('assert')
const { findReusedLabelBoots } = require('../../../../scripts/check-barrier-fresh-indexers')

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

    it('rejects an opt-out whose reason is a single word', function () {
        const source = [
            '// fresh-indexers-ok: shared',
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

describe('check-barrier-fresh-indexers reads code, not text', function () {
    it('does not accept freshIndexers written in a comment inside the call', function () {
        const source = [
            'bootFamilyVenue({',
            "    label: 'bf5', // freshIndexers: true",
            '})',
        ].join('\n')

        assert.deepStrictEqual(findReusedLabelBoots(source), [{ line: 1, label: 'bf5' }])
    })

    it('does not accept freshIndexers written in a string inside the call', function () {
        const source = "bootFamilyVenue({ label: 'bf5', note: 'freshIndexers: true' })"

        assert.deepStrictEqual(findReusedLabelBoots(source), [{ line: 1, label: 'bf5' }])
    })

    it('does not accept a top-level freshIndexers, which the boot helper ignores', function () {
        const source = "bootFamilyVenue({ label: 'bf5', freshIndexers: true })"

        assert.deepStrictEqual(findReusedLabelBoots(source), [{ line: 1, label: 'bf5' }])
    })

    it('still sees a boot that follows a regex literal holding a quote', function () {
        const source = [
            "const apostrophe = /chain's/",
            "drive.bootFamilyVenue({ label: 'bf6' })",
        ].join('\n')

        assert.deepStrictEqual(findReusedLabelBoots(source), [{ line: 2, label: 'bf6' }])
    })

    it('sees a boot written inside a template interpolation', function () {
        const source = "const note = `${bootFamilyVenue({ label: 'bf7' })}`"

        assert.deepStrictEqual(findReusedLabelBoots(source), [{ line: 1, label: 'bf7' }])
    })

    it('ignores a boot that is only commented out', function () {
        const source = "// bootFamilyVenue({ label: 'bf5' })"

        assert.deepStrictEqual(findReusedLabelBoots(source), [])
    })

    it('does not accept an opt-out marker that sits inside a string', function () {
        const source = "bootFamilyVenue({ label: 'bf5', note: '// fresh-indexers-ok: shares the venue' })"

        assert.deepStrictEqual(findReusedLabelBoots(source), [{ line: 1, label: 'bf5' }])
    })

    it('reports a file it cannot parse instead of passing it', function () {
        const findings = findReusedLabelBoots("bootFamilyVenue({ label: 'bf5' ")

        assert.strictEqual(findings.length, 1)
        assert.match(findings[0].error, /^unparseable: /)
    })
})
