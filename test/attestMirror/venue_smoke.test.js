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

const dotenv = require('dotenv')
dotenv.config()

const { AttestMirrorVenue } = require('../helpers/attestMirrorVenue')
const { bootVenue, assertHubSnapshots, assertIndexers } = require('./helpers/venue_smoke_steps')

describe('attest-response mirror venue: it stands up', function () {
    // Five hub processes and two indexers, each bootstrapping a schema on an
    // empty database, plus a disposable MariaDB container if none is provisioned.
    this.timeout(20 * 60 * 1000)

    const ctx = { venue: null, up: false }

    before(async function () {
        ctx.venue = new AttestMirrorVenue({ label: 'smoke' })
        await bootVenue(ctx, this)
    })

    after(async function () {
        if (ctx.venue) await ctx.venue.stop()
    })

    it('serves the attestation_responses snapshot route on all five hubs at the mirror schema version', function () {
        return assertHubSnapshots(ctx.venue)
    })

    it('runs two indexers on the mirror, each following a different hub', function () {
        return assertIndexers(ctx.venue)
    })
})
