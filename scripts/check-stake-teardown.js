#!/usr/bin/env node
/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * Untracked-stake gate.
 *
 * A fixture STAKE is not scratch state: it joins the venue's REAL capability
 * sets, and nothing took one back out until this gate existed. On the shared BTC
 * regtest that grew oracle_publish from 18 members to 61 and pushed the
 * operator hub's weight share from 69.9% down to 9.1%, which is a checkpoint
 * quorum that can no longer be reached. Every run passed while it happened.
 *
 * The release is automatic for stakes created through test/helpers/stakeHelper
 * (sendStakeV1 / sendStakeV2 / sendStakeV3), which register them with
 * test/helpers/stakeTeardown so the root afterAll can give them back. A suite
 * that hand-builds its own `STAKE|...` payload and broadcasts it directly
 * bypasses that ledger, and the leak comes straight back with nobody watching.
 *
 * So every raw STAKE broadcast under test/ must do ONE of:
 *
 *   - go through stakeHelper, which registers the stake for release
 *   - register it itself (a stakeTeardown.registerStake call in the same file)
 *   - say why this one never becomes a member, on the payload's own line or in
 *     the comment block directly above it:
 *         // stake-teardown-ok: <reason>
 *
 * The reason is a sentence, not a pragma, because the distinction that matters
 * is a judgement: an intentionally-REJECTED stake (amount 0, a malformed
 * pubkey, a pubkey already delegated) never enters any capability set and owes
 * the venue nothing, while a valid one that merely looks incidental is exactly
 * the stake that accumulated 43 orphans.
 *
 * Usage:  node scripts/check-stake-teardown.js [--list]
 *
 ********************************************************************/

'use strict'

const fs   = require('fs')
const path = require('path')

const ROOT     = path.join(__dirname, '..')
const SCAN_DIR = path.join(ROOT, 'test')

// test/unit/ never touches a venue: its STAKE payloads are the unit coverage OF
// the helpers, asserted as strings, not broadcasts.
const SKIP_DIRS = new Set(['node_modules', 'unit', 'codec'])

// The one file allowed to build STAKE payloads raw: it is the registrar.
const REGISTRAR = path.join('test', 'helpers', 'stakeHelper.js')

// A STAKE payload literal: "STAKE|1|... , 'STAKE|3|... . Version-agnostic on
// purpose, so a STAKE v4 is caught the day it is written.
const STAKE_PAYLOAD = /['"]STAKE\|\d/
const OPT_OUT       = /\/\/\s*stake-teardown-ok:\s*\S/
const REGISTERS     = /stakeTeardown\.registerStake\s*\(/

function walk(dir, acc){
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })){
        if (entry.isDirectory()){
            if (SKIP_DIRS.has(entry.name)) continue
            walk(path.join(dir, entry.name), acc)
        } else if (entry.name.endsWith('.js')){
            acc.push(path.join(dir, entry.name))
        }
    }
    return acc
}

function scanLines(lines, rel){
    if (rel === REGISTRAR || rel === REGISTRAR.split(path.sep).join('/')) return []
    const fileRegisters = lines.some((l) => REGISTERS.test(l))
    const hits = []
    lines.forEach((line, idx) => {
        if (!STAKE_PAYLOAD.test(line)) return
        // A comment quoting a payload is not a broadcast.
        if (/^\s*(?:\/\/|\*)/.test(line)) return
        if (OPT_OUT.test(line)) return
        let opted = false
        for (let k = idx - 1; k >= 0 && /^\s*(?:\/\/|\*)/.test(lines[k]); k--){
            if (OPT_OUT.test(lines[k])) { opted = true; break }
        }
        if (opted) return
        // The file books its own debt, so the ledger sees these stakes.
        if (fileRegisters) return
        hits.push({ file: rel, line: idx + 1, text: line.trim() })
    })
    return hits
}

function scanFile(file){
    return scanLines(
        fs.readFileSync(file, 'utf8').split('\n'),
        path.relative(ROOT, file).split(path.sep).join('/'),
    )
}

function scan(){
    const hits = []
    for (const f of walk(SCAN_DIR, []).sort()) hits.push(...scanFile(f))
    return hits
}

function main(){
    const hits = scan()

    if (process.argv.includes('--list'))
        hits.forEach((h) => console.log(`${h.file}:${h.line}  ${h.text}`))

    if (!hits.length){
        console.log('stake-teardown: every STAKE broadcast under test/ is tracked for release, or says why it need not be.')
        return 0
    }

    console.error(`stake-teardown: ${hits.length} STAKE broadcast(s) bypass the release ledger:`)
    hits.forEach((h) => console.error(`  ${h.file}:${h.line}  ${h.text}`))
    console.error('A stake nothing registers is a stake nothing gives back, and the shared venue keeps it')
    console.error('in its capability set for good.')
    console.error('Fix a site by staking through test/helpers/stakeHelper, or by calling')
    console.error('stakeTeardown.registerStake() for the stake you broadcast. If this stake can never')
    console.error('become a capability member, say why on its own line or the one above:')
    console.error('    // stake-teardown-ok: <reason>')
    return 1
}

module.exports = { scan, scanFile, scanLines }

if (require.main === module) process.exit(main())
