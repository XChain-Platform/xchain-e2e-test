const assert = require('assert')
const { protocol, readLiteral } = require('./support/environment')

void describe('Family-B constant parity (copies the full-export guard does not reach)', () => {

    // The ROLLCALL GATES rail is a second, later pair of twins: canonical declares
    // ROLLCALL_GATES_REGTEST_ARMED_HEIGHT and its opt-in env key, and
    // xchain-hub/src/consensus/gates/rollcall_gates_gate.js and
    // xchain-indexer/src/consensus/gates/rollcall_gates_gate.js each re-declare both as bare
    // literals of their own. Neither repo compares its copy to canonical, and the
    // block above covers rollcall_activation.js only, so the gates twins could be
    // edited in step and leave the map of record behind with nothing red. The
    // height is what arms the rail on regtest and the env key is what opts a venue
    // in, so a drift in either silently changes which epochs the venue publishes
    // gates for while the hub and the indexer still agree with each other.
    it('[regression:p0] ROLLCALL_GATES_REGTEST_ARMED_HEIGHT / _ENV === canonical across hub + indexer', () => {
        const hubGates     = require('../../../../xchain-hub/src/consensus/gates/rollcall_gates_gate.js')
        const indexerGates = require('../../../../xchain-indexer/src/consensus/gates/rollcall_gates_gate.js')

        // A dropped export on all three sides would compare undefined to undefined
        // and pass, which is the shape this whole file exists to refuse.
        assert.ok(Number.isFinite(protocol.ROLLCALL_GATES_REGTEST_ARMED_HEIGHT),
            'ROLLCALL_GATES_REGTEST_ARMED_HEIGHT is not a finite value on the canonical protocol constants module')
        assert.ok(typeof protocol.ROLLCALL_GATES_REGTEST_ENV === 'string'
            && protocol.ROLLCALL_GATES_REGTEST_ENV.length > 0,
            'ROLLCALL_GATES_REGTEST_ENV is not a non-empty string on the canonical protocol constants module')

        const names = ['ROLLCALL_GATES_REGTEST_ARMED_HEIGHT', 'ROLLCALL_GATES_REGTEST_ENV']
        names.forEach((name) => {
            assert.strictEqual(hubGates[name], protocol[name],
                'hub rollcall_gates_activation ' + name + ' drifted from the canonical protocol constant; ' +
                'the hub decides which epochs it publishes gates for')
            assert.strictEqual(indexerGates[name], protocol[name],
                'indexer rollcall_gates_activation ' + name + ' drifted from the canonical protocol constant; ' +
                'the indexer is where the gates predicate is judged, so its copy decides what is accepted')
        })
    })

    })

void describe('Family-B constant parity (copies the full-export guard does not reach)', () => {

// Pin the shared-list membership ceiling on every bare-literal copy. The indexer's
    // vendored copy is pinned by its own activation_constants_parity test; the hub and
    // wallet copies are pinned only to the literal 10000 in their own suites, so a
    // canonical edit leaves both green while the hub declines, or the wallet offers,
    // shares the indexer sizes differently.
    it('[regression:p0] LIST_SHARE_MAX_MEMBERS === canonical across hub list constants + wallet share eligibility', () => {
        const hubList = require('../../../../xchain-hub/src/cross_chain/list/constants.js')
        assert.ok(Number.isFinite(protocol.LIST_SHARE_MAX_MEMBERS),
            'LIST_SHARE_MAX_MEMBERS is not a finite value on the canonical protocol constants module')
        assert.strictEqual(hubList.LIST_SHARE_MAX_MEMBERS, protocol.LIST_SHARE_MAX_MEMBERS,
            'hub cross_chain/list/constants.js LIST_SHARE_MAX_MEMBERS drifted from the canonical protocol constant')
        assert.strictEqual(readLiteral('xchain-wallet/packages/core/src/flows/listShareEligibility.js',
            /^export const LIST_SHARE_MAX_MEMBERS = (\d+);$/m, 'wallet listShareEligibility LIST_SHARE_MAX_MEMBERS'),
        protocol.LIST_SHARE_MAX_MEMBERS,
        'wallet listShareEligibility LIST_SHARE_MAX_MEMBERS drifted from the canonical protocol constant')
    })

    // Pin the union direct-member cap on the SDK validator's un-exported literal, so the
    // SDK cannot build a union the indexer refuses or refuse one it accepts.
    it('[regression:p0] LIST_UNION_MAX_MEMBERS === canonical in the SDK market_and_contract validator', () => {
        assert.ok(Number.isFinite(protocol.LIST_UNION_MAX_MEMBERS),
            'LIST_UNION_MAX_MEMBERS is not a finite value on the canonical protocol constants module')
        assert.strictEqual(readLiteral('xchain-sdk/src/protocol/validator/market_and_contract.js',
            /^const LIST_UNION_MAX_MEMBERS = (\d+);$/m, 'SDK market_and_contract LIST_UNION_MAX_MEMBERS'),
        protocol.LIST_UNION_MAX_MEMBERS,
        'SDK market_and_contract LIST_UNION_MAX_MEMBERS drifted from the canonical protocol constant')
    })

    })

