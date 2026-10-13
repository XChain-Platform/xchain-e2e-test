'use strict';

const assert = require('assert');
const buildVenueDiagnostics = require('../../helpers/bridge_rail_venue/venue_diagnostics');

function venueWith(logs) {
    const venue = Object.defineProperties({}, buildVenueDiagnostics({ mariadb: {} }));
    venue.hubs = Object.keys(logs).map((k) => ({ index: Number(k) }));
    venue.btcVenue = { logTail: (which) => logs[Number(which.replace('hub', ''))] };
    return venue;
}

describe('venue hubTails', function () {
    it('drops repeating tip-age and no-LTC lines before slicing, so the gate line survives', function () {
        const noise = [];
        for (let i = 0; i < 50; i++) {
            noise.push('tip age 1200s exceeds MAX_TIP_AGE_S');
            noise.push('no LTC indexer URL configured');
        }
        const log = ['bridge hold: awaiting depth 6'].concat(noise).join('\n');
        const out = venueWith({ 0: log }).hubTails(10);
        assert.ok(out.includes('bridge hold: awaiting depth 6'), out);
        assert.ok(!/tip age|no LTC/.test(out), out);
    });

    it('keeps bridge hold and checkpoint stall lines even when they mention tip age', function () {
        const log = [
            'bridge hold: tip age 900s',
            'checkpoint stall at height 120',
            'tip age 5s',
            'no LTC indexer',
        ].join('\n');
        const out = venueWith({ 0: log }).hubTails(10);
        assert.ok(out.includes('bridge hold: tip age 900s'), out);
        assert.ok(out.includes('checkpoint stall at height 120'), out);
        assert.ok(!out.includes('\ntip age 5s'), out);
        assert.ok(!out.includes('no LTC'), out);
    });

    it('slices to the last N remaining lines and labels each hub', function () {
        const log = ['a', 'b', 'c', 'd'].join('\n');
        const out = venueWith({ 0: log, 1: 'z' }).hubTails(2);
        assert.strictEqual(out, '--- hub 0 ---\nc\nd\n--- hub 1 ---\nz');
    });
});
