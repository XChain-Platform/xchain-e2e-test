'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readBarrierBound } = require('../../../helpers/rail_preflight/policy_barrier_bound');

const PROBE = path.resolve(
    __dirname, '..', '..', '..', 'helpers', 'rail_preflight', 'policy_barrier_bound.js'
);

const BOUND_READER = `
async function getAppliedPolicySnapshot(origin, tick, blockIndex) {
    return db.query('SELECT * FROM bridge_snapshots bs WHERE bs.block_index <= ?', [blockIndex]);
}
`;
const UNBOUND_READER = `
async function getAppliedPolicySnapshot(origin, tick) {
    return db.query('SELECT * FROM bridge_snapshots bs');
}
`;
const BOUND_SETTLE = `
const policy = await bridges.getAppliedPolicySnapshot(origin, tick, ctx.blockIndex);
`;
const UNBOUND_SETTLE = `
const policy = await bridges.getAppliedPolicySnapshot(origin, tick);
`;

function writeIndexer(root, bridgesDbText, transferSettleText){
    const indexerRoot = path.join(root, 'xchain-indexer');
    const bridgesDbPath = path.join(indexerRoot, 'src', 'db', 'bridges', 'index.js');
    const transferSettlePath = path.join(
        indexerRoot, 'src', 'consensus', 'bridge_settle', 'transfer.js'
    );
    fs.mkdirSync(path.dirname(bridgesDbPath), { recursive: true });
    fs.mkdirSync(path.dirname(transferSettlePath), { recursive: true });
    fs.writeFileSync(bridgesDbPath, bridgesDbText);
    fs.writeFileSync(transferSettlePath, transferSettleText);
}

function runProbe(root){
    return childProcess.spawnSync(process.execPath, [PROBE, root], { encoding: 'utf8' });
}

describe('readBarrierBound', function () {
    it('reports the settlement-block-bound reader and caller as bound', function () {
        assert.deepStrictEqual(readBarrierBound(BOUND_READER, BOUND_SETTLE), {
            reader: true,
            settle: true,
            bound: true
        });
    });

    it('rejects the two-parameter reader declaration', function () {
        assert.deepStrictEqual(readBarrierBound(UNBOUND_READER, BOUND_SETTLE), {
            reader: false,
            settle: true,
            bound: false
        });
    });

    it('rejects the settle call without ctx.blockIndex', function () {
        assert.deepStrictEqual(readBarrierBound(BOUND_READER, UNBOUND_SETTLE), {
            reader: true,
            settle: false,
            bound: false
        });
    });

    it('rejects a three-parameter reader without the block bound', function () {
        const reader = 'async function getAppliedPolicySnapshot(origin, tick, blockIndex) {}';
        assert.deepStrictEqual(readBarrierBound(reader, BOUND_SETTLE), {
            reader: false,
            settle: true,
            bound: false
        });
    });
});

describe('policy barrier bound CLI', function () {
    let root;

    beforeEach(function () {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-barrier-bound-'));
    });

    afterEach(function () {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('exits zero and reports yes for the bound pair', function () {
        writeIndexer(root, BOUND_READER, BOUND_SETTLE);
        const result = runProbe(root);
        assert.strictEqual(result.status, 0);
        assert.strictEqual(result.stdout, 'BARRIER_BOUND reader=yes settle=yes\n');
        assert.strictEqual(result.stderr, '');
    });

    it('exits one and reports no for the unbound pair', function () {
        writeIndexer(root, UNBOUND_READER, UNBOUND_SETTLE);
        const result = runProbe(root);
        assert.strictEqual(result.status, 1);
        assert.strictEqual(result.stdout, 'BARRIER_BOUND reader=no settle=no\n');
        assert.strictEqual(result.stderr, '');
    });

    it('exits two when an indexer source file is missing', function () {
        writeIndexer(root, BOUND_READER, BOUND_SETTLE);
        fs.rmSync(path.join(root, 'xchain-indexer', 'src', 'consensus', 'bridge_settle', 'transfer.js'));
        const result = runProbe(root);
        assert.strictEqual(result.status, 2);
        assert.strictEqual(result.stdout, '');
        assert.strictEqual(result.stderr, '');
    });
});
