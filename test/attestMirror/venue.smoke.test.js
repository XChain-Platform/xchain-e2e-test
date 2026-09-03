'use strict'

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * VENUE SMOKE: does the attest-response mirror venue actually stand up?
 *
 * Not an acceptance test and deliberately not shaped like one. It asks the two
 * questions everything else on this venue rests on and nothing else:
 *
 *   1. Do all five hubs really SERVE `/hub-db/snapshot/attestation_responses`,
 *      at the schema version the mirror consumer demands? This is the half no
 *      existing harness provides: `MultiValidatorHub` starts hubs with P2P only
 *      and no API process, so a route that answers here is the venue's whole
 *      reason to exist. The schema version is checked rather than merely the
 *      200, because the consumer's gate is a strict `!==` that parks the WHOLE
 *      mirror on a mismatch, so a hub one version behind serves a route that
 *      answers and a mirror that never moves.
 *
 *   2. Are both indexers up with the mirror wired to two DIFFERENT hubs?
 *
 * STANDALONE. It boots and tears down its own venue, shares no fixture with any
 * other suite, and holds no expectation about chain state: it never stakes,
 * never makes a request, and asserts nothing about rows, because a venue with no
 * request in flight legitimately carries zero. `count === 0` here is a pass.
 *
 * It runs on the regtest stack only and SKIPS, loudly, when the stack it borrows
 * from is not reachable. A venue that never booted proves nothing either way,
 * and reporting that as a failure would train the reader to ignore it.
 ********************************************************************/

const assert = require('assert')
const dotenv = require('dotenv')
dotenv.config()

const { AttestMirrorVenue, DEFAULT_HUB_COUNT, DEFAULT_INDEXER_COUNT } = require('../helpers/attestMirrorVenue')

// The version the mirror consumer demands. Read from the indexer's own copy
// rather than typed here: the number moves with the schema, and a literal would
// have to be remembered at every bump while the code that matters would not.
const HUB_SCHEMA_VERSION = require('../../../xchain-indexer/src/hub-schema-version.js').HUB_SCHEMA_VERSION

describe('attest-response mirror venue: it stands up', function () {
    // Five hub processes and two indexers, each bootstrapping a schema on an
    // empty database, plus a disposable MariaDB container if none is provisioned.
    this.timeout(20 * 60 * 1000)

    let venue = null
    let up    = false

    before(async function () {
        venue = new AttestMirrorVenue({ label: 'smoke' })
        try {
            up = await venue.start()
        } catch (e) {
            // A boot failure is a real result and must not be swallowed: it means
            // the venue is broken, not absent.
            throw e
        }
        if (!up) {
            console.log('attest-response mirror venue smoke SKIPPED: ' + venue.unavailable)
            this.skip()
        }
    })

    after(async function () {
        if (venue) await venue.stop()
    })

    it('serves the attestation_responses snapshot route on all five hubs at the mirror schema version', async function () {
        assert.strictEqual(venue.hubs.length, DEFAULT_HUB_COUNT,
            'expected ' + DEFAULT_HUB_COUNT + ' hubs, got ' + venue.hubs.length)

        const seen = []
        for (const hub of venue.hubs) {
            const body = await venue.hubSnapshot(hub.index)
            assert.strictEqual(body.table, 'attestation_responses',
                'hub ' + hub.index + ' answered for table ' + body.table)
            assert.strictEqual(Number(body.schema_version), Number(HUB_SCHEMA_VERSION),
                'hub ' + hub.index + ' serves schema_version ' + body.schema_version +
                ' but the mirror consumer demands ' + HUB_SCHEMA_VERSION +
                ', which parks the whole mirror rather than one table')
            assert.ok(Array.isArray(body.rows), 'hub ' + hub.index + ' returned no rows array')
            assert.ok(Number.isFinite(Number(body.watermark)), 'hub ' + hub.index + ' returned no watermark')
            seen.push(hub.index + ':' + body.count)
        }
        console.log('attest-response mirror venue: five snapshot routes answered at schema_version ' +
            HUB_SCHEMA_VERSION + ' (hub:rows ' + seen.join(' ') + ')')
    })

    it('runs two indexers on the mirror, each following a different hub', async function () {
        assert.strictEqual(venue.indexers.length, DEFAULT_INDEXER_COUNT)

        const followed = venue.indexers.map((ix) => ix.followsHub)
        assert.strictEqual(new Set(followed).size, followed.length,
            'both indexers follow hub ' + followed[0] + '; the dissemination leg cannot be driven on this venue')

        for (const ix of venue.indexers) {
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
    })
})
