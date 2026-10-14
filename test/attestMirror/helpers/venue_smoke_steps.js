'use strict'

// Step functions for venue_smoke.test.js. Pure extraction: bodies are unchanged.

const assert = require('assert')

const { DEFAULT_HUB_COUNT, DEFAULT_INDEXER_COUNT } = require('../../helpers/attestMirrorVenue')

// The version the mirror consumer demands. Read from the indexer's own copy rather
// than typed here, and now shared with the other legs that assert it, so one bump
// moves every leg at once. The resolution itself lives in the helper.
const { HUB_SCHEMA_VERSION } = require('./hubSchemaVersion')

async function bootVenue (ctx, mocha) {
    try {
        ctx.up = await ctx.venue.start()
    } catch (e) {
        // A boot failure is a real result and must not be swallowed: it means
        // the venue is broken, not absent.
        throw e
    }
    if (!ctx.up) {
        console.log('attest-response mirror venue smoke SKIPPED: ' + ctx.venue.unavailable)
        mocha.skip()
    }
}

function assertHubBody (hub, body) {
    assert.strictEqual(body.table, 'attestation_responses',
        'hub ' + hub.index + ' answered for table ' + body.table)
    assert.strictEqual(Number(body.schema_version), Number(HUB_SCHEMA_VERSION),
        'hub ' + hub.index + ' serves schema_version ' + body.schema_version +
        ' but the mirror consumer demands ' + HUB_SCHEMA_VERSION +
        ', which parks the whole mirror rather than one table')
    assert.ok(Array.isArray(body.rows), 'hub ' + hub.index + ' returned no rows array')
    assert.ok(Number.isFinite(Number(body.watermark)), 'hub ' + hub.index + ' returned no watermark')
}

async function assertHubSnapshots (venue) {
    assert.strictEqual(venue.hubs.length, DEFAULT_HUB_COUNT,
        'expected ' + DEFAULT_HUB_COUNT + ' hubs, got ' + venue.hubs.length)

    const seen = []
    for (const hub of venue.hubs) {
        const body = await venue.hubSnapshot(hub.index)
        assertHubBody(hub, body)
        seen.push(hub.index + ':' + body.count)
    }
    console.log('attest-response mirror venue: five snapshot routes answered at schema_version ' +
        HUB_SCHEMA_VERSION + ' (hub:rows ' + seen.join(' ') + ')')
}

async function assertIndexerMirror (venue, ix) {
    const m = await venue.mirrorConnected(ix.index)
    assert.ok(m.answering,
        'indexer ' + ix.index + ' did not answer /status (HTTP ' + m.httpStatus + ')\n' +
        venue.logTail('indexer' + ix.index))
    assert.ok(m.tablePresent,
        'indexer ' + ix.index + ' has no attestation_responses table in its mirror database ' +
        ix.mirrorDbName + ', so hub_db_sync has nothing to page into')
    assert.ok(m.connected,
        'indexer ' + ix.index + ' has not caught its followed hub up: mirror holds ' + m.mirrorRows +
        ' row(s) against hub ' + m.followsHub + "'s " + m.hubRows + '\n' +
        venue.logTail('indexer' + ix.index))
    console.log('attest-response mirror venue: indexer ' + ix.index + ' follows hub ' + m.followsHub +
        ', stallClass ' + m.stallClass + ', mirror rows ' + m.mirrorRows + '/' + m.hubRows)
}

async function assertIndexers (venue) {
    assert.strictEqual(venue.indexers.length, DEFAULT_INDEXER_COUNT)

    const followed = venue.indexers.map((ix) => ix.followsHub)
    assert.strictEqual(new Set(followed).size, followed.length,
        'both indexers follow hub ' + followed[0] + '; the dissemination leg cannot be driven on this venue')

    for (const ix of venue.indexers) await assertIndexerMirror(venue, ix)
}

module.exports = { bootVenue, assertHubSnapshots, assertIndexers }
