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
 * So does an SDK-tier suite that submits `{ action: 'STAKE', params }` and lets
 * the SDK build the payload: the gate counts that object key as a STAKE site
 * too, while a comparison such as `tx.action === 'STAKE'` stays a read.
 *
 * So every raw or SDK-form STAKE broadcast under test/ must do ONE of:
 *
 *   - go through stakeHelper, which registers the stake for release
 *   - register it itself (a stakeTeardown.registerStake call in the same file,
 *     one live call per unmarked raw broadcast the file makes)
 *   - say why this one never becomes a member, on the payload's own line or in
 *     the comment block directly above it:
 *         // stake-teardown-ok: <reason>
 *     The same marker covers a stake on a FIXED key that a declared dedicated
 *     staking venue keeps seated (the XCALL relay hub key): one key can seat
 *     once, so it cannot accumulate, and releasing it would leave the venue's
 *     own hub unseated.
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
const { MIN_REASON_WORDS, optOutMarker } = require('./lib/opt_out_marker')

const ROOT     = path.join(__dirname, '..')
const SCAN_DIR = path.join(ROOT, 'test')

// Skip node_modules at any depth; it is vendored code, not a suite.
const SKIP_ANYWHERE = new Set(['node_modules'])

// Skip only the top-level test/unit (helper coverage asserting STAKE payloads as
// strings) and test/codec (offline round-trips); a nested unit/ or codec/ IS scanned.
const SKIP_TOP_LEVEL = new Set(['unit', 'codec'])

// The one file allowed to build STAKE payloads raw: it is the registrar.
const REGISTRAR = path.join('test', 'helpers', 'stakeHelper.js')

const COMMENT_LINE  = /^\s*(?:\/\/|\*)/
const UNKNOWN       = '\u0000'
const NON_STAKE_BUILDERS = new Set([
    'issueCmd', 'issueBindWire', 'issueMessage', 'lockWireV0', 'lockWireV3', 'burnWireV1',
    'buildAttestationResponseAction', 'responseWire',
])
const NON_STAKE_OPAQUE_PAYLOADS = new Map([
    ['test/actions/controller_policy.test.js', new Set(['wire'])],
    ['test/actions/nft_parity.test.js', new Set(['wire'])],
    ['test/federation/llm_attestation.test.js', new Set(['wirePayload'])],
    ['test/federation/multi_hub_attestation.test.js', new Set(['wirePayload'])],
    ['test/federation/multi_hub_llm_attestation.test.js', new Set(['wirePayload'])],
    ['test/federation/multi_hub_llm_outage.test.js', new Set(['wirePayload'])],
    ['test/federation/multi_hub_node_proof.test.js', new Set(['wirePayload'])],
    ['test/helpers/envelopeHelper.js', new Set(['action'])],
    ['test/helpers/oracleBatchDrive.js', new Set(['wire'])],
    ['test/helpers/oracleBatchVenue.js', new Set(['wire'])],
    ['test/helpers/rollcall_helper/chain_driving.js', new Set(['payload'])],
    ['test/integration/bridge_rail_base.test/support/index.js', new Set(['wire'])],
    ['test/integration/bridge_rail_list_share.test/07_at7_hub_stopped.test.js', new Set(['wire'])],
    ['test/integration/bridge_rail_list_share.test/support/index.js', new Set(['wire'])],
    ['test/integration/bridge_rail_policy.test/support/policy.js', new Set(['wire'])],
    ['test/integration/bridge_rail_token.test/support/token.js', new Set(['wire'])],
    ['test/rail/custody_guard/withdraw.test.js', new Set(['wire'])],
])

// Accept a marker only when its reason is a sentence (shared rule, see scripts/lib).
const hasOptOut = optOutMarker('stake-teardown-ok')

function isSkippedDir(name, dir, root){
    return SKIP_ANYWHERE.has(name) || (dir === root && SKIP_TOP_LEVEL.has(name))
}

