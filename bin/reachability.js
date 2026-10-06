#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lists every src/*.js that no runtime path inside this repo reaches, and checks
// the recorded sweep evidence in bin/pins/dead-code-sweep.txt against the live
// platform. A file with no caller here is only a candidate for deletion: other
// repositories can require it by path, so the evidence block pins the revision
// of all 22 repositories each candidate was counted against.
//
//   node bin/reachability.js                summary and candidates
//   node bin/reachability.js --json         full report, evidence verified
//   node bin/reachability.js --write        rewrite the evidence block
//   node bin/reachability.js --no-evidence  skip the evidence check
//
// Repositories absent from the platform root are read from temporary clones of
// the origin organisation, removed on exit.

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const { countReferences } = require('./count-references')

const REPO_ROOT = path.resolve(__dirname, '..')
const PLATFORM_ROOT = path.resolve(REPO_ROOT, '..')
const PIN_FILE = path.join(__dirname, 'pins', 'dead-code-sweep.txt')
const BEGIN = 'EVIDENCE_JSON_BEGIN'
const END = 'EVIDENCE_JSON_END'

const ROSTER = [
    '.github', 'server-monitor', 'xchain-contracts', 'xchain-dashboard', 'xchain-decoder',
    'xchain-documentation', 'xchain-e2e-test', 'xchain-encoder', 'xchain-explorer',
    'xchain-explorer-archived', 'xchain-hub', 'xchain-indexer', 'xchain-node',
    'xchain-platform-ai', 'xchain-regtest-miner', 'xchain-reviews', 'xchain-sdk', 'xchain-sync',
    'xchain-utxo-tracker', 'xchain-vm', 'xchain-wallet', 'xchain-websites',
]

