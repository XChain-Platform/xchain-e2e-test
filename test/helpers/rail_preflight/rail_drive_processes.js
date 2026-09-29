'use strict'

const RAIL_DRIVE_ARGS = /^([^ ]*\/)?node [^ ]*mocha[^ ]* .*(bridge_rail_|anchor_fold)/

function processRows (psText) {
    const rows = []
    for (const line of String(psText).split(/\r?\n/)) {
        const threeColumns = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
        if (threeColumns) {
            rows.push({
                pid: Number(threeColumns[1]),
                ppid: Number(threeColumns[2]),
                args: threeColumns[3],
            })
            continue
        }
        const twoColumns = /^\s*(\d+)\s+(.+)$/.exec(line)
        if (twoColumns) rows.push({ pid: Number(twoColumns[1]), ppid: null, args: twoColumns[2] })
    }
    return rows
}

function ancestorPids (psText, pid) {
    const parents = new Map(processRows(psText).map((row) => [row.pid, row.ppid]))
    const ancestors = []
    const seen = new Set()
    let current = Number(pid)
    while (Number.isInteger(current) && current > 0 && !seen.has(current)) {
        ancestors.push(current)
        seen.add(current)
        if (current === 1 || !parents.has(current)) break
        current = parents.get(current)
    }
    return ancestors
}

function otherRailDrives (psText, ownPids) {
    const ignored = new Set([...ownPids].map(Number))
    return processRows(psText)
        .filter((row) => !ignored.has(row.pid) && RAIL_DRIVE_ARGS.test(row.args))
        .map((row) => ({ pid: row.pid, args: row.args }))
}

module.exports = { RAIL_DRIVE_ARGS, ancestorPids, otherRailDrives }
