'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Which ref each sibling checkout in .github/workflows/ci.yml resolves to,
// driven the way the runner resolves it: the expression is READ OUT OF THE
// WORKFLOW and evaluated here, so a copy of the rule cannot drift away from the
// rule the venue runs.
//
// The case this exists for: on a pull_request event github.ref is
// refs/pull/<n>/merge, never refs/heads/master, so an expression that decides
// "is this master?" from github.ref alone sends a master-BOUND pull request to
// the sibling's develop. That is the only kind of pull request this workflow
// runs (`on.pull_request.branches` is [master]), and the suites here reach
// sibling SOURCE at require time, so the whole PR lane was grading a release
// against unreleased sibling code. xchain-documentation carried the same
// expression and hit it on PR 44, whose citations resolve differently on the
// sibling's two branches.
//
// Every checkout step that names a `repository:` is covered, not just the one
// that was noticed, because the next sibling added here will be copy-pasted
// from an existing one.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const WORKFLOW = path.join(__dirname, '..', '..', '..', '.github', 'workflows', 'ci.yml');

/* ------------------------------------------------------------------ *
 * A GitHub Actions expression evaluator, over the subset ci.yml uses.
 * Anything outside that subset throws rather than guessing, so a future
 * expression this cannot actually evaluate fails loudly here instead of
 * being graded against a wrong answer.
 * ------------------------------------------------------------------ */

// A single-quoted string literal, which GitHub escapes by doubling the quote.
// Returns the value and the index just past the closing quote.
function readStringLiteral(src, start) {
    let j = start + 1;
    let s = '';
    for (;;) {
        if (j >= src.length) throw new Error('unterminated string literal');
        if (src[j] === "'" && src[j + 1] === "'") { s += "'"; j += 2; continue; }
        if (src[j] === "'") break;
        s += src[j++];
    }
    return { value: s, next: j + 1 };
}

function tokenize(src) {
    const out = [];
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (/\s/.test(c)) { i++; continue; }
        if (c === "'") {
            const lit = readStringLiteral(src, i);
            out.push({ kind: 'string', value: lit.value });
            i = lit.next;
            continue;
        }
        const two = src.slice(i, i + 2);
        if (two === '&&' || two === '||' || two === '==' || two === '!=') {
            out.push({ kind: 'op', value: two });
            i += 2;
            continue;
        }
        if (c === '(' || c === ')' || c === ',') { out.push({ kind: c }); i++; continue; }
        const word = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(src.slice(i));
        if (word) { out.push({ kind: 'word', value: word[0] }); i += word[0].length; continue; }
        const num = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i));
        if (num) { out.push({ kind: 'number', value: Number(num[0]) }); i += num[0].length; continue; }
        throw new Error('unsupported character in expression: ' + JSON.stringify(c));
    }
    return out;
}

// GitHub's falsy set: empty string, 0, false, null. Everything else is truthy.
function truthy(v) {
    if (v === null || v === undefined) return false;
    if (typeof v === 'string') return v !== '';
    if (typeof v === 'number') return v !== 0;
    return v !== false;
}

// A context property that is not set for the event (github.base_ref on a push)
// reaches the expression as null and casts to the empty string.
function asString(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    return String(v);
}

// GitHub compares strings case-insensitively.
function equals(a, b) {
    if (typeof a === 'string' || typeof b === 'string') {
        return asString(a).toLowerCase() === asString(b).toLowerCase();
    }
    return a === b;
}

const FUNCTIONS = {
    startswith: (s, p) => asString(s).toLowerCase().startsWith(asString(p).toLowerCase()),
    endswith:   (s, p) => asString(s).toLowerCase().endsWith(asString(p).toLowerCase()),
    contains:   (s, p) => asString(s).toLowerCase().includes(asString(p).toLowerCase()),
};

/* The parser is a cursor over the token list plus the context it resolves
 * names against. Each grammar rule below takes that cursor, so the grammar
 * reads as named steps rather than one closure. */
const peek = (p) => p.tokens[p.pos];
const take = (p) => p.tokens[p.pos++];

// A dotted context path. An unmodelled property THROWS rather than resolving to
// undefined: a silent undefined would be falsy and would quietly send the whole
// expression down its fallback arm, which is a wrong answer dressed as a pass.
function lookup(context, dotted) {
    let node = context;
    for (const part of dotted.split('.')) {
        if (node === null || node === undefined || !(part in node)) {
            throw new Error('expression reads an unmodelled context property: ' + dotted);
        }
        node = node[part];
    }
    return node;
}

