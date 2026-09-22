'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const MIXED_HUB_REVISION = '529ebe7aedb19ed150aedc294369da78f0280892'
const MARKER = '.bf6-mixed-checkout.json'

function git (args, options) {
    return execFileSync('git', args, Object.assign({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }, options || {})).trim()
}

function isCheckout (repo, allowGitFile) {
    const dotGit = path.join(repo, '.git')
    if (!fs.existsSync(dotGit)) return false
    if (!fs.statSync(dotGit).isDirectory() && !allowGitFile) return false
    try {
        return git(['-C', repo, 'rev-parse', '--is-inside-work-tree']) === 'true'
    } catch (_) {
        return false
    }
}

function repositorySource (buildHub, explicitSource) {
    if (explicitSource) {
        const source = path.resolve(explicitSource)
        assert.ok(isCheckout(source, true), source + ' is not a real git checkout')
        return source
    }
    if (isCheckout(buildHub)) return buildHub
    return upstreamRepository(buildHub)
}

function upstreamRepository (buildHub) {
    const pkg = JSON.parse(fs.readFileSync(path.join(buildHub, 'package.json'), 'utf8'))
    const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository && pkg.repository.url
    assert.ok(repository, buildHub + '/package.json has no repository source')
    return repository
}

function hasCommit (repo, revision) {
    try {
        git(['-C', repo, 'cat-file', '-e', revision + '^{commit}'])
        return true
    } catch (_) {
        return false
    }
}

function targetPaths (workspace, stack) {
    assert.match(stack, /^[a-zA-Z0-9_-]+$/, 'unsafe attest-mirror stack id')
    const parent = path.resolve(workspace, 'bf6-mixed')
    const root = path.join(parent, stack)
    return { parent, root, hub: path.join(root, 'xchain-hub'), marker: path.join(root, MARKER) }
}

function createMixedCheckout (config) {
    const paths = targetPaths(config.workspace, config.stack)
    assert.ok(!fs.existsSync(paths.root), paths.root + ' already exists; the previous BF6 checkout was not removed')
    const buildHub = path.resolve(config.buildHub)
    const modules = path.resolve(config.modules || path.join(buildHub, 'node_modules'))
    assert.ok(fs.existsSync(modules), modules + ' does not exist; the mixed hub needs installed dependencies')
    const source = repositorySource(buildHub, config.source)

    fs.mkdirSync(paths.parent, { recursive: true })
    try {
        git(['clone', '--no-checkout', '--quiet', source, paths.hub])
        // A shallow source (the CI venue's depth-1 sibling clone) lacks the pinned
        // commit, so fetch that one commit from the hub's declared upstream.
        if (!hasCommit(paths.hub, MIXED_HUB_REVISION)) {
            git(['-C', paths.hub, 'fetch', '--quiet', '--depth', '1', upstreamRepository(buildHub), MIXED_HUB_REVISION])
        }
        git(['-C', paths.hub, 'checkout', '--detach', '--quiet', MIXED_HUB_REVISION])
        const head = git(['-C', paths.hub, 'rev-parse', 'HEAD'])
        assert.strictEqual(head, MIXED_HUB_REVISION, 'mixed hub checkout resolved to the wrong revision')
        fs.symlinkSync(fs.realpathSync(modules), path.join(paths.hub, 'node_modules'), 'dir')
        fs.writeFileSync(paths.marker, JSON.stringify({ version: 1, stack: config.stack, revision: head }) + '\n')
        return paths.root
    } catch (error) {
        if (fs.existsSync(paths.root)) fs.rmSync(paths.root, { recursive: true, force: true })
        throw error
    }
}

function removeMixedCheckout (config) {
    const paths = targetPaths(config.workspace, config.stack)
    if (!fs.existsSync(paths.root)) return false
    assert.ok(fs.existsSync(paths.marker), paths.root + ' has no BF6 checkout marker; refusing to remove it')
    const marker = JSON.parse(fs.readFileSync(paths.marker, 'utf8'))
    assert.strictEqual(marker.stack, config.stack, paths.marker + ' belongs to a different stack')
    assert.strictEqual(marker.revision, MIXED_HUB_REVISION, paths.marker + ' names an unexpected revision')
    fs.rmSync(paths.root, { recursive: true })
    return true
}

function parseArgs (argv) {
    const args = argv.slice()
    const action = args.shift()
    const values = {}
    while (args.length > 0) {
        const key = args.shift()
        assert.ok(/^--[a-z-]+$/.test(key) && args.length > 0, 'bad BF6 checkout argument ' + key)
        values[key.slice(2)] = args.shift()
    }
    assert.ok(action === 'create' || action === 'remove', 'BF6 checkout action must be create or remove')
    assert.ok(values.workspace, '--workspace is required')
    assert.ok(values.stack, '--stack is required')
    if (action === 'create') assert.ok(values['build-hub'], '--build-hub is required')
    return {
        action,
        config: {
            workspace: values.workspace,
            stack: values.stack,
            buildHub: values['build-hub'],
            source: process.env.ATTEST_MIRROR_HUB_GIT_SOURCE,
            modules: process.env.ATTEST_MIRROR_HUB_NODE_MODULES,
        },
    }
}

function main () {
    const parsed = parseArgs(process.argv.slice(2))
    if (parsed.action === 'create') {
        process.stdout.write(createMixedCheckout(parsed.config) + '\n')
    } else {
        removeMixedCheckout(parsed.config)
    }
}

module.exports = {
    MIXED_HUB_REVISION,
    MARKER,
    isCheckout,
    repositorySource,
    targetPaths,
    createMixedCheckout,
    removeMixedCheckout,
    parseArgs,
}

if (require.main === module) {
    try {
        main()
    } catch (error) {
        process.stderr.write(error.message + '\n')
        process.exitCode = 1
    }
}
