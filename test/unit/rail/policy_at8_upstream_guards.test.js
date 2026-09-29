'use strict';

const assert = require('assert');

const { policyAt8Upstream } = require('../../helpers/rail_preflight/policy_at7_at8');

function listedPolicy(lag) {
    return {
        main: { tick: 'POLA', listIndex: 7 },
        lag: Object.assign({ tick: 'LAGA', listIndex: 9 }, lag),
        gap: {},
    };
}

describe('policy AT8 upstream guards', function () {
    it('reads no finalized upstream snapshots as unready', function () {
        assert.deepStrictEqual(policyAt8Upstream({}, {}), {
            cap: false,
            finalizedUpstream: 0,
        });
    });

    it('does not treat ticks and list indexes as finalized snapshots', function () {
        assert.deepStrictEqual(policyAt8Upstream(listedPolicy({}), {}), {
            cap: false,
            finalizedUpstream: 0,
        });
    });

    it('allows the cap after the AT1 mirror and AT5 lag snapshot finalize', function () {
        assert.deepStrictEqual(policyAt8Upstream(
            listedPolicy({ seq1: { snapshot_id: 'lag-1' } }),
            { at1_mirror: { seq1: 'main-1' } }
        ), {
            cap: true,
            finalizedUpstream: 2,
        });
    });

    it('counts a gap snapshot without making the cap ready', function () {
        assert.deepStrictEqual(policyAt8Upstream({
            main: {},
            lag: {},
            gap: { seq1: { snapshot_id: 'gap-1' } },
        }, {}), {
            cap: false,
            finalizedUpstream: 1,
        });
    });

    it('accepts missing arguments as empty upstream state', function () {
        assert.deepStrictEqual(policyAt8Upstream(), {
            cap: false,
            finalizedUpstream: 0,
        });
    });
});
