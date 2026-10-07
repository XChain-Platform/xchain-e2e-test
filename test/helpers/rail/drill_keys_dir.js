'use strict'

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const fs = require('fs')
const path = require('path')

const REPO_ROOT = path.resolve(__dirname, '../../..')

function gitDirForCheckout(repoRoot, fsImpl){
    const marker = path.join(repoRoot, '.git')
    let stat
    try { stat = fsImpl.statSync(marker) } catch (e) { return null }
    if (stat.isDirectory()) return marker

    let text
    try { text = String(fsImpl.readFileSync(marker, 'utf8')).trim() } catch (e) { return null }
    const match = text.match(/^gitdir:\s*(.+)$/i)
    return match ? path.resolve(repoRoot, match[1]) : null
}

function commonGitDir(gitDir, fsImpl){
    const marker = path.join(gitDir, 'commondir')
    let text
    try { text = String(fsImpl.readFileSync(marker, 'utf8')).trim() } catch (e) { return gitDir }
    return text ? path.resolve(gitDir, text) : gitDir
}

// Linked worktrees share one Git common directory with the primary checkout.
// Keep recovery keys beside that primary checkout so deleting a lane cannot
// delete the only keys for funds or stakes the lane left on a shared rail.
function resolveDrillKeysDir({ repoRoot = REPO_ROOT, fs: fsImpl = fs } = {}){
    const gitDir = gitDirForCheckout(repoRoot, fsImpl)
    if (!gitDir) return path.join(repoRoot, 'drill-keys')

    const commonDir = commonGitDir(gitDir, fsImpl)
    if (path.basename(commonDir) !== '.git') return path.join(repoRoot, 'drill-keys')
    return path.join(path.dirname(commonDir), 'drill-keys')
}

const DRILL_KEYS_DIR = resolveDrillKeysDir()

module.exports = { DRILL_KEYS_DIR, REPO_ROOT, resolveDrillKeysDir }
