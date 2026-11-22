'use strict'

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const drillKeys = require('../../../helpers/rail/drill_keys_dir')

function git(cwd, ...args){
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
}

describe('drill_keys_dir main checkout', function () {
    let scratch
    let main
    let lane

    before(function () {
        // Git records worktree paths with symlinks resolved (macOS /var is /private/var), so compare real paths.
        scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'drill-keys-')))
        main = path.join(scratch, 'xchain-e2e-test')
        lane = path.join(scratch, 'tmp', 'lanes', 'lane-1', 'xchain-e2e-test')
        fs.mkdirSync(main)
        git(main, 'init', '-q')
        git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
        git(main, 'worktree', 'add', '-q', '--detach', lane)
    })

    after(function () {
        fs.rmSync(scratch, { recursive: true, force: true })
    })

    it('uses drill-keys beside the main checkout', function () {
        assert.strictEqual(drillKeys.resolveDrillKeysDir({ repoRoot: main }), path.join(main, 'drill-keys'))
    })

    it('resolves a linked worktree lane to the main checkout', function () {
        assert.strictEqual(drillKeys.resolveDrillKeysDir({ repoRoot: lane }), path.join(main, 'drill-keys'))
    })

    it('keeps the main checkout keys after the lane is removed', function () {
        const dir = drillKeys.resolveDrillKeysDir({ repoRoot: lane })
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, 'staker.json'), '[]')
        git(main, 'worktree', 'remove', '--force', lane)
        assert.ok(fs.existsSync(path.join(main, 'drill-keys', 'staker.json')))
    })

    it('falls back to the checkout when there is no Git metadata', function () {
        const staged = path.join(scratch, 'staged')
        fs.mkdirSync(staged)
        assert.strictEqual(drillKeys.resolveDrillKeysDir({ repoRoot: staged }), path.join(staged, 'drill-keys'))
    })

    it('falls back to the checkout for a bare common directory', function () {
        const root = path.resolve('/repos/xchain-e2e-test')
        const fakeFs = {
            statSync: () => ({ isDirectory: () => false }),
            readFileSync: (file) => {
                if (file === path.join(root, '.git')) return 'gitdir: /repos/bare.git/worktrees/x'
                if (file === path.join('/repos/bare.git/worktrees/x', 'commondir')) return '../..'
                throw new Error('ENOENT')
            },
        }
        assert.strictEqual(drillKeys.resolveDrillKeysDir({ repoRoot: root, fs: fakeFs }), path.join(root, 'drill-keys'))
    })

    it('resolves this checkout to its main checkout', function () {
        assert.strictEqual(drillKeys.DRILL_KEYS_DIR, drillKeys.resolveDrillKeysDir({ repoRoot: drillKeys.REPO_ROOT }))
    })
})
