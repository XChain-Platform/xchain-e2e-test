'use strict'

const assert = require('assert')

const { caseJournalEntry } = require('../../../helpers/rail_preflight/case_journal_entry')

const WHY = 'the bridge capability set is EMPTY'

describe('caseJournalEntry', () => {
    it('carries the blocker on a pending case', () => {
        const entry = caseJournalEntry({ title: 'policy AT2 (edit)', state: 'pending' }, 'policy', WHY)
        assert.deepStrictEqual(entry, {
            suite: 'policy',
            title: 'policy AT2 (edit)',
            state: 'pending',
            durationMs: 0,
            error: null,
            skipReason: WHY,
        })
    })

    it('leaves a passed case without a skip reason under the same blocker', () => {
        const entry = caseJournalEntry({ title: 't', state: 'passed', duration: 5 }, 'policy', WHY)
        assert.strictEqual(entry.skipReason, null)
        assert.strictEqual(entry.durationMs, 5)
    })

    it('leaves a failed case without a skip reason under the same blocker', () => {
        const entry = caseJournalEntry({ title: 't', state: 'failed', err: new Error('boom') }, 'policy', WHY)
        assert.strictEqual(entry.skipReason, null)
        assert.strictEqual(entry.error, 'boom')
    })

    it('leaves a pending case without a skip reason when the blocker is null or empty', () => {
        assert.strictEqual(caseJournalEntry({ title: 't', state: 'pending' }, 'policy', null).skipReason, null)
        assert.strictEqual(caseJournalEntry({ title: 't', state: 'pending' }, 'policy', '').skipReason, null)
        assert.strictEqual(caseJournalEntry({ title: 't', state: 'pending' }, 'policy', undefined).skipReason, null)
    })

    it('cuts a failed case message to 4000 characters', () => {
        const entry = caseJournalEntry({ title: 't', state: 'failed', err: new Error('x'.repeat(5000)) }, 'policy', WHY)
        assert.strictEqual(entry.error.length, 4000)
    })

    it('cuts a long blocker to 4000 characters', () => {
        const entry = caseJournalEntry({ title: 't', state: 'pending' }, 'policy', 'y'.repeat(5000))
        assert.strictEqual(entry.skipReason.length, 4000)
    })

    it('reads an empty test object as unfinished with an empty title and no duration', () => {
        const entry = caseJournalEntry({}, 'policy', null)
        assert.strictEqual(entry.state, 'unfinished')
        assert.strictEqual(entry.title, '')
        assert.strictEqual(entry.durationMs, 0)
        assert.strictEqual(entry.error, null)
        assert.strictEqual(entry.skipReason, null)
    })
})
