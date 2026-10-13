'use strict'

const { otherRailDrives, competingDriveForStack } = require('../../../scripts/rail_leg_drive')
const { classifyHubPingResponse } = require('./hub_ping_response')

// A drive on its own isolated stack (ATTEST_MIRROR_STACK_PREFIX set) competes only with
// drives on that same stack, the same scoping scripts/rail_leg_drive.js applies; with no
// prefix every other drive competes, as before.
function checkFullDriveReady ({
    pingStatusCode, pingBodyText, psText, ownPids,
    stackPrefix = process.env.ATTEST_MIRROR_STACK_PREFIX, stackPrefixForPid,
}) {
    const hubReady = classifyHubPingResponse(pingStatusCode, pingBodyText).ok
    const drives = otherRailDrives(psText, ownPids)
    const otherDriveRunning = Boolean(competingDriveForStack(drives, stackPrefix, stackPrefixForPid))

    if (!hubReady && otherDriveRunning) return { ready: false, reason: 'hub+other-drive' }
    if (!hubReady) return { ready: false, reason: 'hub' }
    if (otherDriveRunning) return { ready: false, reason: 'other-drive' }
    return { ready: true, reason: null }
}

module.exports = { checkFullDriveReady }
