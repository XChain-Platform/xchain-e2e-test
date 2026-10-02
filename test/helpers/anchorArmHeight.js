'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// The regtest arm height an anchor suite applies to a gate env variable.
//
// Reads the variable's own value from the environment of the shell running the suite,
// so a rehearsal can arm a gate at a mid-chain height. When the variable is unset or
// unparseable the answer is '0' (armed from genesis), which is what the suites forced
// before the height was configurable.
const ANCHOR_GATE_ENVS = Object.freeze([
    'XC_ANCHOR_FOLD_REGTEST_ACTIVATION',
    'XC_ANCHOR_STAKE_REGTEST_ACTIVATION',
    'XC_ANCHOR_SLASH_REGTEST_ACTIVATION'
])

let capturedArmHeights = null

function armHeight(envName, env = process.env){
    const raw = env[envName]
    if (raw === undefined || raw === null) return '0'
    const s = String(raw).trim().toLowerCase()
    if (/^\d+$/.test(s)) return String(parseInt(s, 10))
    return '0'
}

function applyArmHeight(envName, env = process.env){
    env[envName] = armHeight(envName, env)
    return env[envName]
}

function captureArmHeights(env = process.env){
    capturedArmHeights = Object.fromEntries(
        ANCHOR_GATE_ENVS.map((envName) => [envName, armHeight(envName, env)])
    )
    return Object.assign({}, capturedArmHeights)
}

function applyCapturedArmHeights(env = process.env){
    const heights = capturedArmHeights || captureArmHeights(env)
    for (const envName of ANCHOR_GATE_ENVS) env[envName] = heights[envName]
    return Object.assign({}, heights)
}

module.exports = {
    ANCHOR_GATE_ENVS,
    armHeight,
    applyArmHeight,
    captureArmHeights,
    applyCapturedArmHeights
}
