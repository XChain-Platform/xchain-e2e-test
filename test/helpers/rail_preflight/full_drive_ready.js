'use strict'

const { otherRailDrives } = require('../../../scripts/rail_leg_drive')
const { classifyHubPingResponse } = require('./hub_ping_response')

function checkFullDriveReady ({ pingStatusCode, pingBodyText, psText, ownPids }) {
    const hubReady = classifyHubPingResponse(pingStatusCode, pingBodyText).ok
    const otherDriveRunning = otherRailDrives(psText, ownPids).length > 0

    if (!hubReady && otherDriveRunning) return { ready: false, reason: 'hub+other-drive' }
    if (!hubReady) return { ready: false, reason: 'hub' }
    if (otherDriveRunning) return { ready: false, reason: 'other-drive' }
    return { ready: true, reason: null }
}

module.exports = { checkFullDriveReady }
