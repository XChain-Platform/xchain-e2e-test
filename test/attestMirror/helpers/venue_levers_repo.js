'use strict'

// Lever 3 and the barrier family registrars.

const assert = require('assert')
const os     = require('os')
const path   = require('path')
const fs     = require('fs')
const {
    AttestMirrorVenue, resolveRepoRoot, MIRROR_BARRIERS, mirrorBarrierReasons,
    gracedBarrierReason, ungracedMirrorBarrierReasons,
} = require('../../helpers/attestMirrorVenue')

const venueHelperPath = require.resolve('../../helpers/attestMirrorVenue')

// -----------------------------------------------------------------------
// Lever 3: repoRoot (B4)
// -----------------------------------------------------------------------
function registerRepoRootLever () {
    const CHILD = path.join('xchain-e2e-test', 'test', 'helpers', 'attestMirrorVenue.js')

    it('defaults to the checkout this venue file itself lives in', () => {
        const root = resolveRepoRoot(undefined, {})
        // Same FILE, not merely a file of the same name: a shared tree beside this
        // lane holds a file at the identical relative path, and a prefix check would
        // pass against it while the children ran someone else's uncommitted bytes.
        assert.strictEqual(fs.realpathSync(path.join(root, CHILD)), fs.realpathSync(venueHelperPath),
            'the default repoRoot does not contain THIS venue file, so the children would run ' +
            'a different checkout than the leg believes it is testing')
        assert.strictEqual(new AttestMirrorVenue({ label: 'levers' }).repoRoot, root)
    })

    it('takes an env override, and an explicit root beats it', () => {
        const root = resolveRepoRoot(undefined, {})
        assert.strictEqual(resolveRepoRoot(undefined, { XCHAIN_VENUE_REPO_ROOT: root }), root)
        assert.strictEqual(resolveRepoRoot(root, { XCHAIN_VENUE_REPO_ROOT: os.tmpdir() }), root,
            'an ambient env beat an explicit root, so a leg that pins its own tree cannot')
    })

    it('refuses an explicit root with no children in it, instead of timing out on boot', () => {
        assert.throws(() => resolveRepoRoot(os.tmpdir(), {}), /has no xchain-hub\/src\/api\.js/)
        assert.throws(() => resolveRepoRoot(undefined, { XCHAIN_VENUE_REPO_ROOT: os.tmpdir() }),
            /XCHAIN_VENUE_REPO_ROOT/)
    })

    it('ignores an unrelated environment, so UNSET is what it always was', () => {
        assert.strictEqual(resolveRepoRoot(undefined, { XCHAIN_HUB_PATH: os.tmpdir() }),
            resolveRepoRoot(undefined, {}),
            'XCHAIN_HUB_PATH redirected this venue; it is read by multiValidatorHubHelper alone')
    })
}

// -----------------------------------------------------------------------
// The family, and the member the venue's grace pinning cannot see (B12, F15)
// -----------------------------------------------------------------------
function registerBarrierFamily () {
    registerBarrierCounts()
    registerBarrierGraces()
}

function registerBarrierCounts () {
    it('reads TEN reasons from the indexer while the grace table has EIGHT keys', () => {
        assert.strictEqual(mirrorBarrierReasons().length, 10,
            'the mirror barrier family changed size; a leg enumerating it from /status is now ' +
            'asserting the wrong count')
        assert.strictEqual(MIRROR_BARRIERS.length, 8)
    })

    it('names both ungraced members rather than inventing graces to close the gap', () => {
        assert.deepStrictEqual(ungracedMirrorBarrierReasons(), [
            'list_share_sync_barrier',
            'snapshot_sync_barrier',
        ],
            'the set of barriers the venue CANNOT pin a grace for changed; a leg that leaves one ' +
            'of them at its frozen grace parks every block behind it')
        assert.ok(!Object.prototype.hasOwnProperty.call(
            require('../../../../xchain-indexer/src/hub/hub_db_sync.js').HUB_SYNC_WATERMARK_GRACE_S, 'snapshot'),
            'a grace key was added for the snapshot member; the venue must stop treating it as ' +
            'the ungraced one')
    })

}

function registerBarrierGraces () {
    it('derives every graced key\'s reason from the indexer, so a rename is loud', () => {
        for (const key of MIRROR_BARRIERS) {
            const reason = gracedBarrierReason(key)
            assert.ok(mirrorBarrierReasons().includes(reason),
                'grace key ' + key + ' names ' + reason + ', which the indexer does not report')
        }
        assert.strictEqual(gracedBarrierReason('anchorAttest'), 'anchor_attest_barrier',
            'the one member whose reason is not <key>_sync_barrier')
        assert.throws(() => gracedBarrierReason('notABarrier'), /names no barrier reason/)
    })

    it('excludes the two _barrier reasons that are not keyed on the mirror watermark', () => {
        for (const outsider of ['bridge_proof_barrier', 'call_presence_barrier']) {
            assert.ok(!mirrorBarrierReasons().includes(outsider),
                outsider + ' was counted as a mirror barrier; it is not watermark-keyed and a leg ' +
                'would wait for a grace that cannot reach it')
        }
    })
}

module.exports = { registerRepoRootLever, registerBarrierFamily }