function walk(dir, acc, root = dir){
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })){
        if (entry.isDirectory()){
            if (isSkippedDir(entry.name, dir, root)) continue
            walk(path.join(dir, entry.name), acc, root)
        } else if (entry.name.endsWith('.js')){
            acc.push(path.join(dir, entry.name))
        }
    }
    return acc
}

// Accept a marker on the payload's own line or in the comment block directly above it.
function optedOut(lines, idx){
    if (hasOptOut(lines[idx])) return true
    for (let k = idx - 1; k >= 0 && COMMENT_LINE.test(lines[k]); k--){
        if (hasOptOut(lines[k])) return true
    }
    return false
}

function quotedToken(source, start, quote, line){
    let i = start + 1, value = '', tokenLine = line
    while (i < source.length){
        if (source[i] === quote) return { end: i + 1, line: tokenLine, value }
        if (source[i] === '\n') tokenLine++
        if (source[i] === '\\' && i + 1 < source.length){
            const escaped = source[i + 1]
            const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' }
            if (simple[escaped] !== undefined) value += simple[escaped]
            else if (escaped === 'x' && /^[0-9a-f]{2}$/i.test(source.slice(i + 2, i + 4))){
                value += String.fromCharCode(parseInt(source.slice(i + 2, i + 4), 16)); i += 2
            } else if (escaped === 'u' && /^[0-9a-f]{4}$/i.test(source.slice(i + 2, i + 6))){
                value += String.fromCharCode(parseInt(source.slice(i + 2, i + 6), 16)); i += 4
            } else value += escaped
            i += 2
            continue
        }
        value += source[i++]
    }
    return { end: i, line: tokenLine, value }
}

function templateToken(source, start, line){
    let i = start + 1, raw = '', tokenLine = line
    while (i < source.length){
        if (source[i] === '`'){
            const value = raw.replace(/\$\{[\s\S]*?\}/g, UNKNOWN)
            return { end: i + 1, line: tokenLine, value }
        }
        if (source[i] === '\n') tokenLine++
        if (source[i] === '\\' && i + 1 < source.length){
            raw += source[i] + source[i + 1]
            i += 2
        } else raw += source[i++]
    }
    return { end: i, line: tokenLine, value: raw }
}

// A deliberately small lexer is enough here and keeps this gate runnable before
// npm install. It removes comments and makes newlines irrelevant to expressions.
function tokensFor(source){
    const tokens = []
    let i = 0, line = 1
    while (i < source.length){
        if (/\s/.test(source[i])){
            if (source[i++] === '\n') line++
            continue
        }
        if (source.slice(i, i + 2) === '//'){
            while (i < source.length && source[i] !== '\n') i++
            continue
        }
        if (source.slice(i, i + 2) === '/*'){
            i += 2
            while (i < source.length && source.slice(i, i + 2) !== '*/'){
                if (source[i++] === '\n') line++
            }
            i += source.slice(i, i + 2) === '*/' ? 2 : 0
            continue
        }
        const start = i
        if (source[i] === "'" || source[i] === '"'){
            const parsed = quotedToken(source, i, source[i], line)
            tokens.push({ type: 'string', value: parsed.value, line, endLine: parsed.line, start })
            i = parsed.end; line = parsed.line
            continue
        }
        if (source[i] === '`'){
            const parsed = templateToken(source, i, line)
            tokens.push({ type: 'template', value: parsed.value, line, endLine: parsed.line, start })
            i = parsed.end; line = parsed.line
            continue
        }
        const identifier = /^[A-Za-z_$][\w$]*/.exec(source.slice(i))
        if (identifier){
            tokens.push({ type: 'identifier', value: identifier[0], line, endLine: line, start })
            i += identifier[0].length
            continue
        }
        const operator = /^(?:===|!==|=>|==|!=|<=|>=|\+\+|--|&&|\|\||\?\?|\+=|-=|\*\*|\?\.)/.exec(source.slice(i))
        const value = operator ? operator[0] : source[i]
        tokens.push({ type: 'punctuator', value, line, endLine: line, start })
        i += value.length
    }
    return tokens
}

