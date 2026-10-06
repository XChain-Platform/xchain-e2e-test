// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const { referencePattern } = require('./reference-pattern')

const MAX_BUFFER = 64 * 1024 * 1024

function assertDirectory(name, root) {
    if (!path.isAbsolute(root)) {
        throw new Error(`repository root "${name}" must be absolute: ${root}`)
    }

    let stat
    try {
        stat = fs.statSync(root)
    } catch (error) {
        throw new Error(`repository root "${name}" is not an existing directory: ${root}`)
    }

    if (!stat.isDirectory()) {
        throw new Error(`repository root "${name}" is not an existing directory: ${root}`)
    }
}

function sumFileCounts(output) {
    return output.trim().split('\n').reduce((total, line) => {
        if (!line) return total
        const count = Number(line.slice(line.lastIndexOf(':') + 1))
        if (!Number.isInteger(count)) throw new Error(`invalid grep count: ${line}`)
        return total + count
    }, 0)
}

function grepReferences(pattern, root) {
    const args = [
        '-r', '-I', '-E', '-c',
        '--exclude-dir=.git', '--exclude-dir=node_modules',
        pattern, root,
    ]
    const result = spawnSync('grep', args, { encoding: 'utf8', maxBuffer: MAX_BUFFER })

    if (result.error) throw result.error
    if (result.status === 1) return 0
    if (result.status !== 0) {
        const detail = result.stderr.trim() || `exit ${result.status}`
        throw new Error(`grep failed for ${root}: ${detail}`)
    }
    return sumFileCounts(result.stdout)
}

function countReferences(relPath, roots) {
    const pattern = referencePattern(relPath)
    const counts = {}

    for (const [name, root] of Object.entries(roots)) {
        assertDirectory(name, root)
        counts[name] = grepReferences(pattern, root)
    }

    return counts
}

module.exports = { countReferences }
