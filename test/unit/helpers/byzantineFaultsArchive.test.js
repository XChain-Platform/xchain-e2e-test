'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// silenceArchiveAttestor is the fault the degraded-archive drive
// (test/federation/anchorDegradedArchive.test.js) is built on, and that drive
// costs a live DOGE regtest venue plus three publish cycles to run. Its three
// mechanical properties (the response really stops, restore() really puts the
// ORIGINAL function back, an absent seam fails loudly instead of silently
// injecting nothing) need no chain and no DB, so they are pinned here where a
// break shows up in milliseconds rather than as a confusing red on the venue.
//
// The "restores the exact reference" case is the one that matters most: a
// restore that reinstated a WRAPPER would leave the follower muted for every
// later cycle, and AT-F4 (recovery) would then read as a publisher bug.

const assert = require('assert')
const { silenceArchiveAttestor } = require('../../helpers/byzantineFaults')

// The seam as StateAnchorPublisher exposes it: one async method on the
// publisher instance, which XChainHub.startCrossChain() hangs off the hub as
// `stateAnchorPublisher`. Nothing else about a hub is touched by the injector.
function stubHub() {
    const calls = []
    const original = async function (envelope) { calls.push(envelope); return 'co-signed' }
    return {
        calls,
        original,
        hub: { stateAnchorPublisher: { _handleArchiveAttestSignReq: original } }
    }
}

describe('silenceArchiveAttestor', function () {

    it('stops the archive-attestation response reaching the original handler', async () => {
        const s = stubHub()
        silenceArchiveAttestor(s.hub)

        const result = await s.hub.stateAnchorPublisher._handleArchiveAttestSignReq({ data: { batch_seq: 7 } })

        assert.strictEqual(s.calls.length, 0, 'the original handler was never invoked')
        assert.strictEqual(result, undefined, 'the stand-in answers nothing, so no XANCARCHPUB_SIGN goes out')
        assert.notStrictEqual(s.hub.stateAnchorPublisher._handleArchiveAttestSignReq, s.original,
            'the instance method really was replaced')
    })

    // The publisher's message switch dispatches as `handler(env).catch(...)`, so a
    // stand-in that returned undefined would throw inside the dispatcher rather than
    // staying quiet - a silenced follower that spews TypeErrors is a different fault
    // from the one AT-F3 names.
    it('answers with a promise, the shape the publisher message switch calls .catch() on', () => {
        const s = stubHub()
        silenceArchiveAttestor(s.hub)
        const answer = s.hub.stateAnchorPublisher._handleArchiveAttestSignReq({ data: {} })
        assert.strictEqual(typeof (answer && answer.catch), 'function', 'the stand-in returns a thenable')
        return answer
    })

    it('restore() reinstates the EXACT original function and co-signing resumes', async () => {
        const s = stubHub()
        const restore = silenceArchiveAttestor(s.hub)
        await s.hub.stateAnchorPublisher._handleArchiveAttestSignReq({ data: { batch_seq: 1 } })

        restore()

        assert.strictEqual(s.hub.stateAnchorPublisher._handleArchiveAttestSignReq, s.original,
            'the original function reference is back, not a wrapper around it')
        const result = await s.hub.stateAnchorPublisher._handleArchiveAttestSignReq({ data: { batch_seq: 2 } })
        assert.strictEqual(result, 'co-signed', 'the restored handler answers again')
        assert.deepStrictEqual(s.calls.map(c => c.data.batch_seq), [2],
            'only the post-restore request reached the handler')
    })

    it('leaves every other handler on the publisher alone', async () => {
        const s = stubHub()
        const bundleCalls = []
        // The bundle leg's twin. AT-F3 hinges on it still answering while the
        // archive leg is mute, so a broad injector would invalidate the drive.
        s.hub.stateAnchorPublisher._handleAttestSignReq = async (e) => { bundleCalls.push(e); return 'bundle-co-signed' }

        silenceArchiveAttestor(s.hub)

        const r = await s.hub.stateAnchorPublisher._handleAttestSignReq({ data: {} })
        assert.strictEqual(r, 'bundle-co-signed', 'the v0 bundle attestation handler is untouched')
        assert.strictEqual(bundleCalls.length, 1)
    })

    it('throws when the seam is absent rather than injecting nothing', () => {
        assert.throws(() => silenceArchiveAttestor({}),
            /no started StateAnchorPublisher/,
            'a hub whose consensus was never started fails loudly')
        assert.throws(() => silenceArchiveAttestor({ stateAnchorPublisher: {} }),
            /no started StateAnchorPublisher/,
            'a publisher without the archive-attestation handler fails loudly')
        assert.throws(() => silenceArchiveAttestor(null),
            /no started StateAnchorPublisher/,
            'a missing hub fails loudly')
    })
})
