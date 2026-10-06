const assert  = require('assert')
const fs      = require('fs')
const path    = require('path')
const bitcoin = require('bitcoinjs-lib')
const Module  = require('module')
const { moduleEntry } = require('../../../support/sibling_source.js')

// Two services each carry their own isolated-vm build; loading both native addons in one
// process aborts the runtime. Every require of it resolves to the xchain-vm copy.
const sharedIvm = path.join(__dirname, '../../../../../xchain-vm/node_modules/isolated-vm')
const resolveFilename = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
    return resolveFilename.call(this, request === 'isolated-vm' ? sharedIvm : request, ...rest)
}

const protocol = require('../../../../../xchain-documentation/protocol/constants.js')

const encoderValidator = require('../../../../../xchain-encoder/src/common/validator.js')
const XChainDecoder     = require('../../../../../xchain-decoder/src/XChainDecoder.js')
const sdkValidator      = require('../../../../../xchain-sdk/src/protocol/validator.js')
const indexerDeploy     = require('../../../../../xchain-indexer/src/actions/deploy/index.js')
const indexerXcall      = require('../../../../../xchain-indexer/src/actions/xcall/index.js')
// xexec is the one handler here that may still be flat: `actions/xexec.js` on an older
// indexer, `actions/xexec/index.js` once it moved into its parts directory. moduleEntry
// loads whichever exists and throws naming both when neither does.
const indexerXexec      = require(moduleEntry(path.join(__dirname, '../../../../../xchain-indexer/src/actions/xexec.js')))
const hubConstants      = require('../../../../../xchain-hub/src/constants.js')

// An indexer action handler is either src/actions/<name>.js or, once it is split, the
// directory src/actions/<name>/ with the entry at index.js and the logic in parts beside
// it (the shape the sdk drift gate pins, which forbids a flat file next to the directory).
// These tripwires read the handler as SOURCE TEXT, so they read every file of it: reading
// index.js alone would miss a literal that moved into a part and report the guard
// "no longer assigns" it, which reads as drift when nothing drifted.
function readIndexerHandler(handlerPath) {
    const asDirectory = handlerPath.replace(/\.js$/, '')
    if (fs.existsSync(asDirectory) && fs.statSync(asDirectory).isDirectory())
        return fs.readdirSync(asDirectory).filter(f => f.endsWith('.js')).sort()
            .map(f => fs.readFileSync(path.join(asDirectory, f), 'utf8')).join('\n')
    return fs.existsSync(handlerPath) ? fs.readFileSync(handlerPath, 'utf8') : null
}

const XChainVM          = require('../../../../../xchain-vm/src/index.js')
const explorerVmQuery   = require('../../../../../xchain-explorer/src/contract/vm_query.js')

// The indexer's EXECUTE handler re-validates VM_MAX_CALL_DEPTH/VM_MIN_CALL_GAS host-side
// as un-exported `const`s. Those consts derive from the vendored
// src/protocol/constants.js rather than bare literals, so assert the source is
// wired to the vendored module (no bare literal can re-enter) and read the effective
// values from that same vendored copy. Full export identity with the canonical
// values is asserted separately below.
//
// The `../` run in the require is matched rather than counted: the handler moved from
// src/actions/execute.js to src/actions/execute/index.js and reaches the same vendored
// module one directory further up. Pinning the exact run would fail on a pure move,
// which is not what this guard is for; what it must catch is the require disappearing
// in favour of a bare literal, and any depth of `../` still catches that.
function readIndexerExecuteCallCaps() {
    const src = fs.readFileSync(
        path.join(__dirname, '../../../../../xchain-indexer/src/actions/execute/index.js'), 'utf8')
    assert.ok(/require\((['"])(?:\.\.\/)+protocol\/constants(?:\.js)?\1\)/.test(src),
        'indexer EXECUTE handler no longer requires the vendored protocol/constants module')
    assert.ok(/MAX_CALL_DEPTH\s*=\s*[A-Za-z_$][\w$]*\.VM_MAX_CALL_DEPTH/.test(src),
        'indexer execute/index.js MAX_CALL_DEPTH is not derived from the vendored VM_MAX_CALL_DEPTH constant')
    assert.ok(/MIN_CALL_GAS\s*=\s*[A-Za-z_$][\w$]*\.VM_MIN_CALL_GAS/.test(src),
        'indexer execute/index.js MIN_CALL_GAS is not derived from the vendored VM_MIN_CALL_GAS constant')
    const vendored = require('../../../../../xchain-indexer/src/protocol/constants.js')
    return { MAX_CALL_DEPTH: vendored.VM_MAX_CALL_DEPTH, MIN_CALL_GAS: vendored.VM_MIN_CALL_GAS }
}

const XCALL_FIELDS = [
    'XCALL_MIN_GAS', 'XCALL_MAX_GAS', 'XCALL_MAX_HOPS',
    'XCALL_MIN_DEADLINE_BLOCKS', 'XCALL_MAX_DEADLINE_BLOCKS', 'XCALL_MAX_CALLS_PER_BLOCK',
]

    // The full-export block below compares whole vendored modules against
    // canonical exports. It cannot see another shape of copy:
    // a service that re-declares a canonical value as a bare literal without
    // vendoring anything (the encoder, the explorer compression reader, both
    // price-pair activation gates, the wallet gated-send guard). These tests
    // also pin values per constant, naming the exact surface that drifted.

    const vendoredConstants = {
        'xchain-vm':       require('../../../../../xchain-vm/src/protocol/constants.js'),
        'xchain-indexer':  require('../../../../../xchain-indexer/src/protocol/constants.js'),
        'xchain-explorer': require('../../../../../xchain-explorer/src/protocol/constants.js'),
        'xchain-sdk':      require('../../../../../xchain-sdk/src/protocol/constants.js'),
        'xchain-decoder':  require('../../../../../xchain-decoder/src/protocol/constants.js'),
    }

    // Assert the named constant equals canonical in each listed vendored copy.
    function assertVendored(name, services) {
        services.forEach((svc) => {
            assert.strictEqual(
                vendoredConstants[svc][name],
                protocol[name],
                svc + ' vendored ' + name + ' drifted from the canonical protocol constant'
            )
        })
    }

    // Read one bare literal declaration out of a sibling source file, for copies that are
    // not exported (sdk validator) or live in an ESM package this suite cannot require.
    function readLiteral(relPath, pattern, label) {
        const abs = path.join(__dirname, '../../../../../', relPath)
        assert.ok(fs.existsSync(abs), relPath + ' is missing; this tripwire needs the full sibling tree')
        const hit = pattern.exec(fs.readFileSync(abs, 'utf8'))
        assert.ok(hit, label + ' is no longer a bare literal declaration; re-point this guard')
        return Number(hit[1])
    }

module.exports = {
    assert, fs, path, bitcoin, protocol, encoderValidator, XChainDecoder, sdkValidator,
    indexerDeploy, indexerXcall, indexerXexec, hubConstants, XChainVM, explorerVmQuery,
    readIndexerHandler, readIndexerExecuteCallCaps, XCALL_FIELDS, vendoredConstants, assertVendored, readLiteral,
}
