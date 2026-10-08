'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..', '..')
const DRIVER = path.join(ROOT, 'scripts', 'attest-mirror-stack-driver.sh')
const BF6 = 'test/attestMirror/barrier_family/bf6_producer_follower_parity.test.js'

function writeExecutable (file, contents) {
    fs.writeFileSync(file, contents)
    fs.chmodSync(file, 0o755)
}

function fixture () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-mirror-stack-driver-'))
    const log = path.join(root, 'run.log')
    const dockerState = path.join(root, 'docker-volume-ls-count')
    const bin = path.join(root, 'bin')
    fs.mkdirSync(bin)
    const runLeg = path.join(root, 'run-leg.sh')
    writeExecutable(runLeg, '#!/bin/sh\nprintf "%s\\n" "$*" > "$FAKE_DRIVER_LOG"\n')
    writeExecutable(path.join(root, 'setup-stack.sh'), [
        '#!/bin/sh',
        'printf "setup %s\\n" "$*" >> "$FAKE_DRIVER_LOG"',
        '',
    ].join('\n'))
    writeExecutable(path.join(bin, 'sleep'), [
        '#!/bin/sh',
        'printf "sleep %s\\n" "$*" >> "$FAKE_DRIVER_LOG"',
        '',
    ].join('\n'))
    writeExecutable(path.join(bin, 'docker'), [
        '#!/bin/sh',
        'printf "docker %s\\n" "$*" >> "$FAKE_DRIVER_LOG"',
        'label="label=com.docker.compose.project=${FAKE_EXPECTED_PROJECT}"',
        'case "$1:$2" in',
        '    ps:-aq)',
        '        test "$3" = --filter && test "$4" = "$label" || exit 64',
        '        ;;',
        '    volume:ls)',
        '        test "$3" = -q && test "$4" = --filter && test "$5" = "$label" || exit 64',
        '        count=0',
        '        test ! -f "$FAKE_DOCKER_STATE" || read -r count < "$FAKE_DOCKER_STATE"',
        '        count=$((count + 1))',
        '        printf "%s\\n" "$count" > "$FAKE_DOCKER_STATE"',
        '        if test "$FAKE_DOCKER_MODE" = refuse || { test "$FAKE_DOCKER_MODE" = sweep && test "$count" -eq 1; }; then',
        '            printf "%s-db-data\\n" "$FAKE_EXPECTED_PROJECT"',
        '        fi',
        '        ;;',
        '    volume:rm|rm:-f)',
        '        ;;',
        '    *)',
        '        exit 65',
        '        ;;',
        'esac',
        '',
    ].join('\n'))
    return { root, log, dockerState, bin }
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

function runUp (f, options = {}) {
    const slot = options.slot || '0'
    const prefix = options.prefix || 'xca7'
    const project = prefix + (Number(slot) + 1)
    return spawnSync(DRIVER, ['up', '--stack', 'am-proof-1', '--slot', slot,
        '--leg', 'test/attestMirror/zc5_flag_day.test.js'], {
        cwd: ROOT,
        env: Object.assign({}, process.env, {
            ATTEST_MIRROR_STACK_ROOT: f.root,
            ATTEST_MIRROR_STACK_PREFIX: prefix,
            FAKE_DOCKER_MODE: options.mode || 'clean',
            FAKE_DOCKER_STATE: f.dockerState,
            FAKE_DRIVER_LOG: f.log,
            FAKE_EXPECTED_PROJECT: project,
            PATH: f.bin + path.delimiter + process.env.PATH,
        }),
        encoding: 'utf8',
    })
}

function logLines (f) {
    return fs.readFileSync(f.log, 'utf8').trim().split('\n')
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

    it('sweeps a stale project volume before booting the replacement stack', function () {
        const f = fixture()
        try {
            const result = runUp(f, { mode: 'sweep' })
            assert.strictEqual(result.status, 0, result.stderr)
            const lines = logLines(f)
            const volumeRemove = lines.indexOf('docker volume rm xca71-db-data')
            const setup = lines.indexOf('setup 1 62100')
            assert.ok(volumeRemove >= 0, lines.join('\n'))
            assert.ok(setup > volumeRemove, lines.join('\n'))
            assert.strictEqual(lines.filter(line => line === 'sleep 2').length, 1)
        } finally {
            fs.rmSync(f.root, { recursive: true, force: true })
        }
    })

    it('retries ten times and refuses to boot while a stale volume survives', function () {
        const f = fixture()
        try {
            const result = runUp(f, { mode: 'refuse' })
            assert.strictEqual(result.status, 1, result.stderr)
            assert.match(result.stderr, /stack slot xca71 still holds volumes after cleanup; refusing to boot over them/)
            const lines = logLines(f)
            assert.strictEqual(lines.filter(line => line === 'docker volume rm xca71-db-data').length, 10)
            assert.strictEqual(lines.filter(line => line.startsWith('docker volume ls ')).length, 11)
            assert.strictEqual(lines.filter(line => line === 'sleep 2').length, 10)
            assert.strictEqual(lines.filter(line => line.startsWith('setup ')).length, 0)
        } finally {
            fs.rmSync(f.root, { recursive: true, force: true })
        }
    })

    it('scopes every stale-resource lookup to the selected project label', function () {
        const f = fixture()
        try {
            const result = runUp(f, { prefix: 'guard-', slot: '2' })
            assert.strictEqual(result.status, 0, result.stderr)
            const lookups = logLines(f).filter(line =>
                line.startsWith('docker ps ') || line.startsWith('docker volume ls '))
            assert.deepStrictEqual(lookups, [
                'docker ps -aq --filter label=com.docker.compose.project=guard-3',
                'docker volume ls -q --filter label=com.docker.compose.project=guard-3',
                'docker volume ls -q --filter label=com.docker.compose.project=guard-3',
            ])
        } finally {
            fs.rmSync(f.root, { recursive: true, force: true })
        }
    })

    it('seed phase hands run-leg.sh a reseed spec that exists on disk', function () {
        const f = fixture()
        try {
            const result = spawnSync(DRIVER, ['seed', '--stack', 'am-proof-1', '--slot', '0',
                '--leg', 'test/attestMirror/zc5_flag_day.test.js'], {
                cwd: ROOT,
                env: Object.assign({}, process.env, { ATTEST_MIRROR_STACK_ROOT: f.root, FAKE_DRIVER_LOG: f.log }),
                encoding: 'utf8',
            })
            assert.strictEqual(result.status, 0, result.stderr)
            const args = fs.readFileSync(f.log, 'utf8').trim().split(/\s+/)
            assert.strictEqual(args[0], 'am-proof-1-seed')
            assert.strictEqual(args[3], 'test/tools/reseed_attestation_roster.test.js')
            assert.ok(fs.existsSync(path.join(ROOT, args[3])), 'seed spec missing: ' + args[3])
        } finally {
            fs.rmSync(f.root, { recursive: true, force: true })
        }
    })

    it('every test/ path the driver names exists on disk', function () {
        const named = fs.readFileSync(DRIVER, 'utf8').match(/test\/[A-Za-z0-9_./-]+\.js/g) || []
        assert.ok(named.length > 0, 'the driver names no test/ path, so this check reads nothing')
        const missing = named.filter((rel) => !fs.existsSync(path.join(ROOT, rel)))
        assert.deepStrictEqual(missing, [], 'driver names a test path that does not exist')
    })
})
