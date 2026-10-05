'use strict'

const DB_PREFIX = 'XChain_AM_MVH_'
const STAMPED_NAME = /^(\d+)_([0-9a-z]+)_(?:Hub|(?:Rpl_)?Ixr|Mirror)\d+$/
const UNSTAMPED_NAME = /^(?:Ixr|Mirror)\d+$/

function compareNumericText(left, right, radix) {
    const base = BigInt(radix)
    const value = (text) => Array.from(text).reduce(
        (total, digit) => total * base + BigInt(parseInt(digit, radix)), 0n)
    const a = value(left)
    const b = value(right)
    return a < b ? -1 : a > b ? 1 : 0
}

function compareStamps(left, right) {
    return compareNumericText(left.time, right.time, 36) ||
        compareNumericText(left.pid, right.pid, 10)
}

function staleStampedDbs(names, label) {
    const familyPrefix = DB_PREFIX + label + '_'
    const stamped = new Map()
    const unstamped = []

    for (const name of names) {
        if (!name.startsWith(familyPrefix)) continue
        const tail = name.slice(familyPrefix.length)
        const match = tail.match(STAMPED_NAME)
        if (!match) {
            if (UNSTAMPED_NAME.test(tail)) unstamped.push(name)
            continue
        }
        const stamp = match[1] + '_' + match[2]
        if (!stamped.has(stamp)) stamped.set(stamp, { pid: match[1], time: match[2], names: [] })
        stamped.get(stamp).names.push(name)
    }

    const stamps = Array.from(stamped.entries()).sort((a, b) => compareStamps(a[1], b[1]))
    const latestStamp = stamps.length === 0 ? null : stamps[stamps.length - 1][0]
    const current = latestStamp === null ? [] : stamped.get(latestStamp).names.slice().sort()
    const stale = stamps.slice(0, -1).flatMap((entry) => entry[1].names).sort()
    return { latestStamp, stale, current, unstamped: unstamped.sort() }
}

module.exports = { DB_PREFIX, staleStampedDbs }
