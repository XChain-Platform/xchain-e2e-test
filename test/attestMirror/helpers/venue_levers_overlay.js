'use strict'

// Lever 1 registrar: the per-index env overlay.

const assert = require('assert')
const {
    AttestMirrorVenue, buildIndexerEnv, indexerEnvOverlay,
} = require('../../helpers/attestMirrorVenue')
const { ARM, indexerSpec } = require('./venue_levers_fixture')

// -----------------------------------------------------------------------
// Lever 1: the per-index env overlay (F28)
// -----------------------------------------------------------------------
function registerIndexOverlayLever () {
    registerOverlayScope()
    registerOverlayShape()
}

function registerOverlayScope () {
    it('arms indexer 0 and leaves indexer 1 inert, which is the whole point of it', () => {
        const perIndex = { 0: { [ARM]: '0' } }
        const armed = buildIndexerEnv(indexerSpec({ extraEnv: indexerEnvOverlay(perIndex, 0) }))
        const inert = buildIndexerEnv(indexerSpec({ extraEnv: indexerEnvOverlay(perIndex, 1) }))

        assert.strictEqual(armed[ARM], '0',
            'the overlay did not reach indexer 0, so nothing can arm one node of a two-node venue')
        assert.ok(!(ARM in inert),
            'the overlay reached indexer 1 as well, so the two nodes would run the SAME rule and ' +
            'a flag-day leg would compare a node against itself')

        // Every OTHER key identical: an overlay that also perturbed the mirror
        // database or the hub url would make the two nodes differ for a second
        // reason and the leg could not attribute the divergence to the rule.
        const strippedArmed = Object.assign({}, armed)
        delete strippedArmed[ARM]
        assert.deepStrictEqual(strippedArmed, inert,
            'the overlay changed more than the key it was given')
    })

    it('applies LAST, so an overlay can override a venue-wide key', () => {
        // HUB_DB_SYNC_POLL_INTERVAL is set venue-wide inside buildIndexerEnv; an
        // overlay merged FIRST could only add keys, never change one, which is the
        // wrong half of the job.
        const base = buildIndexerEnv(indexerSpec())
        assert.strictEqual(base.HUB_DB_SYNC_POLL_INTERVAL, '5000')
        const over = buildIndexerEnv(indexerSpec({
            extraEnv: indexerEnvOverlay({ 1: { HUB_DB_SYNC_POLL_INTERVAL: '250' } }, 1),
        }))
        assert.strictEqual(over.HUB_DB_SYNC_POLL_INTERVAL, '250',
            'the overlay lost to the venue-wide value, so it is merged in the wrong order and can ' +
            'never change a rule the venue already sets')
    })
}

function registerOverlayShape () {
    it('leaves the environment byte-identical when nothing is overlaid', () => {
        const before = JSON.stringify(buildIndexerEnv(indexerSpec()))
        for (const perIndex of [undefined, null, {}, { 1: { A: 'b' } }, { 0: {} }, { 0: 'not-an-object' }]) {
            const after = JSON.stringify(buildIndexerEnv(indexerSpec({
                extraEnv: indexerEnvOverlay(perIndex, 0),
            })))
            assert.strictEqual(after, before,
                'an unset overlay changed the environment for ' + JSON.stringify(perIndex) +
                ', so every existing leg on this venue is now running a different child')
            assert.strictEqual(indexerEnvOverlay(perIndex, 0), null,
                'an unset overlay must be null rather than an empty object, or buildIndexerEnv ' +
                'takes a branch it did not take before')
        }
    })

    it('stringifies values, because a number in a spawn environment throws', () => {
        const out = indexerEnvOverlay({ 0: { A: 0, B: true } }, 0)
        assert.deepStrictEqual(out, { A: '0', B: 'true' })
    })

    it('is carried on the venue as a per-index map', () => {
        const venue = new AttestMirrorVenue({ label: 'levers', indexerEnv: { 0: { [ARM]: '0' } } })
        assert.deepStrictEqual(venue.indexerEnv, { 0: { [ARM]: '0' } })
        assert.deepStrictEqual(new AttestMirrorVenue({ label: 'levers' }).indexerEnv, {},
            'an unset venue must carry an empty overlay map, not undefined')
    })
}

module.exports = { registerIndexOverlayLever }
