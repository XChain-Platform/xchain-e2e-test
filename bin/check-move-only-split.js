#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict'

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const acorn = require('acorn')

const POSITION_FIELDS = new Set(['start', 'end', 'loc', 'range'])

function parseSource(source, file) {
    try {
        return acorn.parse(source, {
            ecmaVersion: 'latest',
            sourceType: 'script',
            allowHashBang: true,
            preserveParens: true,
        })
    } catch (error) {
        error.message = `${file}: ${error.message}`
        throw error
    }
}

function fingerprint(node) {
    return JSON.stringify(node, (key, value) => POSITION_FIELDS.has(key) ? undefined : value)
}

function isUseStrict(statement) {
    return statement.type === 'ExpressionStatement' && statement.directive === 'use strict'
}

function literalString(node) {
    return node && node.type === 'Literal' && typeof node.value === 'string' ? node.value : null
}

function bareRequireTarget(statement) {
    if (statement.type !== 'ExpressionStatement') return null
    const call = statement.expression
    if (!call || call.type !== 'CallExpression' || call.optional || call.arguments.length !== 1) return null
    if (call.callee.type !== 'Identifier' || call.callee.name !== 'require') return null
    return literalString(call.arguments[0])
}

function resolveLoader(fromFile, target, childPaths) {
    if (!target || !target.startsWith('.')) return null
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), target))
    return [resolved, `${resolved}.js`, path.posix.join(resolved, 'index.js')]
        .find((candidate) => childPaths.has(candidate)) || null
}

function walkJsFiles(dir) {
    const files = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, entry.name)
        if (entry.isDirectory()) files.push(...walkJsFiles(absolute))
        else if (entry.isFile() && entry.name.endsWith('.js')) files.push(absolute)
    }
    return files
}

function discoverSplitFiles(repoRoot, filePath) {
    const files = []
    const original = path.join(repoRoot, filePath)
    if (fs.existsSync(original) && fs.statSync(original).isFile()) {
        files.push({ relPath: filePath, source: fs.readFileSync(original, 'utf8') })
    }
    if (filePath.endsWith('.js')) {
        const splitDir = path.join(repoRoot, filePath.slice(0, -3))
        if (fs.existsSync(splitDir) && fs.statSync(splitDir).isDirectory()) {
            for (const absolute of walkJsFiles(splitDir).sort()) {
                const relPath = path.relative(repoRoot, absolute).split(path.sep).join('/')
                files.push({ relPath, source: fs.readFileSync(absolute, 'utf8') })
            }
        }
    }
    return files
}

function readBaseline(repoRoot, base, filePath) {
    try {
        return execFileSync('git', ['show', `${base}:${filePath}`], {
            cwd: repoRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        })
    } catch (error) {
        const detail = String(error.stderr || error.message).trim().split('\n')[0]
        throw new Error(`cannot read ${filePath} at ${base}: ${detail}`)
    }
}

function calleeName(node) {
    if (!node) return null
    if (node.type === 'Identifier') return node.name
    if (node.type !== 'MemberExpression' || node.computed || node.object.type !== 'Identifier') return null
    if (node.object.name !== 'describe' || node.property.type !== 'Identifier') return null
    return node.property.name === 'only' || node.property.name === 'skip' ? `describe.${node.property.name}` : null
}

function suiteTitles(ast) {
    const titles = []
    function visit(value) {
        if (!value || typeof value !== 'object') return
        if (value.type === 'CallExpression') {
            const name = calleeName(value.callee)
            const title = literalString(value.arguments[0])
            if (name && (name === 'describe' || name.startsWith('describe.')) && title !== null) {
                titles.push(`${name}:${title}`)
            }
        }
        for (const [key, child] of Object.entries(value)) {
            if (!POSITION_FIELDS.has(key)) visit(child)
        }
    }
    visit(ast)
    return titles
}

function statementLabel(statement) {
    const required = bareRequireTarget(statement)
    if (required !== null) return `require(${JSON.stringify(required)})`
    if (statement.type === 'FunctionDeclaration') return `function ${statement.id ? statement.id.name : '<anonymous>'}`
    if (statement.type === 'VariableDeclaration') {
        const names = statement.declarations.map((declaration) => declaration.id.name || declaration.id.type)
        return `${statement.kind} ${names.join(', ')}`
    }
    if (statement.type === 'ExpressionStatement' && statement.expression.type === 'CallExpression') {
        const name = calleeName(statement.expression.callee)
        const title = literalString(statement.expression.arguments[0])
        if (name && title !== null) return `${name}(${JSON.stringify(title)})`
    }
    return statement.type
}

function countBy(items, keyOf) {
    const counts = new Map()
    for (const item of items) {
        const key = keyOf(item)
        counts.set(key, (counts.get(key) || 0) + 1)
    }
    return counts
}

