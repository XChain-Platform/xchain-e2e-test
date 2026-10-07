'use strict'

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert')
const path = require('path')
const drillKeys = require('../../../helpers/rail/drill_keys_dir')

function fakeFs({ dirs = [], files = {} } = {}){
    return {
        statSync(file){
            if (dirs.includes(file)) return { isDirectory: () => true }
            if (Object.prototype.hasOwnProperty.call(files, file)) return { isDirectory: () => false }
            const error = new Error('missing ' + file)
            error.code = 'ENOENT'
            throw error
        },
        readFileSync(file){
            if (Object.prototype.hasOwnProperty.call(files, file)) return files[file]
            const error = new Error('missing ' + file)
            error.code = 'ENOENT'
            throw error
        }
    }
}

describe('drill_keys_dir', function () {
    it('uses drill-keys beside a primary checkout', function () {
        const root = path.resolve('/repos/xchain-e2e-test')
        const dotGit = path.join(root, '.git')
        assert.strictEqual(
            drillKeys.resolveDrillKeysDir({ repoRoot: root, fs: fakeFs({ dirs: [dotGit] }) }),
            path.join(root, 'drill-keys'))
    })

    it('uses the primary checkout for a linked lane worktree', function () {
        const primary = path.resolve('/repos/xchain-e2e-test')
        const lane = path.resolve('/repos/tmp/lanes/lane-1/xchain-e2e-test')
        const gitDir = path.join(primary, '.git/worktrees/xchain-e2e-test1')
        const files = {
            [path.join(lane, '.git')]: 'gitdir: ' + gitDir + '\n',
            [path.join(gitDir, 'commondir')]: '../..\n'
        }
        assert.strictEqual(
            drillKeys.resolveDrillKeysDir({ repoRoot: lane, fs: fakeFs({ files }) }),
            path.join(primary, 'drill-keys'))
    })

    it('resolves relative gitdir pointers', function () {
        const primary = path.resolve('/repos/xchain-e2e-test')
        const lane = path.join(primary, 'lanes/lane-1')
        const gitDir = path.join(primary, '.git/worktrees/lane-1')
        const files = {
            [path.join(lane, '.git')]: 'gitdir: ../../.git/worktrees/lane-1',
            [path.join(gitDir, 'commondir')]: '../..'
        }
        assert.strictEqual(
            drillKeys.resolveDrillKeysDir({ repoRoot: lane, fs: fakeFs({ files }) }),
            path.join(primary, 'drill-keys'))
    })

    it('falls back to the checkout when Git metadata is absent or malformed', function () {
        const root = path.resolve('/staged/xchain-e2e-test')
        assert.strictEqual(
            drillKeys.resolveDrillKeysDir({ repoRoot: root, fs: fakeFs() }),
            path.join(root, 'drill-keys'))
        assert.strictEqual(
            drillKeys.resolveDrillKeysDir({ repoRoot: root, fs: fakeFs({
                files: { [path.join(root, '.git')]: 'not a gitdir pointer' }
            }) }),
            path.join(root, 'drill-keys'))
    })

    it('resolves this checkout through its shared Git metadata', function () {
        assert.strictEqual(path.basename(drillKeys.DRILL_KEYS_DIR), 'drill-keys')
        assert.ok(path.isAbsolute(drillKeys.DRILL_KEYS_DIR))
    })
})
