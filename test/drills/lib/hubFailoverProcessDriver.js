'use strict'

const assert = require('assert')
const { spawn } = require('child_process')

const MAX_OUTPUT_BYTES = 1024 * 1024

function parseArgs (raw) {
    if (!raw) return []
    const parsed = JSON.parse(raw)
    assert.ok(Array.isArray(parsed) && parsed.every((value) => typeof value === 'string'),
        'XCHAIN_HUB_FAILOVER_DRIVER_ARGS must be a JSON array of strings')
    return parsed
}

class HubFailoverProcessDriver {
    constructor (command, args, options) {
        assert.ok(typeof command === 'string' && command.trim(), 'driver command is required')
        this.command = command
        this.args = args || []
        this.cwd = options && options.cwd
        this.env = (options && options.env) || process.env
        this.timeoutMs = (options && options.timeoutMs) || 180000
    }

    call (operation, args) {
        const childArgs = [...this.args, operation, ...(args || []).map(String)]
        return new Promise((resolve, reject) => {
            const child = spawn(this.command, childArgs, {
                cwd: this.cwd,
                env: this.env,
                stdio: ['ignore', 'pipe', 'pipe'],
            })
            let stdout = ''
            let stderr = ''
            let settled = false
            const timer = setTimeout(() => {
                if (settled) return
                settled = true
                child.kill('SIGTERM')
                reject(new Error('hub-failover driver timed out running ' + operation))
            }, this.timeoutMs)

            function append (current, chunk) {
                const next = current + chunk.toString('utf8')
                if (Buffer.byteLength(next) > MAX_OUTPUT_BYTES)
                    throw new Error('hub-failover driver output exceeded ' + MAX_OUTPUT_BYTES + ' bytes')
                return next
            }

            child.stdout.on('data', (chunk) => {
                try { stdout = append(stdout, chunk) } catch (error) { child.kill('SIGTERM'); reject(error) }
            })
            child.stderr.on('data', (chunk) => {
                try { stderr = append(stderr, chunk) } catch (error) { child.kill('SIGTERM'); reject(error) }
            })
            child.once('error', (error) => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                reject(error)
            })
            child.once('exit', (code, signal) => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                if (code !== 0) {
                    reject(new Error('hub-failover driver ' + operation + ' failed (' +
                        (signal || 'exit ' + code) + '): ' + stderr.trim()))
                    return
                }
                const lines = stdout.trim().split(/\r?\n/).filter(Boolean)
                if (lines.length !== 1) {
                    reject(new Error('hub-failover driver ' + operation +
                        ' must print exactly one JSON line, got ' + lines.length))
                    return
                }
                try { resolve(JSON.parse(lines[0])) } catch (error) {
                    reject(new Error('hub-failover driver ' + operation + ' returned invalid JSON: ' + error.message))
                }
            })
        })
    }

    observe () { return this.call('observe') }
    stopHub (id) { return this.call('stop-hub', [id]) }
    queueReport () { return this.call('queue-report') }
    mine (blocks) { return this.call('mine', [blocks]) }
    startHub (id) { return this.call('start-hub', [id]) }
    blockHashes (indexerId, height) { return this.call('block-hashes', [indexerId, height]) }
}

module.exports = { MAX_OUTPUT_BYTES, parseArgs, HubFailoverProcessDriver }