function parseCallArgs(p) {
    const args = [];
    if (peek(p) && peek(p).kind !== ')') {
        args.push(parseOr(p));
        while (peek(p) && peek(p).kind === ',') { take(p); args.push(parseOr(p)); }
    }
    const close = take(p);
    if (!close || close.kind !== ')') throw new Error('missing closing parenthesis');
    return args;
}

// A bare word is a literal, a function call, or a context lookup.
function parseWord(p, t) {
    if (peek(p) && peek(p).kind === '(') {
        take(p);
        const args = parseCallArgs(p);
        const fn = FUNCTIONS[t.value.toLowerCase()];
        if (!fn) throw new Error('unsupported expression function: ' + t.value);
        return fn(...args);
    }
    if (t.value === 'true') return true;
    if (t.value === 'false') return false;
    if (t.value === 'null') return null;
    return lookup(p.context, t.value);
}

function parsePrimary(p) {
    const t = take(p);
    if (!t) throw new Error('expression ended early');
    if (t.kind === 'string' || t.kind === 'number') return t.value;
    if (t.kind === '(') {
        const v = parseOr(p);
        const close = take(p);
        if (!close || close.kind !== ')') throw new Error('missing closing parenthesis');
        return v;
    }
    if (t.kind === 'word') return parseWord(p, t);
    throw new Error('unexpected token: ' + JSON.stringify(t));
}

function parseCmp(p) {
    let left = parsePrimary(p);
    while (peek(p) && peek(p).kind === 'op' && (peek(p).value === '==' || peek(p).value === '!=')) {
        const op = take(p).value;
        const right = parsePrimary(p);
        left = op === '==' ? equals(left, right) : !equals(left, right);
    }
    return left;
}

// && and || yield an OPERAND, not a boolean: `a && b` is b when a is truthy and
// a otherwise, which is what makes the ternary idiom in ci.yml work at all.
function parseAnd(p) {
    let left = parseCmp(p);
    while (peek(p) && peek(p).kind === 'op' && peek(p).value === '&&') {
        take(p);
        const right = parseCmp(p);
        left = truthy(left) ? right : left;
    }
    return left;
}

function parseOr(p) {
    let left = parseAnd(p);
    while (peek(p) && peek(p).kind === 'op' && peek(p).value === '||') {
        take(p);
        const right = parseAnd(p);
        left = truthy(left) ? left : right;
    }
    return left;
}

function evaluate(expression, context) {
    const p = { tokens: tokenize(expression), pos: 0, context };
    const value = parseOr(p);
    if (p.pos !== p.tokens.length) throw new Error('trailing tokens in expression');
    return value;
}

/* ------------------------------------------------------------------ *
 * Reading the workflow.
 * ------------------------------------------------------------------ */

// Every `- name:`/`- uses:` step in the file, as raw text blocks. A hand parser
// rather than a YAML dependency: this tier is hermetic on purpose, and the shape
// being read is a handful of keys under `with:`.
function stepBlocks(text) {
    const steps = [];
    let current = null;
    for (const line of text.split('\n')) {
        if (/^\s*-\s+(name|uses):/.test(line)) {
            if (current) steps.push(current);
            current = [];
        }
        if (current) current.push(line);
    }
    if (current) steps.push(current);
    return steps.map((block) => block.join('\n'));
}

function checkoutStepsWithARepository() {
    const blocks = stepBlocks(fs.readFileSync(WORKFLOW, 'utf8'));
    return blocks.filter((text) => {
        return /uses:\s*actions\/checkout@/.test(text) && /^\s*repository:\s*\S/m.test(text);
    }).map((text) => {
        const repository = /^\s*repository:\s*(\S+)\s*$/m.exec(text);
        const ref  = /^\s*ref:\s*\$\{\{(.+)\}\}\s*$/m.exec(text);
        const name = /^\s*-\s+name:\s*(.+)$/m.exec(text);
        return {
            name: name ? name[1].trim() : '(unnamed)',
            repository: repository[1],
            refExpression: ref ? ref[1].trim() : null,
        };
    });
}

