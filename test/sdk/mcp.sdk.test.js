/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * MCP write-path e2e: drives the real `xchain-mcp` stdio server (from
 * the xchain-sdk checkout this repo vendors) against a LIVE regtest
 * stack, over raw newline-delimited JSON-RPC — no MCP client library.
 * Proves, end to end:
 *
 *   1. write tools are NOT listed without XCHAIN_MCP_WIF + _POLICY
 *   2. with both set, submit_action ISSUEs a real token on-chain
 *      (policy-checked sign -> broadcast -> wait-for-indexer), the
 *      result carries the policy evaluation, and the token is then
 *      readable through the public explorer API
 *   3. an action outside allowedActions is refused with a POLICY_*
 *      code before anything is signed
 *
 * The agent key is generated and funded by the harness at runtime and
 * reaches the server ONLY via the child's environment — mirroring the
 * operator contract (key material never transits the tool channel).
 *
 * Venue: requires the standard e2e regtest stack (see initialCheck).
 *
 ********************************************************************/

const os   = require('os');
const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { expect } = require('chai');
const { makeSdk, fundedGasAddress, uniqueTick } = require('./sdkHelper');

const COIN = (typeof global.COIN_CODE !== 'undefined' && global.COIN_CODE) || 'BTC';
const MCP_COIN = 'R' + COIN;                       // regtest prefix, e.g. RBTC

// The vendored file: dependency (container builds) or the sibling
// checkout (host runs) — same resolution order as sdkHelper.loadSDK.
function resolveSdkRoot() {
    const candidates = [
        path.join(__dirname, '../../xchain-sdk'),
        path.join(__dirname, '../../../xchain-sdk'),
    ];
    for (const c of candidates)
        if (fs.existsSync(path.join(c, 'mcp/cli.js'))) return c;
    throw new Error('No xchain-sdk checkout with mcp/cli.js found beside this repo — refresh the vendored clone.');
}

