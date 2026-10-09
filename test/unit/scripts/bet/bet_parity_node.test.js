'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const SCRIPT = path.join(ROOT, 'scripts', 'bet-parity-node.sh')

function writeExecutable (file, contents) {
    fs.writeFileSync(file, contents)
    fs.chmodSync(file, 0o755)
}

// Fake docker on PATH: every call is logged, and `exec` fails the way a
// stopped or renamed node A container does.
function fixture () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bet-parity-node-'))
    const log = path.join(root, 'docker.log')
    const bin = path.join(root, 'bin')
    fs.mkdirSync(bin)
    writeExecutable(path.join(bin, 'docker'), [
        '#!/bin/sh',
        'printf "docker %s\\n" "$*" >> "$FAKE_DOCKER_LOG"',
        'case "$1" in',
        '    exec)',
        '        echo "Error response from daemon: No such container: $2" >&2',
        '        exit 1',
        '        ;;',
        '    ps)',
        '        ;;',
        '    logs)',
        '        echo "node B log line"',
        '        ;;',
        '    rm)',
        '        ;;',
        '    *)',
        '        exit 65',
        '        ;;',
        'esac',
        '',
    ].join('\n'))
    return { root, log, bin }
}

function run (f, args) {
    return spawnSync('bash', [SCRIPT].concat(args), {
        cwd: ROOT,
        env: Object.assign({}, process.env, {
            PATH: f.bin + path.delimiter + process.env.PATH,
            FAKE_DOCKER_LOG: f.log,
            WORK: path.join(f.root, 'work'),
        }),
        encoding: 'utf8',
    })
}

function dockerCalls (f) {
    return fs.existsSync(f.log) ? fs.readFileSync(f.log, 'utf8') : ''
}

describe('bet-parity-node.sh with node A unreachable', function () {
    let f = null
    beforeEach(function () { f = fixture() })
    afterEach(function () { fs.rmSync(f.root, { recursive: true, force: true }) })

    it('down still removes node B', function () {
        const r = run(f, ['down'])
        assert.strictEqual(r.status, 0, r.stderr)
        assert.match(dockerCalls(f), /^docker rm -f xchain-bet-parity-indexer$/m)
        assert.doesNotMatch(dockerCalls(f), /^docker exec /m)
    })

    it('logs still reads node B', function () {
        const r = run(f, ['logs'])
        assert.strictEqual(r.status, 0, r.stderr)
        assert.match(r.stdout, /node B log line/)
    })

    it('an unknown subcommand prints usage and exits 2', function () {
        const r = run(f, ['nope'])
        assert.strictEqual(r.status, 2)
        assert.match(r.stderr, /usage: .* up\|status\|logs\|down/)
    })

    it('up refuses before removing node B or touching its database', function () {
        const r = run(f, ['up'])
        assert.notStrictEqual(r.status, 0)
        assert.match(r.stderr, /REFUSING: cannot read INDEXER_DB_NAME/)
        const calls = dockerCalls(f)
        assert.doesNotMatch(calls, /^docker rm /m)
        assert.doesNotMatch(calls, /DROP DATABASE/)
        assert.strictEqual(fs.existsSync(path.join(f.root, 'work')), false)
    })

    it('status refuses with the same message', function () {
        const r = run(f, ['status'])
        assert.notStrictEqual(r.status, 0)
        assert.match(r.stderr, /REFUSING: cannot read INDEXER_DB_NAME/)
    })
})
