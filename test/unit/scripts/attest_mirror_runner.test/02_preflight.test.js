'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const runner = require('../../../../scripts/run-attest-mirror')
const { captureStdout, fakeSpawn, fixture, restoreFakeEnv } = require('./support/helpers')

function stagedRealHelper () {
    const f = fixture()
    const scripts = path.join(f.root, 'scripts')
    fs.mkdirSync(scripts)
    fs.copyFileSync(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'wait-attest-mirror-stack.js'),
        path.join(scripts, 'wait-attest-mirror-stack.js'))
    fs.copyFileSync(f.driver, path.join(scripts, 'driver.js'))
    return Object.assign(f, { driver: path.join(scripts, 'driver.js') })
}

function registerMissingDependencyTests () {
    it('refuses a missing readiness dependency before allocating a stack', async function () {
        const f = fixture()
        fs.writeFileSync(f.helper, "'use strict'\nrequire('module-that-is-deliberately-absent')\n")
        let error = null
        try {
            await captureStdout(() => runner.runAll({
                root: f.root, driver: f.driver, legs: [f.legs[0]], concurrency: '1', runId: 'preflight-failure',
                spawn: fakeSpawn(() => false, []),
            }))
        } catch (caught) {
            error = caught
        }
        assert.ok(error)
        assert.match(error.message, /module-that-is-deliberately-absent/)
        assert.match(error.message, new RegExp(f.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        assert.doesNotMatch(error.capturedStdout, /\[attest-mirror\] allocate/)
    })

    it('passes preflight silently on a healthy run', async function () {
        const f = fixture()
        const events = []
        const captured = await captureStdout(() => runner.runAll({
            root: f.root, driver: f.driver, legs: [f.legs[0]], concurrency: '1', runId: 'silent-preflight',
            spawn: fakeSpawn(() => false, events),
        }))
        assert.strictEqual(captured.value[0].code, 0)
        assert.strictEqual(captured.output,
            '[attest-mirror] allocate am-silent-preflight-1 slot=0 leg=' + f.legs[0] + '\n' +
            '[attest-mirror] release am-silent-preflight-1 exit=0\n')
    })
}

function registerStagedHelperTests () {
    it('refuses the real readiness helper when its required dependency is missing from the staged tree', async function () {
        const f = stagedRealHelper()
        let resolvable = true
        try { require.resolve('mariadb', { paths: [f.root] }) } catch (_) { resolvable = false }
        assert.strictEqual(resolvable, false, 'this host resolves mariadb above the staged tree, so the case cannot fail')
        const events = []
        let error = null
        try {
            await captureStdout(() => runner.runAll({
                root: f.root, driver: f.driver, legs: [f.legs[0]], concurrency: '1', runId: 'real-helper-missing-dep',
                spawn: fakeSpawn(() => false, events),
            }))
        } catch (caught) {
            error = caught
        }
        assert.ok(error, 'the preflight let a tree without mariadb through')
        assert.match(error.message, /could not resolve module "mariadb"/)
        assert.match(error.message, new RegExp(f.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        assert.doesNotMatch(error.capturedStdout, /\[attest-mirror\] allocate/)
        assert.deepStrictEqual(events, [])
    })

    it('passes the real readiness helper when the staged tree provides its required dependency', async function () {
        const f = stagedRealHelper()
        const moduleDir = path.join(f.root, 'node_modules', 'mariadb')
        fs.mkdirSync(moduleDir, { recursive: true })
        fs.writeFileSync(path.join(moduleDir, 'package.json'), '{"name":"mariadb","main":"index.js"}')
        fs.writeFileSync(path.join(moduleDir, 'index.js'), 'module.exports = {}\n')
        const events = []
        const captured = await captureStdout(() => runner.runAll({
            root: f.root, driver: f.driver, legs: [f.legs[0]], concurrency: '1', runId: 'real-helper-dep-present',
            spawn: fakeSpawn(() => false, events),
        }))
        assert.strictEqual(captured.value[0].code, 0)
        assert.ok(events.length > 0)
    })
}

function registerHelperDeclarationTests () {
    it('refuses a readiness helper that does not declare its required dependencies', async function () {
        const f = fixture()
        fs.writeFileSync(f.helper, "'use strict'\nrequire('path')\n")
        await assert.rejects(runner.runAll({
            root: f.root, driver: f.driver, legs: [f.legs[0]], concurrency: '1', runId: 'undeclared-deps',
            spawn: fakeSpawn(() => false, []),
        }), /does not export REQUIRED_DEPENDENCIES and DEPENDENCY_ROOT/)
    })

    it('refuses when the readiness helper is absent', async function () {
        const f = fixture()
        fs.unlinkSync(f.helper)
        await assert.rejects(runner.runAll({
            root: f.root, driver: f.driver, legs: [f.legs[0]], concurrency: '1', runId: 'missing-helper',
            spawn: fakeSpawn(() => false, []),
        }), /readiness helper does not exist/)
    })
}

describe('attest-mirror aggregate runner: preflight', function () {
    restoreFakeEnv()

    registerMissingDependencyTests()
    registerStagedHelperTests()
    registerHelperDeclarationTests()
})
