'use strict'

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const path = require('path')

const REPO_ROOT = path.resolve(__dirname, '../../..')

function resolveDrillKeysDir({ repoRoot = REPO_ROOT } = {}){
    return path.join(repoRoot, 'drill-keys')
}

const DRILL_KEYS_DIR = resolveDrillKeysDir()

module.exports = { DRILL_KEYS_DIR, REPO_ROOT, resolveDrillKeysDir }