// Minimal stdio MCP client: newline-delimited JSON-RPC over a spawned
// `node mcp/cli.js`, responses matched by id. Deliberately dependency-free
// so this suite exercises the wire protocol the way any MCP host would.
class McpChild {
    constructor(envOverrides) {
        const env = Object.assign({}, process.env, {
            // SDK zero-config env (regtest networks have no public hosts):
            EXPLORER_URL:  process.env.EXPLORER_URL || 'localhost',
            EXPLORER_PORT: String(process.env.EXPLORER_PORT || '18080'),
            ENCODER_URL:   process.env.ENCODER_URL || 'localhost',
            ENCODER_PORT:  String(process.env.ENCODER_API_PORT || process.env.ENCODER_PORT || '3023'),
        }, envOverrides);
        // The read-only instance must not inherit wallet env from the runner.
        if (!envOverrides.XCHAIN_MCP_WIF)    delete env.XCHAIN_MCP_WIF;
        if (!envOverrides.XCHAIN_MCP_POLICY) delete env.XCHAIN_MCP_POLICY;

        this.child = spawn(process.execPath, [path.join(resolveSdkRoot(), 'mcp/cli.js')], {
            env, stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.nextId = 0;
        this.pending = new Map();
        this.stderr = '';
        this.child.stderr.on('data', (d) => { this.stderr += d.toString(); });

        let buf = '';
        this.child.stdout.on('data', (d) => {
            buf += d.toString();
            let nl;
            while ((nl = buf.indexOf('\n')) !== -1) {
                const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
                if (!line.trim()) continue;
                let msg;
                try { msg = JSON.parse(line); } catch { continue; }
                if (msg.id !== undefined && this.pending.has(msg.id)) {
                    const { resolve, reject } = this.pending.get(msg.id);
                    this.pending.delete(msg.id);
                    msg.error ? reject(new Error('MCP error ' + JSON.stringify(msg.error))) : resolve(msg.result);
                }
            }
        });
    }

    request(method, params = {}, timeoutMs = 120000) {
        const id = this.nextId++;
        const p = new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms; stderr: ${this.stderr.slice(-500)}`));
                }
            }, timeoutMs).unref();
        });
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        return p;
    }

    notify(method, params = {}) {
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    }

    async handshake() {
        const res = await this.request('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'xchain-e2e', version: '1.0.0' },
        }, 30000);
        this.notify('notifications/initialized');
        return res;
    }

    async listToolNames() {
        const res = await this.request('tools/list', {}, 30000);
        return (res.tools || []).map((t) => t.name);
    }

    // tools/call -> the server's ok()/fail() envelope: JSON text content.
    async callTool(name, args) {
        const res = await this.request('tools/call', { name, arguments: args });
        const text = res.content && res.content[0] && res.content[0].text;
        return { isError: !!res.isError, body: text ? JSON.parse(text) : null };
    }

    stop() { try { this.child.kill(); } catch { /* already gone */ } }
}

describe(`MCP server write path — stdio submit_action (${MCP_COIN})`, function () {

    let sdk, agent, stateRoot, policyPath;
    const children = [];
    const mkChild = (env) => { const c = new McpChild(env); children.push(c); return c; };

    before(async function () {
        this.timeout(600000);
        sdk = makeSdk();
        stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-e2e-'));

        // Agent key: native-funded + gas-minted so ISSUE can pay the protocol fee.
        agent = await fundedGasAddress(sdk, 1);

        policyPath = path.join(stateRoot, 'policy.json');
        fs.writeFileSync(policyPath, JSON.stringify({
            allowedActions: ['ISSUE'],
            stateFile: path.join(stateRoot, 'usage.json'),
        }));
    });

    after(function () {
        children.forEach((c) => c.stop());
        fs.rmSync(stateRoot, { recursive: true, force: true });
    });

    it('1. without XCHAIN_MCP_WIF/POLICY the write tools are not even listed', async function () {
        this.timeout(60000);
        const child = mkChild({});
        await child.handshake();
        const tools = await child.listToolNames();
        expect(tools).to.include('get_status');
        expect(tools).to.not.include('submit_action');
        expect(tools).to.not.include('get_agent_wallet');
    });

    it('2. with the wallet configured, submit_action ISSUEs a token end-to-end', async function () {
        this.timeout(300000);
        const child = mkChild({ XCHAIN_MCP_WIF: agent.wif, XCHAIN_MCP_POLICY: policyPath });
        await child.handshake();

        const tools = await child.listToolNames();
        expect(tools).to.include('submit_action');
        expect(tools).to.include('get_agent_wallet');

        // The wallet tool reports the env-configured key's address (never the key).
        const wallet = await child.callTool('get_agent_wallet', { coin: MCP_COIN });
        expect(wallet.isError).to.equal(false);
        expect(wallet.body.address).to.equal(agent.address);

        const tick = uniqueTick('MCP');
        const res = await child.callTool('submit_action', {
            coin: MCP_COIN, action: 'ISSUE',
            params: { tick, maxSupply: '21000', decimals: 0, mintSupply: '21000' },
        });
        expect(res.isError, 'submit_action failed: ' + JSON.stringify(res.body)).to.equal(false);
        expect(res.body.txid).to.be.a('string');
        // The result must surface the policy evaluation (budget reasoning).
        expect(res.body.policy).to.be.an('object');
        expect(res.body.policy.action).to.equal('ISSUE');
        expect(res.body.policy.windowUsage).to.be.an('object');

        // Indexed and publicly readable: the token exists with our issuer.
        let token = null;
        for (let i = 0; i < 30 && !token; i++) {
            try {
                const t = await sdk.getToken(tick);
                if (t && t.info && t.info.tick === tick) token = t;
            } catch { /* not indexed yet */ }
            if (!token) await new Promise((r) => setTimeout(r, 2000));
        }
        expect(token, `token ${tick} never became readable via the explorer`).to.not.equal(null);
        expect(token.info.owner, 'token owner must be the agent wallet').to.equal(agent.address);
    });

    it('3. an action outside allowedActions is refused with a POLICY_* code, unsigned', async function () {
        this.timeout(60000);
        const child = mkChild({ XCHAIN_MCP_WIF: agent.wif, XCHAIN_MCP_POLICY: policyPath });
        await child.handshake();
        const res = await child.callTool('submit_action', {
            coin: MCP_COIN, action: 'SEND',
            params: { tick: 'XCHAIN', amount: '1', destination: agent.address },
        });
        expect(res.isError).to.equal(true);
        expect(res.body.code).to.equal('POLICY_ACTION_DENIED');
    });
});