// github.ref on a pull_request event is the MERGE ref, which is the whole point:
// it never equals refs/heads/<base>, so nothing about the base can be read off it.
function pullRequestContext(headRef, baseRef) {
    return { github: { event_name: 'pull_request', ref: 'refs/pull/44/merge', head_ref: headRef, base_ref: baseRef } };
}

function pushContext(branch) {
    return { github: { event_name: 'push', ref: 'refs/heads/' + branch, head_ref: null, base_ref: null } };
}

describe('ci.yml sibling checkout ref resolution', () => {

    const steps = checkoutStepsWithARepository();

    it('the workflow still checks out siblings by an expression', () => {
        assert.ok(steps.length > 0, 'no actions/checkout step with a repository: was found in ' + WORKFLOW);
        // The hub sibling is required at require time by multiValidatorHubHelper,
        // so losing it would take the unit tier down rather than narrow it.
        assert.ok(
            steps.some((s) => s.repository === 'XChain-Platform/xchain-hub'),
            'the xchain-hub sibling checkout is gone; the unit tier cannot load',
        );
        for (const step of steps) {
            assert.ok(step.refExpression, 'sibling checkout "' + step.name + '" pins no ref: expression');
        }
    });

    steps.forEach((step, index) => {
        describe(step.repository + ' (step ' + index + ': ' + step.name + ')', () => {

            const resolve = (context) => evaluate(step.refExpression, context);

            it('a pull request into master reads the sibling master', () => {
                // The regression. `on:` admits no other PR base, so this is the
                // resolution EVERY pull request on this repo gets.
                assert.strictEqual(resolve(pullRequestContext('hotfix-lane', 'master')), 'master');
            });

            it('a release head reads its own release branch', () => {
                assert.strictEqual(resolve(pullRequestContext('release/v0.19.1', 'master')), 'release/v0.19.1');
            });

            it('a push to master reads the sibling master', () => {
                assert.strictEqual(resolve(pushContext('master')), 'master');
            });

            it('a push to develop reads the sibling develop', () => {
                assert.strictEqual(resolve(pushContext('develop')), 'develop');
            });

            it('anything else reads the sibling develop', () => {
                assert.strictEqual(resolve(pushContext('some-lane-branch')), 'develop');
                assert.strictEqual(resolve(pullRequestContext('some-lane-branch', 'develop')), 'develop');
            });
        });
    });
});

describe('the expression evaluator these assertions are made with', () => {

    // The evaluator is the instrument. If it scored every expression 'master'
    // the cases above would agree with each other and prove nothing.
    const ctx = { github: { ref: 'refs/heads/develop', head_ref: 'lane', base_ref: 'master' } };

    it('&& and || return an operand, the way GitHub does', () => {
        assert.strictEqual(evaluate("true && 'a' || 'b'", ctx), 'a');
        assert.strictEqual(evaluate("false && 'a' || 'b'", ctx), 'b');
        assert.strictEqual(evaluate("'' || 'fallback'", ctx), 'fallback');
    });

    it('a ref test that reads github.ref alone cannot see a pull request base', () => {
        // The defective shape, scored by this same instrument: it is what made the
        // fix necessary, and it must come out DEVELOP here or the fix proves nothing.
        const old = "github.ref == 'refs/heads/master' && 'master' || 'develop'";
        assert.strictEqual(evaluate(old, pullRequestContext('hotfix-lane', 'master')), 'develop');
        assert.strictEqual(evaluate(old, pushContext('master')), 'master');
    });

    it('startsWith and equality are case-insensitive string casts', () => {
        assert.strictEqual(evaluate("startsWith(github.head_ref, 'LA')", ctx), true);
        assert.strictEqual(evaluate("startsWith(github.head_ref, 'release/')", ctx), false);
        assert.strictEqual(evaluate("github.base_ref == 'MASTER'", ctx), true);
    });

    it('an unset context property casts to the empty string, not a crash', () => {
        assert.strictEqual(evaluate("startsWith(github.base_ref, 'release/')", pushContext('master')), false);
        assert.strictEqual(evaluate("github.base_ref == 'master'", pushContext('master')), false);
    });

    it('an unmodelled property or an unknown function throws instead of guessing', () => {
        assert.throws(() => evaluate('github.actor', ctx), /unmodelled context property/);
        assert.throws(() => evaluate("fromJSON('{}')", ctx), /unsupported expression function/);
    });
});
