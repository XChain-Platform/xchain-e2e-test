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
    const match = text.match(/^gitdir:\s*(.+)$/im)
    return match ? path.resolve(repoRoot, match[1].trim()) : null
}

function commonGitDir(gitDir, fsImpl){
    let text
    try { text = String(fsImpl.readFileSync(path.join(gitDir, 'commondir'), 'utf8')).trim() } catch (e) { return gitDir }
    return text ? path.resolve(gitDir, text) : gitDir
}

// Worktree lanes keep keys beside the main checkout, so removing a lane cannot orphan its stakers.
function resolveDrillKeysDir({ repoRoot = REPO_ROOT, fs: fsImpl = fs } = {}){
    const gitDir = gitDirForCheckout(repoRoot, fsImpl)
    if (!gitDir) return path.join(repoRoot, 'drill-keys')

    const commonDir = commonGitDir(gitDir, fsImpl)
    if (path.basename(commonDir) !== '.git') return path.join(repoRoot, 'drill-keys')
    return path.join(path.dirname(commonDir), 'drill-keys')
}

const DRILL_KEYS_DIR = resolveDrillKeysDir()

module.exports = { DRILL_KEYS_DIR, REPO_ROOT, resolveDrillKeysDir }
