'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { findReusedLabelBoots, main } = require('../../../../bin/check-barrier-fresh-indexers')

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

describe('check-barrier-fresh-indexers direct venue boots', function () {
    it('reports member and bare buildFamilyVenue calls without a fresh flag', function () {
        const member = "fixture.buildFamilyVenue({ label: 'bf6mix', venue: { hubCount: 2 } })"
        const bare = "buildFamilyVenue({ label: 'x' })"

        assert.deepStrictEqual(findReusedLabelBoots(member), [{ line: 1, label: 'bf6mix' }])
        assert.deepStrictEqual(findReusedLabelBoots(bare), [{ line: 1, label: 'x' }])
    })

    it('accepts buildFamilyVenue only when the effective nested flag is literal true', function () {
        const fresh = "buildFamilyVenue({ label: 'x', venue: { ...venueOpts, freshIndexers: true } })"
        const hidden = "buildFamilyVenue({ label: 'x', venue: { freshIndexers: true, ...venueOpts } })"
        const opaque = "buildFamilyVenue({ label: 'x', venue: attachedCoinVenueOpts(owner, {}) })"

        assert.deepStrictEqual(findReusedLabelBoots(fresh), [])
        assert.deepStrictEqual(findReusedLabelBoots(hidden), [{ line: 1, label: 'x' }])
        assert.deepStrictEqual(findReusedLabelBoots(opaque), [{ line: 1, label: 'x' }])
    })

    it('finds a direct build nested inside an async callback', function () {
        const source = "withRail(rail, async () => { fixture.buildFamilyVenue({ label: 'nested', venue: {} }) })"

        assert.deepStrictEqual(findReusedLabelBoots(source), [{ line: 1, label: 'nested' }])
    })

    it('accepts a reasoned opt-out above a direct build', function () {
        const source = [
            '// fresh-indexers-ok: shares the owner venue on purpose',
            "fixture.buildFamilyVenue({ label: 'shared' })",
        ].join('\n')

        assert.deepStrictEqual(findReusedLabelBoots(source), [])
    })

    it('checks the constructor flag at the top level for bare and member forms', function () {
        const missing = "new AttestMirrorVenue({ label: 'bare' })"
        const member = "new venueModule.AttestMirrorVenue({ label: 'member' })"
        const nested = "new AttestMirrorVenue({ label: 'nested', venue: { freshIndexers: true } })"
        const fresh = "new AttestMirrorVenue({ label: 'fresh', freshIndexers: true })"

        assert.deepStrictEqual(findReusedLabelBoots(missing), [{ line: 1, label: 'bare' }])
        assert.deepStrictEqual(findReusedLabelBoots(member), [{ line: 1, label: 'member' }])
        assert.deepStrictEqual(findReusedLabelBoots(nested), [{ line: 1, label: 'nested' }])
        assert.deepStrictEqual(findReusedLabelBoots(fresh), [])
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

describe('check-barrier-fresh-indexers exit codes', function () {
    let dir
    let saved

    // Run main() quietly against a temp leg directory and return its exit code.
    function run (argv, target = dir) {
        return main(argv, target)
    }

    function write (name, source) {
        fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
        fs.writeFileSync(path.join(dir, name), source)
    }

    beforeEach(function () {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'barrier-fresh-'))
        saved = { log: console.log, error: console.error }
        console.log = () => {}
        console.error = () => {}
    })

    afterEach(function () {
        console.log = saved.log
        console.error = saved.error
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('fails an empty leg directory instead of reporting it clean', function () {
        assert.strictEqual(run([]), 1)
    })

    it('fails an empty leg directory even under --report', function () {
        assert.strictEqual(run(['--report']), 1)
    })

    it('fails when the only leg file sits in a subdirectory the scan does not read', function () {
        write('nested/a.test.js', "bootFamilyVenue({ label: 'x', venue: { freshIndexers: true } })")
        assert.strictEqual(run([]), 1)
    })

    it('fails a scan directory that does not exist', function () {
        assert.strictEqual(run([], path.join(dir, 'missing')), 1)
    })

    it('passes a leg directory whose boots all use fresh indexers', function () {
        write('a.test.js', "bootFamilyVenue({ label: 'x', venue: { freshIndexers: true } })")
        assert.strictEqual(run([]), 0)
    })

    it('fails a reused-label boot, and --report turns that finding into exit 0', function () {
        write('a.test.js', "bootFamilyVenue({ label: 'x' })")
        assert.strictEqual(run([]), 1)
        assert.strictEqual(run(['--report']), 0)
    })

    it('fails a direct buildFamilyVenue boot without a fresh flag', function () {
        write('a.test.js', "fixture.buildFamilyVenue({ label: 'x' })")
        assert.strictEqual(run([]), 1)
    })
})