void describe('Family-B constant parity (copies the full-export guard does not reach)', () => {

// Pin the LIST metadata byte caps on every bare-literal copy. The full-export block
    // below reaches only the indexer's vendored module; the LIST action handler, the SDK
    // validator and the wallet form each re-declare both caps, so one side could accept a
    // NAME or DESCRIPTION the others refuse.
    const LIST_META_CAPS = ['LIST_META_NAME_MAX_BYTES', 'LIST_META_DESCRIPTION_MAX_BYTES']
    LIST_META_CAPS.forEach((name) => {
        it('[regression:p0] ' + name + ' === canonical across indexer list/meta, SDK field_limits + wallet listMetaInput', () => {
            const sdkLimits = require('../../../../xchain-sdk/src/protocol/validator/field_limits.js')
            assert.ok(Number.isFinite(protocol[name]),
                name + ' is not a finite value on the canonical protocol constants module')
            assert.strictEqual(readLiteral('xchain-indexer/src/actions/list/meta.js',
                new RegExp('^const ' + name + ' = (\\d+);$', 'm'), 'indexer list/meta.js ' + name),
            protocol[name],
            'indexer list/meta.js ' + name + ' drifted from the canonical protocol constant; the indexer decides which LIST metadata is valid')
            assert.strictEqual(sdkLimits[name], protocol[name],
                'SDK validator/field_limits.js ' + name + ' drifted from the canonical protocol constant')
            assert.strictEqual(readLiteral('xchain-wallet/packages/core/src/flows/listMetaInput.js',
                new RegExp('^export const ' + name + ' = (\\d+);$', 'm'), 'wallet listMetaInput ' + name),
            protocol[name],
            'wallet listMetaInput ' + name + ' drifted from the canonical protocol constant')
        })
    })

    // Pin the rounds carried in one hourly PRICE wire on the hub's own literal, which
    // sizes every hourly window the publisher plans.
    it('[regression:p0] ORACLE_HOURLY_WINDOW_ROUNDS === canonical in hub oracle window_plan', () => {
        const hubWindow = require('../../../../xchain-hub/src/oracle/publisher/window_plan.js')
        assert.ok(Number.isFinite(protocol.ORACLE_HOURLY_WINDOW_ROUNDS),
            'ORACLE_HOURLY_WINDOW_ROUNDS is not a finite value on the canonical protocol constants module')
        assert.strictEqual(hubWindow.ORACLE_HOURLY_WINDOW_ROUNDS, protocol.ORACLE_HOURLY_WINDOW_ROUNDS,
            'hub oracle/publisher/window_plan.js ORACLE_HOURLY_WINDOW_ROUNDS drifted from the canonical protocol constant')
    })
})