function matching(tokens, start, open, close){
    let depth = 0
    for (let i = start; i < tokens.length; i++){
        if (tokens[i].value === open) depth++
        if (tokens[i].value === close && --depth === 0) return i
    }
    return -1
}

function expressionEnd(tokens, start){
    const opens = { '(': ')', '[': ']', '{': '}' }, closes = new Set(Object.values(opens))
    const stack = []
    const continues = new Set(['+', '-', '*', '/', '%', '&&', '||', '??', '?', ':', '.', '?.', ',', '='])
    for (let i = start; i < tokens.length; i++){
        const value = tokens[i].value
        if (opens[value]) stack.push(opens[value])
        else if (closes.has(value)){
            if (!stack.length) return i
            if (stack[stack.length - 1] === value) stack.pop()
        }
        if (!stack.length && (value === ';' || value === ',')) return i
        const next = tokens[i + 1]
        if (!stack.length && next && next.line > tokens[i].endLine &&
            !continues.has(value) && !continues.has(next.value) && next.value !== '(' && next.value !== '[')
            return i + 1
    }
    return tokens.length
}

function bindingMap(tokens){
    const bindings = new Map()
    for (let i = 0; i + 3 < tokens.length; i++){
        if (!['const', 'let', 'var'].includes(tokens[i].value) ||
            tokens[i + 1].type !== 'identifier' || tokens[i + 2].value !== '=') continue
        bindings.set(tokens[i + 1].value, { start: i + 3, end: expressionEnd(tokens, i + 3) })
    }
    return bindings
}

function stripParens(tokens, start, end){
    while (tokens[start] && tokens[start].value === '(' && matching(tokens, start, '(', ')') === end - 1){
        start++; end--
    }
    return { start, end }
}

function splitTopLevel(tokens, start, end, delimiter){
    const parts = [], stack = []
    const pairs = { '(': ')', '[': ']', '{': '}' }
    let partStart = start
    for (let i = start; i < end; i++){
        if (pairs[tokens[i].value]) stack.push(pairs[tokens[i].value])
        else if (stack[stack.length - 1] === tokens[i].value) stack.pop()
        else if (!stack.length && tokens[i].value === delimiter){
            parts.push({ start: partStart, end: i }); partStart = i + 1
        }
    }
    parts.push({ start: partStart, end })
    return parts
}

function expressionValue(tokens, bindings, start, end, seen = new Set()){
    ({ start, end } = stripParens(tokens, start, end))
    if (start >= end) return UNKNOWN
    const sums = splitTopLevel(tokens, start, end, '+')
    if (sums.length > 1) return sums.map((p) => expressionValue(tokens, bindings, p.start, p.end, seen)).join('')
    if (end === start + 1){
        const token = tokens[start]
        if (token.type === 'string' || token.type === 'template') return token.value
        if (token.type === 'identifier' && bindings.has(token.value) && !seen.has(token.value)){
            const nextSeen = new Set(seen); nextSeen.add(token.value)
            const bound = bindings.get(token.value)
            return expressionValue(tokens, bindings, bound.start, bound.end, nextSeen)
        }
        return UNKNOWN
    }
    if (tokens[start].value === '['){
        const close = matching(tokens, start, '[', ']')
        if (close > start && close + 4 < end && tokens[close + 1].value === '.' &&
            tokens[close + 2].value === 'join' && tokens[close + 3].value === '('){
            const callClose = matching(tokens, close + 3, '(', ')')
            if (callClose === end - 1){
                const separator = expressionValue(tokens, bindings, close + 4, callClose, seen)
                return splitTopLevel(tokens, start + 1, close, ',')
                    .map((p) => expressionValue(tokens, bindings, p.start, p.end, seen)).join(separator)
            }
        }
    }
    return UNKNOWN
}

