'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { evidenceJson } = require('../../../helpers/rail_preflight/evidence_json')
const { journalCase } = require('../../../helpers/bridgeRailVenue')

describe('drive evidence JSON', function () {
    it('writes a BigInt as its decimal string and leaves other values alone', function () {
        const text = evidenceJson({ btcTip: 45123n, amount: 10n ** 20n, tick: 'FUFU', n: 3 }, 2)
        assert.deepStrictEqual(JSON.parse(text),
            { btcTip: '45123', amount: '100000000000000000000', tick: 'FUFU', n: 3 })
    })

    it('journals an evidence entry that holds a BigInt instead of dropping it', function () {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-json-'))
        const saved = process.env.BRIDGE_RAIL_JOURNAL_DIR
        process.env.BRIDGE_RAIL_JOURNAL_DIR = dir
        try {
            assert.strictEqual(journalCase({ suite: 's', title: '=== readouts ===', state: 'evidence',
                evidence: { endTip: 7n } }), true)
            const line = fs.readFileSync(path.join(dir, 'case-journal.jsonl'), 'utf8').trim()
            assert.strictEqual(JSON.parse(line).evidence.endTip, '7')
        } finally {
            if (saved === undefined) delete process.env.BRIDGE_RAIL_JOURNAL_DIR
            else process.env.BRIDGE_RAIL_JOURNAL_DIR = saved
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })
})