function compareCounts(baseline, current, problems, missingMessage, addedMessage) {
    const baselineCounts = countBy(baseline, (entry) => entry.fingerprint)
    const currentCounts = countBy(current, (entry) => entry.fingerprint)
    for (const entry of baseline) {
        const wanted = baselineCounts.get(entry.fingerprint)
        const actual = currentCounts.get(entry.fingerprint) || 0
        if (wanted > actual) {
            problems.push(missingMessage(entry, wanted - actual))
            baselineCounts.set(entry.fingerprint, actual)
        }
    }
    for (const entry of current) {
        const wanted = baselineCounts.get(entry.fingerprint) || 0
        const actual = currentCounts.get(entry.fingerprint)
        if (actual > wanted) {
            problems.push(addedMessage(entry, actual - wanted))
            currentCounts.set(entry.fingerprint, wanted)
        }
    }
}

function parseStatements(source, file) {
    const ast = parseSource(source, file)
    return {
        ast,
        statements: ast.body.filter((statement) => !isUseStrict(statement)),
    }
}

function checkMoveOnlySplit({ repoRoot, base, filePath }) {
    let baseline
    try {
        baseline = parseStatements(readBaseline(repoRoot, base, filePath), `${base}:${filePath}`)
    } catch (error) {
        return { ok: false, problems: [error.message] }
    }

    const files = discoverSplitFiles(repoRoot, filePath)
    if (files.length === 0) {
        return { ok: false, problems: [`no current file or split directory found for ${filePath}`] }
    }

    const childPaths = new Set(files.filter((file) => file.relPath !== filePath).map((file) => file.relPath))
    const current = []
    const currentTitles = []
    const problems = []
    for (const file of files) {
        let parsed
        try {
            parsed = parseStatements(file.source, file.relPath)
        } catch (error) {
            problems.push(`cannot parse ${file.relPath}: ${error.message}`)
            continue
        }
        currentTitles.push(...suiteTitles(parsed.ast).map((title) => ({ fingerprint: title, file: file.relPath })))
        for (const statement of parsed.statements) {
            const loader = file.relPath === filePath
                ? resolveLoader(filePath, bareRequireTarget(statement), childPaths)
                : null
            if (!loader) {
                current.push({ fingerprint: fingerprint(statement), statement, file: file.relPath })
            }
        }
    }

    const baselineStatements = baseline.statements.map((statement) => ({
        fingerprint: fingerprint(statement),
        statement,
        file: `${base}:${filePath}`,
    }))
    const baselineTitles = suiteTitles(baseline.ast).map((title) => ({
        fingerprint: title,
        file: `${base}:${filePath}`,
    }))

    compareCounts(
        baselineTitles,
        currentTitles,
        problems,
        (entry, count) => `suite title missing (${count}): ${entry.fingerprint}`,
        (entry, count) => `suite title added or duplicated (${count}) [${entry.file}]: ${entry.fingerprint}`,
    )
    compareCounts(
        baselineStatements,
        current,
        problems,
        (entry, count) => `statement missing (${count}): ${statementLabel(entry.statement)}`,
        (entry, count) => `statement added or duplicated (${count}) [${entry.file}]: ${statementLabel(entry.statement)}`,
    )

    if (problems.length === 0) {
        const baselineOrder = baselineStatements.map((entry) => entry.fingerprint)
        const currentOrder = current.map((entry) => entry.fingerprint)
        if (baselineOrder.some((value, index) => value !== currentOrder[index])) {
            problems.push('top-level statement order changed')
        }
    }

    return { ok: problems.length === 0, problems }
}

function parseArgs(argv) {
    const options = {}
    const paths = []
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index]
        if (argument === '--base') options.base = argv[++index]
        else if (argument === '--repo-root') options.repoRoot = argv[++index]
        else if (argument === '--help' || argument === '-h') options.help = true
        else paths.push(argument)
    }
    if (!options.help) {
        if (!options.base) throw new Error('--base <ref> is required')
        if (paths.length !== 1) throw new Error(`expected exactly one original test path, got ${paths.length}`)
        options.filePath = paths[0]
    }
    return options
}

function main(argv = process.argv.slice(2)) {
    let options
    try {
        options = parseArgs(argv)
        if (options.help) {
            console.log('Usage: node bin/check-move-only-split.js --base <ref> [--repo-root <dir>] <original-test-file>')
            return 0
        }
        const repoRoot = options.repoRoot ? path.resolve(options.repoRoot) : process.cwd()
        const result = checkMoveOnlySplit({ repoRoot, base: options.base, filePath: options.filePath })
        if (result.ok) {
            console.log(`move-only split holds for ${options.filePath} against ${options.base}`)
            return 0
        }
        console.error(`move-only split failed for ${options.filePath} against ${options.base}`)
        for (const problem of result.problems) console.error(`  ${problem}`)
        return 1
    } catch (error) {
        console.error(error.message)
        return 1
    }
}

if (require.main === module) process.exitCode = main()

module.exports = {
    checkMoveOnlySplit,
    discoverSplitFiles,
    fingerprint,
    main,
    parseArgs,
    parseSource,
    suiteTitles,
}
