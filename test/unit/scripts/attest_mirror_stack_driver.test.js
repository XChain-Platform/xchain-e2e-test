'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..', '..')
const DRIVER = path.join(ROOT, 'scripts', 'attest-mirror-stack-driver.sh')
const BF6 = 'test/attestMirror/barrier_family/bf6_producer_follower_parity.test.js'

function fixture () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-mirror-stack-driver-'))
    const log = path.join(root, 'run.log')
    const runLeg = path.join(root, 'run-leg.sh')
    fs.writeFileSync(runLeg, '#!/bin/sh\nprintf "%s\\n" "$*" > "$FAKE_DRIVER_LOG"\n')
    fs.chmodSync(runLeg, 0o755)
    return { root, log }
}

function runPhase (f, leg) {
    return spawnSync(DRIVER, ['run', '--stack', 'am-proof-1', '--slot', '0', '--leg', leg], {
        cwd: ROOT,
        env: Object.assign({}, process.env, {
            ATTEST_MIRROR_STACK_ROOT: f.root,
            FAKE_DRIVER_LOG: f.log,
        }),
        encoding: 'utf8',
    })
}

describe('attest-mirror concrete stack driver', function () {
    it('passes the prepared real-checkout root only to BF6', function () {
        const f = fixture()
        try {
            const bf6 = runPhase(f, BF6)
            assert.strictEqual(bf6.status, 0, bf6.stderr)
            const bf6Args = fs.readFileSync(f.log, 'utf8')
            assert.match(bf6Args, /BF6_MIXED_HUB_ROOT=/)
            assert.match(bf6Args, /xca71\/bf6-mixed\/am-proof-1/)

            const other = runPhase(f, 'test/attestMirror/zc5_flag_day.test.js')
            assert.strictEqual(other.status, 0, other.stderr)
            assert.doesNotMatch(fs.readFileSync(f.log, 'utf8'), /BF6_MIXED_HUB_ROOT=/)
        } finally {
            fs.rmSync(f.root, { recursive: true, force: true })
        }
    })
})
