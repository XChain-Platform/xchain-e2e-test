// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict'

// Drives `bet-parity-node.sh up` against a fake docker whose node A answers.
// Each case protects one invariant of the clone-forward recipe and asserts on
// what the script DID (the logged docker calls, the env-file it wrote, its exit
// and output), never on the script text: the header comments name the same flags
// and variables, so a whole-file grep would stay green after the real line went.
//   - node B's database is never node A's (the drop would erase the source);
//   - the dump runs --single-transaction (a consistent read of the source);
//   - HUB_API_URL reaches node B (a follower without it diverges silently);
//   - an empty or different src tree refuses and removes node B;
//   - the printed hint names an npm script and an env var that exist.

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const SCRIPT = path.join(ROOT, 'bin', 'bet-parity-node.sh')
const SRC_DB = 'XChain_BTC_Indexer'
const DEFAULT_PARITY_DB = 'XChain_BTC_DrillB_Indexer'
const PARITY_CONTAINER = 'xchain-bet-parity-indexer'
const FAKE_PASSWORD = 's3cr3t-never-printed'
const HUB_LINE = 'HUB_API_URL=http://hub.test:9999'

const FAKE_DOCKER = [
    '#!/bin/sh',
    'printf "docker %s\\n" "$*" >> "$FAKE_DOCKER_LOG"',
    'case "$1" in',
    '    exec)',
    '        shift',
    '        if [ "$1" = "-i" ]; then cat >/dev/null; exit 0; fi',
    '        container=$1; shift',
    '        side=A; [ "$container" = "' + PARITY_CONTAINER + '" ] && side=B',
    '        case "$1" in',
    '            printenv)',
    '                case "${2:-}" in',
    '                    INDEXER_DB_NAME) echo "' + SRC_DB + '" ;;',
    '                    INDEXER_DB_USER) echo fake-user ;;',
    '                    INDEXER_DB_PASS) echo "' + FAKE_PASSWORD + '" ;;',
    '                    *) printf "%s\\n" HOME=/root HOSTNAME=abc PATH=/usr/bin \\',
    '                           INDEXER_DB_NAME=' + SRC_DB + ' ' + HUB_LINE + ' \\',
    '                           INDEXER_DB_USER=fake-user INDEXER_DB_PASS=' + FAKE_PASSWORD + ' ;;',
    '                esac ;;',
    '            tar) printf "tar-bytes" ;;',
    '            sh)',
    '                case "$3" in',
    '                    *mariadb-dump*) echo "-- fake dump" ;;',
    '                    *"wc -l"*) if [ $side = A ]; then echo "$FAKE_COUNT_A"; else echo "$FAKE_COUNT_B"; fi ;;',
    '                    *sha256sum*) if [ $side = A ]; then echo "$FAKE_HASH_A  -"; else echo "$FAKE_HASH_B  -"; fi ;;',
    '                    *SELECT*) echo 100 ;;',
    '                esac ;;',
    '            *) ;;',
    '        esac ;;',
    '    cp) cat >/dev/null ;;',
    '    inspect) echo fake/image:tag ;;',
    '    ps)',
    '        count_file="$FAKE_DOCKER_LOG.ps"',
    '        count=0; [ ! -f "$count_file" ] || count=$(cat "$count_file")',
    '        count=$((count + 1)); printf "%s" "$count" > "$count_file"',
    '        if [ -n "${FAKE_PS_FAIL_FROM:-}" ] && [ "$count" -ge "$FAKE_PS_FAIL_FROM" ]; then exit 1; fi',
    '        [ -z "${FAKE_PS_OUT:-}" ] || printf "%s\\n" "$FAKE_PS_OUT"',
    '        exit "${FAKE_PS_EXIT:-0}" ;;',
    '    rm) exit "${FAKE_RM_EXIT:-0}" ;;',
    '    create|start) ;;',
    '    *) exit 65 ;;',
    'esac',
    '',
].join('\n')

function fixture () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bet-parity-up-'))
    const bin = path.join(root, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER)
    fs.chmodSync(path.join(bin, 'docker'), 0o755)
    return { root, bin, log: path.join(root, 'docker.log'), work: path.join(root, 'work') }
}

function up (f, extra) {
    const env = Object.assign({}, process.env, {
        PATH: f.bin + path.delimiter + process.env.PATH,
        FAKE_DOCKER_LOG: f.log,
        WORK: f.work,
        FAKE_COUNT_A: '12',
        FAKE_COUNT_B: '12',
        FAKE_HASH_A: 'aaaa',
        FAKE_HASH_B: 'aaaa',
    }, extra || {})
    for (const key of ['SRC_CONTAINER', 'DB_CONTAINER', 'NETWORK', 'PARITY_CONTAINER']) delete env[key]
    if (!extra || !extra.PARITY_DB) delete env.PARITY_DB
    return spawnSync('bash', [SCRIPT, 'up'], { cwd: ROOT, env, encoding: 'utf8' })
}

function calls (f) {
    return fs.existsSync(f.log) ? fs.readFileSync(f.log, 'utf8').split('\n') : []
}

function lineIndex (lines, re) {
    return lines.findIndex(line => re.test(line))
}

function removedAfterCreate (f) {
    const lines = calls(f)
    const created = lineIndex(lines, /^docker create /)
    assert.ok(created >= 0, 'node B was never created')
    const removed = lines.findIndex((line, i) => i > created && line === 'docker rm -f ' + PARITY_CONTAINER)
    assert.ok(removed > created, 'node B was not removed after it was created')
}