function isStake(value){
    return value === 'STAKE' || /^STAKE(?:\u0000)*\|/.test(value)
}

function originFor(tokens, bindings, start, end, seen = new Set()){
    ({ start, end } = stripParens(tokens, start, end))
    if (end === start + 1 && tokens[start].type === 'identifier' && bindings.has(tokens[start].value) &&
        !seen.has(tokens[start].value)){
        const nextSeen = new Set(seen); nextSeen.add(tokens[start].value)
        const bound = bindings.get(tokens[start].value)
        return originFor(tokens, bindings, bound.start, bound.end, nextSeen)
    }
    for (let i = start; i < end; i++){
        const token = tokens[i]
        if ((token.type === 'string' || token.type === 'template') &&
            (token.value.startsWith('STAKE') || token.value === 'ST')) return token
        if (token.type === 'identifier' && bindings.has(token.value) && !seen.has(token.value) &&
            expressionValue(tokens, bindings, bindings.get(token.value).start, bindings.get(token.value).end) === 'STAKE'){
            const bound = bindings.get(token.value)
            return originFor(tokens, bindings, bound.start, bound.end, new Set([...seen, token.value]))
        }
    }
    return tokens[start]
}

function joinedStake(tokens, bindings, start){
    const close = matching(tokens, start, '[', ']')
    if (close < 0 || tokens[close + 1]?.value !== '.' || tokens[close + 2]?.value !== 'join' ||
        tokens[close + 3]?.value !== '(') return null
    const callClose = matching(tokens, close + 3, '(', ')')
    if (callClose < 0) return null
    const separator = expressionValue(tokens, bindings, close + 4, callClose)
    if (separator !== '|') return null
    for (const part of splitTopLevel(tokens, start + 1, close, ',')){
        if (expressionValue(tokens, bindings, part.start, part.end) === 'STAKE')
            return originFor(tokens, bindings, part.start, part.end)
    }
    return null
}

function calledBuilder(tokens, bindings, start, end, seen = new Set()){
    ({ start, end } = stripParens(tokens, start, end))
    if (end === start + 1 && tokens[start]?.type === 'identifier' && bindings.has(tokens[start].value) &&
        !seen.has(tokens[start].value)){
        const nextSeen = new Set(seen); nextSeen.add(tokens[start].value)
        const bound = bindings.get(tokens[start].value)
        return calledBuilder(tokens, bindings, bound.start, bound.end, nextSeen)
    }
    let open = start
    while (tokens[open] && tokens[open].value !== '(') open++
    if (open === start || matching(tokens, open, '(', ')') !== end - 1) return null
    for (let i = start; i < open; i++){
        if (tokens[i].type !== 'identifier' && tokens[i].value !== '.' && tokens[i].value !== '?.') return null
    }
    return tokens[open - 1].type === 'identifier' ? tokens[open - 1].value : null
}

function isStakeHelperBuilt(tokens, bindings, start, end, seen = new Set()){
    ({ start, end } = stripParens(tokens, start, end))
    if (end === start + 1 && tokens[start]?.type === 'identifier' && bindings.has(tokens[start].value) &&
        !seen.has(tokens[start].value)){
        const nextSeen = new Set(seen); nextSeen.add(tokens[start].value)
        const bound = bindings.get(tokens[start].value)
        return isStakeHelperBuilt(tokens, bindings, bound.start, bound.end, nextSeen)
    }
    let open = start
    while (tokens[open] && tokens[open].value !== '(') open++
    if (open === start || matching(tokens, open, '(', ')') !== end - 1) return false
    return tokens.slice(start, open).some((token) => token.type === 'identifier' && token.value === 'stakeHelper')
}

