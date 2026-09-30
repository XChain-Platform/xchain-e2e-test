'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const {
    WATCH_INPUT_TITLE,
    watchInputFrom,
    watchVerdict,
} = require('../../../../scripts/rail_leg/rail_watch_verdict')

const SCRIPT = path.resolve(__dirname, '..', '..', '..', '..', 'scripts', 'rail_leg', 'rail_watch_verdict.js')

function input (delta) {
    return {
        tick: 'XCHAIN',
        chain: 'DOGE',
        reports: [{ label: 'venue-hub-0', ok: true,
            byTick: { XCHAIN: { DOGE: { escrow: '36', supply: '35', in_flight: '0', delta: String(delta) } } } }],
    }
}

// A stand-in for the platform classifier with the same reports-in, items-out contract.
const watch = {
    bridgeInvariantVerdicts (reports) {
        const items = []
        for (const r of reports) {
            for (const [tick, byChain] of Object.entries(r.byTick)) {
                for (const [chain, entry] of Object.entries(byChain)) {
                    const delta = Number(entry.delta)
                    if (delta > 0) items.push({ sev: 'warn', kind: 'BRIDGE_INVARIANT_SURPLUS', tick, chain })
                    if (delta < 0) items.push({ sev: 'crit', kind: 'BRIDGE_INVARIANT_DEFICIT', tick, chain })
                }
            }
        }
        return items
    },
}

function journal (...entries) {
    return entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
}

describe('rail watch verdict (AT6 D65 classifier half)', function () {
    it('reads the last recorded watch input and skips other lines', function () {
        const text = journal(
            { title: 'some case', state: 'passed' },
            { title: WATCH_INPUT_TITLE, state: 'evidence', evidence: input(5) },
            { title: WATCH_INPUT_TITLE, state: 'evidence', evidence: input(1) },
        ) + 'not json\n'
        assert.strictEqual(watchInputFrom(text).reports[0].byTick.XCHAIN.DOGE.delta, '1')
        assert.strictEqual(watchInputFrom(journal({ title: 'x', state: 'passed' })), null)
    })

    it('passes a surplus the classifier raises as warn BRIDGE_INVARIANT_SURPLUS', function () {
        assert.deepStrictEqual(watchVerdict(input(1), watch),
            { pass: true, reason: '', seen: 'warn/BRIDGE_INVARIANT_SURPLUS' })
    })

    it('fails a deficit, and an answer the classifier does not flag', function () {
        assert.match(watchVerdict(input(-1), watch).reason, /crit\/BRIDGE_INVARIANT_DEFICIT where D65 requires warn/)
        assert.match(watchVerdict(input(0), watch).reason, /expected one watch item for XCHAIN on DOGE, got none/)
    })

    it('exits 0 on PASS, 1 on FAIL and 2 without an input, from the command line', function () {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rail-watch-verdict-'))
        const stub = path.join(dir, 'watch.js')
        fs.writeFileSync(stub, 'module.exports = ' + JSON.stringify({}) + ';\nmodule.exports.bridgeInvariantVerdicts = ' +
            watch.bridgeInvariantVerdicts.toString().replace(/^bridgeInvariantVerdicts/, 'function') + '\n')
        const run = (entries) => {
            const file = path.join(dir, 'case-journal.jsonl')
            fs.writeFileSync(file, journal(...entries))
            return spawnSync(process.execPath, [SCRIPT, '--journal', file, '--watch', stub], { encoding: 'utf8' })
        }
        try {
            const pass = run([{ title: WATCH_INPUT_TITLE, state: 'evidence', evidence: input(1) }])
            assert.strictEqual(pass.status, 0, pass.stdout)
            assert.match(pass.stdout, /^CASE at6-d65-watch: PASS warn\/BRIDGE_INVARIANT_SURPLUS/)
            const fail = run([{ title: WATCH_INPUT_TITLE, state: 'evidence', evidence: input(-1) }])
            assert.strictEqual(fail.status, 1, fail.stdout)
            const absent = run([{ title: 'other', state: 'passed' }])
            assert.strictEqual(absent.status, 2, absent.stdout)
            assert.match(absent.stdout, /ERROR no "=== AT6 watch input ===" line/)
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })
})