describe('bet-parity-node.sh up with node A reachable', function () {
    let f = null
    beforeEach(function () { f = fixture() })
    afterEach(function () { fs.rmSync(f.root, { recursive: true, force: true }) })

    for (const [label, name] of [['the same name', SRC_DB], ['a case variant', SRC_DB.toLowerCase()]]) {
        it('refuses before any removal or drop when PARITY_DB is ' + label + ' as node A', function () {
            const r = up(f, { PARITY_DB: name })
            assert.notStrictEqual(r.status, 0)
            assert.match(r.stderr, /REFUSING: PARITY_DB .*equals node A's INDEXER_DB_NAME/)
            const log = calls(f).join('\n')
            assert.doesNotMatch(log, /^docker rm /m)
            assert.doesNotMatch(log, /DROP DATABASE/)
            assert.strictEqual(fs.existsSync(f.work), false)
        })
    }

    it('does not refuse a PARITY_DB that differs from node A', function () {
        const r = up(f, { PARITY_DB: DEFAULT_PARITY_DB })
        assert.doesNotMatch(r.stderr, /equals node A's INDEXER_DB_NAME/)
        assert.match(calls(f).join('\n'), new RegExp('DROP DATABASE IF EXISTS .*' + DEFAULT_PARITY_DB))
    })

    it('refuses before cloning when container removal cannot be confirmed', function () {
        const r = up(f, { FAKE_RM_EXIT: '1', FAKE_PS_EXIT: '1' })
        assert.notStrictEqual(r.status, 0)
        assert.match(r.stderr, /cannot confirm/)
        const log = calls(f).join('\n')
        assert.doesNotMatch(log, /DROP DATABASE|mariadb-dump|docker create/)
    })

    it('refuses before cloning when the old container remains', function () {
        const r = up(f, { FAKE_RM_EXIT: '1', FAKE_PS_OUT: 'container-id' })
        assert.notStrictEqual(r.status, 0)
        assert.match(r.stderr, /still exists/)
        assert.doesNotMatch(calls(f).join('\n'), /DROP DATABASE|mariadb-dump|docker create/)
    })

    it('clones with a consistent snapshot and builds node B from node A env', function () {
        const r = up(f)
        assert.strictEqual(r.status, 0, r.stderr)
        const dump = calls(f).find(line => line.includes('mariadb-dump'))
        assert.ok(dump, 'no dump was run')
        assert.match(dump, /--single-transaction/)
        const envFile = path.join(f.work, 'env.parity')
        const lines = fs.readFileSync(envFile, 'utf8').split('\n')
        assert.ok(lines.includes(HUB_LINE), 'HUB_API_URL missing from node B env-file')
        assert.deepStrictEqual(lines.filter(l => l.startsWith('INDEXER_DB_NAME=')), ['INDEXER_DB_NAME=' + DEFAULT_PARITY_DB])
        assert.ok(!lines.some(l => /^(HOME|HOSTNAME|PATH)=/.test(l)))
        assert.strictEqual(fs.statSync(envFile).mode & 0o777, 0o600)
        assert.ok(!r.stdout.includes(FAKE_PASSWORD) && !r.stderr.includes(FAKE_PASSWORD))
        assert.ok(!calls(f).some(line => line.includes(FAKE_PASSWORD)))
    })

    it('keeps node B after the identity check passes', function () {
        const r = up(f)
        assert.strictEqual(r.status, 0, r.stderr)
        const lines = calls(f)
        const started = lineIndex(lines, /^docker start /)
        assert.ok(started >= 0)
        assert.strictEqual(lines.findIndex((line, i) => i > started && line === 'docker rm -f ' + PARITY_CONTAINER), -1)
    })

    it('prints a hint naming an npm script and an env var that exist', function () {
        const r = up(f)
        const hint = /(\w+)=(\S+) npm run (\S+)/.exec(r.stdout)
        assert.ok(hint, r.stdout)
        const [, envName, dbName, scriptName] = hint
        assert.strictEqual(dbName, DEFAULT_PARITY_DB)
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
        assert.match(pkg.scripts[scriptName] || '', /test\/sdk\/betParity\.sdk\.test\.js/)
        const sdkTest = fs.readFileSync(path.join(ROOT, 'test', 'sdk', 'betParity.sdk.test.js'), 'utf8')
        assert.ok(sdkTest.includes('process.env.' + envName), envName + ' is not read by the drill')
    })

    it('refuses an empty src tree and removes node B', function () {
        const r = up(f, { FAKE_COUNT_B: '0' })
        assert.notStrictEqual(r.status, 0)
        assert.match(r.stderr, /REFUSING: src files node A=12 node B=0/)
        removedAfterCreate(f)
    })

    it('refuses differing src trees and removes node B', function () {
        const r = up(f, { FAKE_HASH_B: 'bbbb' })
        assert.notStrictEqual(r.status, 0)
        assert.match(r.stderr, /MISMATCH: node A src aaaa .* != node B src bbbb/)
        removedAfterCreate(f)
    })

    it('keeps the original failure and warns when cleanup cannot confirm removal', function () {
        const r = up(f, { FAKE_HASH_B: 'bbbb', FAKE_PS_FAIL_FROM: '2' })
        assert.notStrictEqual(r.status, 0)
        assert.match(r.stderr, /MISMATCH: node A src aaaa .* != node B src bbbb/)
        assert.match(r.stderr, /WARNING: cannot confirm/)
    })
})