function isKnownNonStakePayload(tokens, rel, start, end){
    ({ start, end } = stripParens(tokens, start, end))
    if (tokens[start]?.value === '{') return rel === 'test/regression/transaction.regression.js'
    if (end !== start + 1 || tokens[start]?.type !== 'identifier') return false
    return NON_STAKE_OPAQUE_PAYLOADS.get(rel)?.has(tokens[start].value) || false
}

function registrationCount(tokens){
    let count = 0
    for (let i = 0; i + 3 < tokens.length; i++){
        if (tokens[i].value === 'stakeTeardown' && tokens[i + 1].value === '.' &&
            tokens[i + 2].value === 'registerStake' && tokens[i + 3].value === '(') count++
    }
    return count
}

// Return the value span of an object-literal `action:` key, else null (the `:` after a key is not a comparison).
function actionValueSpan(tokens, i){
    const key = tokens[i]
    if (key.value !== 'action' || (key.type !== 'identifier' && key.type !== 'string')) return null
    if (tokens[i + 1]?.value !== ':' || !['{', ','].includes(tokens[i - 1]?.value)) return null
    return { start: i + 2, end: expressionEnd(tokens, i + 2) }
}

function scanLines(lines, rel){
    if (rel === REGISTRAR || rel === REGISTRAR.split(path.sep).join('/')) return []
    const tokens = tokensFor(lines.join('\n'))
    const bindings = bindingMap(tokens)
    const sitesByLine = new Map()
    const add = (token) => {
        if (!token || COMMENT_LINE.test(lines[token.line - 1]) || optedOut(lines, token.line - 1)) return
        sitesByLine.set(token.line, { file: rel, line: token.line, text: lines[token.line - 1].trim() })
    }

    for (const bound of bindings.values()){
        if (isStake(expressionValue(tokens, bindings, bound.start, bound.end)))
            add(originFor(tokens, bindings, bound.start, bound.end))
    }
    for (let i = 0; i < tokens.length; i++){
        const token = tokens[i]
        if ((token.type === 'string' || token.type === 'template') && token.value !== 'STAKE' && isStake(token.value)) add(token)
        if (token.value === '[') add(joinedStake(tokens, bindings, i))
        const action = actionValueSpan(tokens, i)
        if (action && expressionValue(tokens, bindings, action.start, action.end) === 'STAKE')
            add(originFor(tokens, bindings, action.start, action.end))
        if (token.value !== 'createAndSendTransaction' || tokens[i + 1]?.value !== '(') continue
        const close = matching(tokens, i + 1, '(', ')')
        if (close < 0) continue
        const args = splitTopLevel(tokens, i + 2, close, ',')
        if (args.length < 2) continue
        const payload = args[1]
        const value = expressionValue(tokens, bindings, payload.start, payload.end)
        if (isStake(value))
            add(originFor(tokens, bindings, payload.start, payload.end))
        else if (tokens[payload.start]?.value === '[')
            add(joinedStake(tokens, bindings, payload.start))
        else if (value === UNKNOWN &&
            !isStakeHelperBuilt(tokens, bindings, payload.start, payload.end) &&
            !isKnownNonStakePayload(tokens, rel, payload.start, payload.end)){
            const builder = calledBuilder(tokens, bindings, payload.start, payload.end)
            if (!builder || !NON_STAKE_BUILDERS.has(builder))
                add(originFor(tokens, bindings, payload.start, payload.end))
        }
    }

    const sites = [...sitesByLine.values()].sort((a, b) => a.line - b.line)
    // One registration books one broadcast. A static scan cannot pair them, so a
    // shortfall flags every unmarked site in the file.
    return sites.length > registrationCount(tokens) ? sites : []
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
    console.error('become a capability member, say why on its own line or the one above,')
    console.error('in a reason of at least ' + MIN_REASON_WORDS + ' words on the marker line:')
    console.error('    // stake-teardown-ok: <reason>')
    return 1
}

module.exports = { scan, scanFile, scanLines, walk, hasOptOut }

if (require.main === module) process.exit(main())
