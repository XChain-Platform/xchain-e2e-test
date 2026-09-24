'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const prep = require('../../../scripts/prepare-bf6-mixed-hub')

const ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const BUILD_HUB = path.join(ROOT, 'xchain-hub')

describe('BF6 mixed hub checkout preparer', function () {
    this.timeout(60 * 1000)

    it('creates a detached real checkout at the pinned older upgrade state and removes it', function () {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bf6-mixed-checkout-'))
        // Beside the hub this test already clones from, never a counted number of
        // levels above it. The sibling row is what every layout agrees on; absolute
        // depth is not, so counting levels resolved to a real path in one lane
        // worktree and to a nonexistent directory on the CI venue, which is how this
        // case passed where it was written and failed the gate.
        const modules = path.join(BUILD_HUB, 'node_modules')
        const config = {
            workspace,
            stack: 'am-unit-1',
            buildHub: BUILD_HUB,
            source: BUILD_HUB,
            modules,
        }
        let mixedRoot = null
        try {
            mixedRoot = prep.createMixedCheckout(config)
            const hub = path.join(mixedRoot, 'xchain-hub')
            assert.strictEqual(execFileSync('git', ['-C', hub, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).trim(), 'true')
            assert.strictEqual(execFileSync('git', ['-C', hub, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), prep.MIXED_HUB_REVISION)
            assert.strictEqual(require(path.join(hub, 'src', 'hub_schema_version.js')).HUB_SCHEMA_VERSION, 6)
            assert.strictEqual(fs.lstatSync(path.join(hub, 'node_modules')).isSymbolicLink(), true)
            assert.strictEqual(prep.removeMixedCheckout(config), true)
            assert.strictEqual(fs.existsSync(mixedRoot), false)
            mixedRoot = null
        } finally {
            if (mixedRoot && fs.existsSync(mixedRoot)) prep.removeMixedCheckout(config)
            fs.rmSync(workspace, { recursive: true, force: true })
        }
    })

    it('refuses an unmarked directory instead of deleting an unknown tree', function () {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bf6-mixed-checkout-'))
        const paths = prep.targetPaths(workspace, 'am-unit-2')
        fs.mkdirSync(paths.root, { recursive: true })
        try {
            assert.throws(() => prep.removeMixedCheckout({ workspace, stack: 'am-unit-2' }), /no BF6 checkout marker/)
            assert.strictEqual(fs.existsSync(paths.root), true)
        } finally {
            fs.rmSync(workspace, { recursive: true, force: true })
        }
    })

    it('does not follow an archived worktree pointer when selecting the clone source', function () {
        const buildHub = fs.mkdtempSync(path.join(os.tmpdir(), 'bf6-archived-hub-'))
        fs.writeFileSync(path.join(buildHub, '.git'), 'gitdir: /unreachable/copied-worktree-pointer\n')
        fs.writeFileSync(path.join(buildHub, 'package.json'), JSON.stringify({ repository: 'upstream-source' }))
        try {
            assert.strictEqual(prep.repositorySource(buildHub), 'upstream-source')
        } finally {
            fs.rmSync(buildHub, { recursive: true, force: true })
        }
    })
})
