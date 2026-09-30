'use strict'

const TICK_SUFFIXES = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

function positiveInteger(value, label){
    const number = Number(value)
    if (!Number.isInteger(number) || number < 1) throw new Error(label + ' must be a positive integer')
    return number
}

function freshInputCount(transactionCount){
    return positiveInteger(transactionCount, 'transactionCount')
}

function spendableInputCount(utxos){
    const seen = new Set()
    for (const row of Array.isArray(utxos) ? utxos : []) {
        if (!row || Number(row.confirmations) <= 0 || !row.txid || row.vout === undefined) continue
        seen.add(String(row.txid) + ':' + String(row.vout))
    }
    return seen.size
}

function policyApplyBudgetMs(chain){
    const name = String(chain).toUpperCase()
    if (name === 'DOGE') return 35 * 60 * 1000
    if (name === 'BTC') return 70 * 60 * 1000
    throw new Error('unsupported policy destination chain ' + chain)
}

function policyTransferMatches(row, expected){
    if (!row || !expected) return false
    const fields = [
        ['src_chain', 'srcChain'],
        ['src_action_index', 'srcActionIndex'],
        ['dest_chain', 'destChain'],
        ['dest_address', 'destAddress'],
        ['tick', 'tick'],
    ]
    return fields.every(([actual, wanted]) => expected[wanted] === undefined ||
        String(row[actual]) === String(expected[wanted]))
}

function expandPolicyTickCandidates(candidates){
    const initial = Array.from(new Set((candidates || []).map(String)))
    if (!initial.length) return []
    const prefix = initial[0].slice(0, -1)
    if (!prefix || !initial.every((tick) => tick.length === initial[0].length && tick.startsWith(prefix))) {
        return initial
    }
    for (const suffix of TICK_SUFFIXES) {
        const tick = prefix + suffix
        if (!initial.includes(tick)) initial.push(tick)
    }
    return initial
}

function dogeFeeSchedule(schedule){
    const destination = schedule && schedule.nativeFeeEnabled === true &&
        typeof schedule.feeDestination === 'string' && schedule.feeDestination.length
        ? schedule.feeDestination : null
    return { ready: !!destination, destination: destination }
}

function joinAppliedPolicyRows(settlements, mirrored){
    const bySnapshot = new Map()
    for (const row of Array.isArray(mirrored) ? mirrored : []) {
        if (row && row.snapshot_id !== undefined) bySnapshot.set(String(row.snapshot_id), row)
    }
    return (Array.isArray(settlements) ? settlements : []).flatMap((settlement) => {
        const snapshotId = String(settlement.transfer_id)
        const row = bySnapshot.get(snapshotId)
        if (!row) return []
        return [{ snapshotId: snapshotId, block: Number(settlement.block_index),
            actionIndex: Number(settlement.action_index), seq: Number(row.policy_seq),
            hash: row.policy_hash ? String(row.policy_hash) : null,
            sleeping: row.sleeping === undefined ? null : Number(row.sleeping) }]
    }).sort((a, b) => a.seq - b.seq)
}

function appliedPolicyMatch(rows, target){
    const wanted = target || {}
    return (Array.isArray(rows) ? rows : []).find((row) =>
        Number(row.seq) >= Number(wanted.minSeq) &&
        (wanted.snapshotId === undefined || String(row.snapshotId) === String(wanted.snapshotId))) || null
}

module.exports = {
    appliedPolicyMatch,
    dogeFeeSchedule,
    expandPolicyTickCandidates,
    freshInputCount,
    joinAppliedPolicyRows,
    policyApplyBudgetMs,
    policyTransferMatches,
    spendableInputCount,
}
