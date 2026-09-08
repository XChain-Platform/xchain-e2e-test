#!/usr/bin/env node
'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// package.json declares xchain-sdk and xchain-hub as `file:./xchain-sdk` and
// `file:./xchain-hub`. Both vendor directories are gitignored, so a fresh
// checkout has neither, and `test/sdk/**` fails with "Cannot find module
// 'xchain-sdk'" until something fills them in. CI fills them with real
// package snapshots before `npm ci`, so this script must never run from a
// `pretest` hook: that would overwrite a CI-staged snapshot with a symlink.
// It is opt-in, run by hand (`npm run stage:siblings`), and only touches a
// vendor dir when there is nothing there worth keeping.
//
// Usage:
//   node scripts/stage-siblings.js            stage what is missing
//   node scripts/stage-siblings.js --check     report state, change nothing
//   node scripts/stage-siblings.js --unstage   remove symlinks this script made

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const SIBLINGS = ['xchain-sdk', 'xchain-hub']

// A vendor dir counts as "holding a staged snapshot" only when it has its own
// package.json: that is the one file a real package (CI-staged or hand-copied)
// always carries, and it is what require() actually needs to resolve the
// module. A bare leftover node_modules/ with no package.json (seen on this
// Mac: an old `npm install` run inside the vendor dir before it was emptied)
// is not a usable package, so it is treated the same as an empty directory
// and is safe to clear and replace with a symlink.
function hasSnapshot(dir) {
    return fs.existsSync(path.join(dir, 'package.json'))
}

function lstatOrNull(p) {
    try {
        return fs.lstatSync(p)
    } catch (err) {
        if (err.code === 'ENOENT') return null
        throw err
    }
}

// Describes what node_modules/<name> currently resolves to, without changing
// it. npm creates this symlink itself (from the `file:` dependency) during
// `npm install`; this script never writes under node_modules directly.
function describeNodeModulesLink(name) {
    const linkPath = path.join(ROOT, 'node_modules', name)
    const lst = lstatOrNull(linkPath)
    if (!lst) return 'node_modules/' + name + ': absent (run npm install after staging)'
    if (lst.isSymbolicLink()) return 'node_modules/' + name + ' -> ' + fs.readlinkSync(linkPath)
    return 'node_modules/' + name + ': present but not a symlink'
}

function checkOne(name) {
    const vendorPath = path.join(ROOT, name)
    const lst = lstatOrNull(vendorPath)
    let vendorState
    if (!lst) {
        vendorState = 'absent'
    } else if (lst.isSymbolicLink()) {
        vendorState = 'symlink -> ' + fs.readlinkSync(vendorPath)
    } else if (hasSnapshot(vendorPath)) {
        vendorState = 'staged snapshot (package.json present)'
    } else {
        vendorState = 'empty or debris, no package.json'
    }
    console.log(name + ': ' + vendorState)
    console.log('  ' + describeNodeModulesLink(name))
}

// Stages one sibling. Returns true on success (including "already fine,
// nothing to do"), false when it cannot be staged.
function stageOne(name) {
    const vendorPath = path.join(ROOT, name)
    const siblingPath = path.join(ROOT, '..', name)
    const lst = lstatOrNull(vendorPath)

    if (lst && lst.isSymbolicLink()) {
        console.log(name + ': already a symlink -> ' + fs.readlinkSync(vendorPath) + ', leaving as is')
        return true
    }
    if (lst && lst.isDirectory() && hasSnapshot(vendorPath)) {
        console.log(name + ': holds a staged snapshot (package.json present), leaving it alone')
        return true
    }

    const siblingLst = lstatOrNull(siblingPath)
    if (!siblingLst || !siblingLst.isDirectory()) {
        console.error(name + ': sibling checkout not found at ' + siblingPath + ', cannot stage')
        return false
    }
    if (!hasSnapshot(siblingPath)) {
        console.error(name + ': sibling checkout at ' + siblingPath + ' has no package.json, cannot stage')
        return false
    }

    // Clear debris (an empty dir, or the stray node_modules-only case above)
    // so the symlink can take the path; a real staged snapshot never reaches
    // this line because of the hasSnapshot() check above.
    if (lst) fs.rmSync(vendorPath, { recursive: true, force: true })

    fs.symlinkSync(path.join('..', name), vendorPath, 'dir')
    console.log(name + ': symlinked ' + name + ' -> ../' + name + ' (' + siblingPath + ')')
    return true
}

// Removes only a symlink this script (or an earlier run of it) created.
// Never touches a real directory, staged or not.
function unstageOne(name) {
    const vendorPath = path.join(ROOT, name)
    const lst = lstatOrNull(vendorPath)
    if (!lst) {
        console.log(name + ': absent, nothing to unstage')
        return true
    }
    if (!lst.isSymbolicLink()) {
        console.log(name + ': not a symlink (real directory), leaving it alone')
        return true
    }
    fs.unlinkSync(vendorPath)
    console.log(name + ': removed symlink')
    return true
}

function main(argv) {
    const mode = argv.includes('--unstage') ? 'unstage' : argv.includes('--check') ? 'check' : 'stage'
    let ok = true

    for (const name of SIBLINGS) {
        if (mode === 'check') checkOne(name)
        else if (mode === 'unstage') { if (!unstageOne(name)) ok = false }
        else { if (!stageOne(name)) ok = false }
    }

    if (mode === 'stage' && ok) {
        console.log('')
        console.log('If node_modules/xchain-sdk or node_modules/xchain-hub are absent or stale')
        console.log('(see the lines above), run `npm install` to relink them.')
    }

    return ok
}

module.exports = { main, hasSnapshot, stageOne, unstageOne, checkOne }

if (require.main === module) {
    const ok = main(process.argv.slice(2))
    process.exit(ok ? 0 : 1)
}