const REQUIRE_LITERAL = /require\(\s*(['"])([^'"]+)\1\s*\)/g
const IMPORT_LITERAL = /(?:from|import)\s*\(?\s*(['"])(\.[^'"]*)\1/g

function git(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()
}

function trackedFiles() {
    return git(REPO_ROOT, ['ls-files', '-z']).split('\0').filter(Boolean)
}

function resolveSpec(fromRel, spec, fileSet) {
    if (!spec.startsWith('.')) return null
    const base = path.posix.join(path.posix.dirname(fromRel), spec)
    const found = [base, `${base}.js`, `${base}/index.js`].find((c) => fileSet.has(c))
    return found || null
}

function edgesFrom(rel, fileSet) {
    let text
    try { text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8') } catch (e) { return [] }
    const out = new Set()
    for (const re of [REQUIRE_LITERAL, IMPORT_LITERAL]) {
        re.lastIndex = 0
        let m
        while ((m = re.exec(text)) !== null) {
            const target = resolveSpec(rel, m[2], fileSet)
            if (target) out.add(target)
        }
    }
    return Array.from(out)
}

function closure(entries, fileSet) {
    const seen = new Set()
    const stack = entries.filter((e) => fileSet.has(e))
    while (stack.length) {
        const cur = stack.pop()
        if (seen.has(cur)) continue
        seen.add(cur)
        for (const next of edgesFrom(cur, fileSet)) if (!seen.has(next)) stack.push(next)
    }
    return seen
}

function scriptEntries(fileSet) {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
    const entries = new Set()
    if (pkg.main) entries.add(pkg.main.replace(/^\.\//, ''))
    for (const command of Object.values(pkg.scripts || {})) {
        const tokens = command.split(/\s+/)
        tokens.forEach((token, i) => {
            if (token !== 'node') return
            const arg = tokens.slice(i + 1).find((t) => !t.startsWith('-'))
            const rel = (arg || '').replace(/^['"]|['"]$/g, '').replace(/^\.\//, '')
            if (rel.endsWith('.js') && fileSet.has(rel)) entries.add(rel)
        })
    }
    return Array.from(entries)
}

/** Runtime roots are the package entry and the files npm scripts run with node; a file only tests, bin/ or scripts/ reach is a candidate. */
function analyse() {
    const fileSet = new Set(trackedFiles().filter((f) => f.endsWith('.js') || f.endsWith('.mjs')))
    const sources = Array.from(fileSet).filter((f) => f.startsWith('src/')).sort()
    const entries = scriptEntries(fileSet).sort()
    const reached = closure(entries, fileSet)
    const candidates = sources.filter((f) => !reached.has(f))
    return {
        summary: {
            sourceFiles: sources.length,
            entryPoints: entries.length,
            reachable: sources.length - candidates.length,
            unreachable: candidates.length,
        },
        candidates,
    }
}

function cloneUrl(name) {
    const origin = git(REPO_ROOT, ['remote', 'get-url', 'origin'])
    return origin.replace(/[^/:]+$/, `${name}.git`)
}

function localCheckout(name) {
    const dir = path.join(PLATFORM_ROOT, name)
    return fs.existsSync(path.join(dir, '.git')) ? dir : null
}

/** Maps every roster name to a readable checkout, cloning the absent ones into `tmp`. */
function resolveCheckouts(tmp) {
    const dirs = {}
    for (const name of ROSTER) {
        const local = localCheckout(name)
        if (local) { dirs[name] = { dir: local, local: true }; continue }
        const dir = path.join(tmp, name)
        execFileSync('git', ['clone', '--quiet', '--filter=blob:none', cloneUrl(name), dir], {
            stdio: 'ignore', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        })
        dirs[name] = { dir, local: false }
    }
    return dirs
}

function isAncestor(dir, sha) {
    try {
        execFileSync('git', ['-C', dir, 'merge-base', '--is-ancestor', sha, 'HEAD'], { stdio: 'ignore' })
        return true
    } catch (e) {
        return false
    }
}

function readEvidence() {
    const text = fs.readFileSync(PIN_FILE, 'utf8')
    const start = text.indexOf(`${BEGIN}\n`)
    const stop = text.indexOf(`\n${END}`)
    if (start < 0 || stop < 0) throw new Error('no evidence json block')
    return { text, start: start + BEGIN.length + 1, stop, evidence: JSON.parse(text.slice(start + BEGIN.length + 1, stop)) }
}

function validateEvidence(evidence, checkouts, candidates) {
    const revs = evidence.revisions || {}
    for (const name of ROSTER) {
        if (!/^[0-9a-f]{40}$/.test(revs[name] || '')) throw new Error(`revision for ${name} is missing or not a 40-hex sha`)
        if (!isAncestor(checkouts[name].dir, revs[name])) {
            throw new Error(`revision for ${name} is not in the history of its checkout: ${revs[name]}`)
        }
    }
    const listed = (evidence.candidates || []).map((c) => c.path)
    const missing = candidates.filter((c) => !listed.includes(c))
    const stale = listed.filter((c) => !candidates.includes(c))
    if (missing.length || stale.length) {
        throw new Error(`recorded candidates differ from the walk: missing ${missing.join(', ') || 'none'}, stale ${stale.join(', ') || 'none'}`)
    }
    for (const c of evidence.candidates) {
        const absent = ROSTER.filter((name) => !(name in (c.repositoryLineMatches || {})))
        if (absent.length) throw new Error(`candidate ${c.path} missing repos: ${absent.join(', ')}`)
    }
}

function buildEvidence(checkouts, candidates) {
    const revisions = {}
    const roots = {}
    for (const name of ROSTER) {
        revisions[name] = git(checkouts[name].dir, ['rev-parse', 'HEAD'])
        roots[name] = checkouts[name].dir
    }
    const entries = candidates.map((rel) => ({ path: rel, repositoryLineMatches: countReferences(rel, roots) }))
    return { revisions, candidates: entries }
}

function writeEvidence(evidence) {
    const body = JSON.stringify(evidence, null, 2)
    const head = [
        'xchain-e2e-test dead-code sweep',
        '===============================',
        '',
        'Candidates are src/ files that no package entry or node-run npm script reaches',
        'through a literal require or import. Nothing is deleted from this record: each',
        'candidate carries the per-repository reference counts taken at the pinned revisions.',
        '',
    ].join('\n')
    fs.mkdirSync(path.dirname(PIN_FILE), { recursive: true })
    fs.writeFileSync(PIN_FILE, `${head}\n${BEGIN}\n${body}\n${END}\n`)
}

function main() {
    const args = process.argv.slice(2)
    const report = analyse()
    let tmp = null
    try {
        if (!args.includes('--no-evidence')) {
            tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-'))
            const checkouts = resolveCheckouts(tmp)
            if (args.includes('--write')) writeEvidence(buildEvidence(checkouts, report.candidates))
            validateEvidence(readEvidence().evidence, checkouts, report.candidates)
            report.evidenceVerified = true
        }
    } finally {
        if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
    }
    if (args.includes('--json')) {
        console.log(JSON.stringify(report, null, 2))
        return
    }
    for (const [key, value] of Object.entries(report.summary)) console.log(`${key.padEnd(14)} ${value}`)
    for (const rel of report.candidates) console.log(`  ${rel}`)
}

if (require.main === module) main()

module.exports = { analyse, closure, validateEvidence, ROSTER }
