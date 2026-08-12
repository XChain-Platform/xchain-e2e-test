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
 * Unit: MultiValidatorHub consensus-subsystem bring-up
 *
 * The federation harness gained opt-in startOracle / startReorgHandler /
 * startGovernance / startCapabilities toggles so L2 can drive every consensus
 * subsystem through the same in-process mesh, not just attestation. These tests
 * pin the wiring WITHOUT a live MariaDB by injecting a fake hub factory
 * (opts.hubFactory) that records the exact start-call order. They guard two
 * things a live integration test can't cheaply assert: that the toggles map 1:1
 * onto the hub's start methods, and that they fire in the canonical api.js boot
 * order (oracle -> crossChain -> reorgHandler -> governance -> attestation ->
 * capabilities), which governance-before-attestation depends on.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const { MultiValidatorHub } = require('../../helpers/multiValidatorHubHelper.js');

// A fake hub that records which start* methods were called, in order. It also
// stands in for the getters the harness reads (getOracle/getCrossChainDex) and
// the teardown path (registerValidator, close). No DB, no sockets.
function makeFakeHubFactory(calls) {
    return function fakeHubFactory() {
        const oracle = { _kind: 'OracleRound' };
        const reorgHandler = { _kind: 'ReorgHandler' };
        const governance = { _kind: 'Governance' };
        const hub = {
            oracle: null,
            oracleConsensus: null,
            reorgHandler: null,
            governance: null,
            _log: [],
            async start()            { this._log.push('start'); },
            async startP2P()         { this._log.push('startP2P'); },
            async startConsensus()   { this._log.push('startConsensus'); },
            async startOracle()      { this._log.push('startOracle'); this.oracle = oracle; this.oracleConsensus = { _kind: 'OracleConsensus' }; },
            async startCrossChain()  { this._log.push('startCrossChain'); },
            async startReorgHandler(){ this._log.push('startReorgHandler'); this.reorgHandler = reorgHandler; },
            async startGovernance()  { this._log.push('startGovernance'); this.governance = governance; },
            async startAttestation() { this._log.push('startAttestation'); },
            async startCapabilities(cfg){ this._log.push('startCapabilities:' + String(cfg)); },
            getOracle()              { return this.oracle; },
            getCrossChainDex()       { return null; },
            async registerValidator(){ /* mesh bootstrap, no-op */ },
            async close()            { this._log.push('close'); }
        };
        calls.push(hub);
        return hub;
    };
}

// A high, unlikely-contended base port keeps _pickFreePorts fast and avoids
// colliding with any live mesh in a parallel run.
const BASE_PORT = 41000;

describe('MultiValidatorHub consensus-subsystem bring-up', function () {

    it('defaults every consensus subsystem OFF and attestation ON', function () {
        const mvh = new MultiValidatorHub({ dbUser: 'u', dbPass: 'p' });
        assert.strictEqual(mvh.startOracleSubsystem, false);
        assert.strictEqual(mvh.startReorgHandlerSubsystem, false);
        assert.strictEqual(mvh.startGovernanceSubsystem, false);
        assert.strictEqual(mvh.startCapabilitiesSubsystem, false);
        assert.strictEqual(mvh.startAttestationSubsystem, true);
    });

    it('reads each opt-in toggle from constructor opts', function () {
        const mvh = new MultiValidatorHub({
            dbUser: 'u', dbPass: 'p',
            startOracle: true, startReorgHandler: true,
            startGovernance: true, startCapabilities: true,
            capabilitiesConfig: '/tmp/caps.json'
        });
        assert.strictEqual(mvh.startOracleSubsystem, true);
        assert.strictEqual(mvh.startReorgHandlerSubsystem, true);
        assert.strictEqual(mvh.startGovernanceSubsystem, true);
        assert.strictEqual(mvh.startCapabilitiesSubsystem, true);
        assert.strictEqual(mvh.capabilitiesConfigPath, '/tmp/caps.json');
    });

    it('brings up oracle, reorg, and governance in canonical order, skipping unset ones', async function () {
        const calls = [];
        const mvh = new MultiValidatorHub({
            count: 2, dbUser: 'u', dbPass: 'p', basePort: BASE_PORT,
            hubFactory: makeFakeHubFactory(calls),
            startOracle: true, startReorgHandler: true, startGovernance: true,
            startAttestation: false
        });
        await mvh.start();
        try {
            assert.strictEqual(calls.length, 2, 'one fake hub built per validator');
            for (const hub of calls) {
                assert.deepStrictEqual(hub._log, [
                    'start', 'startP2P', 'startConsensus',
                    'startOracle', 'startReorgHandler', 'startGovernance'
                ], 'subsystems fired in canonical boot order, attestation skipped');
            }
            // Getters surface the live subsystem objects per hub.
            assert.deepStrictEqual(mvh.getOracles().map(o => o && o._kind), ['OracleRound', 'OracleRound']);
            assert.deepStrictEqual(mvh.getGovernances().map(g => g && g._kind), ['Governance', 'Governance']);
            assert.deepStrictEqual(mvh.getReorgHandlers().map(r => r && r._kind), ['ReorgHandler', 'ReorgHandler']);
        } finally {
            await mvh.stop();
        }
    });

    it('starts governance BEFORE attestation so the hot-reload hook can bind', async function () {
        const calls = [];
        const mvh = new MultiValidatorHub({
            count: 1, dbUser: 'u', dbPass: 'p', basePort: BASE_PORT + 100,
            hubFactory: makeFakeHubFactory(calls),
            startGovernance: true  // attestation defaults ON
        });
        await mvh.start();
        try {
            const log = calls[0]._log;
            const gIdx = log.indexOf('startGovernance');
            const aIdx = log.indexOf('startAttestation');
            assert.ok(gIdx >= 0 && aIdx >= 0, 'both governance and attestation ran');
            assert.ok(gIdx < aIdx, 'governance must precede attestation (hot-reload hook binds to governance events)');
        } finally {
            await mvh.stop();
        }
    });

    it('passes capabilitiesConfig through to hub.startCapabilities', async function () {
        const calls = [];
        const mvh = new MultiValidatorHub({
            count: 1, dbUser: 'u', dbPass: 'p', basePort: BASE_PORT + 200,
            hubFactory: makeFakeHubFactory(calls),
            startAttestation: false,
            startCapabilities: true, capabilitiesConfig: '/etc/xchain/caps.json'
        });
        await mvh.start();
        try {
            assert.ok(calls[0]._log.includes('startCapabilities:/etc/xchain/caps.json'),
                'capability config path forwarded to hub.startCapabilities');
        } finally {
            await mvh.stop();
        }
    });

    it('leaves consensus subsystems unstarted by default (only attestation runs)', async function () {
        const calls = [];
        const mvh = new MultiValidatorHub({
            count: 1, dbUser: 'u', dbPass: 'p', basePort: BASE_PORT + 300,
            hubFactory: makeFakeHubFactory(calls)
        });
        await mvh.start();
        try {
            const log = calls[0]._log;
            assert.deepStrictEqual(log, ['start', 'startP2P', 'startConsensus', 'startAttestation']);
            assert.deepStrictEqual(mvh.getOracles(), [null]);
            assert.deepStrictEqual(mvh.getGovernances(), [null]);
            assert.deepStrictEqual(mvh.getReorgHandlers(), [null]);
        } finally {
            await mvh.stop();
        }
    });
});
