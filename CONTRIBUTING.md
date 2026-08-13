# Contributing to XChain E2E Test

Thanks for considering a contribution. `xchain-e2e-test` drives the full XChain platform stack against a live regtest deployment, so tests here are the final correctness gate before anything ships.

If you're reporting a security issue, **stop here** and read [`SECURITY.md`](./SECURITY.md) instead. Security reports go through a private channel.

---

## Quick links

- Project overview: [`README.md`](./README.md)
- Full component docs: the [`xchain-documentation`](https://github.com/XChain-Platform/xchain-documentation/tree/master/components/e2e-test) repository (architecture, configuration, operations)
- Disclosure policy: [`SECURITY.md`](./SECURITY.md)
- License: [`LICENSE.md`](./LICENSE.md) + [`NOTICE.md`](./NOTICE.md) (GNU Affero General Public License v3.0, dual-licensed)

---

## Repo layout in 30 seconds

```
xchain-e2e-test/
├── src/                  connectors, helpers, reporters, and shared test utilities
├── test/                 all test suites (unit, integration, e2e, smoke, fuzz, chaos, regression, mutation, perf)
├── scripts/              perf-gate, perf-report, mutation-report utilities
├── CHANGELOG.md          authoritative version history
├── SECURITY.md           private vulnerability disclosure
└── package.json          scripts + dependencies
```

---

## Setting up

### Prerequisites

- **Node.js 22** exactly. The platform pins Node 22 fleet-wide: the `mariadb` driver is ESM-only (Node 18 fails with `ERR_REQUIRE_ESM`), and newer majors are not validated against the stack. Use 22.
- A running **regtest stack**: coin node (`bitcoind` / `litecoind` / `dogecoind`), plus `xchain-decoder`, `xchain-indexer`, `xchain-encoder`, `xchain-utxo-tracker`, `xchain-hub`, and `xchain-regtest-miner`. The easiest path is the `xchain-node` installer pointed at a regtest compose file.
- **MariaDB** reachable from the host for integration and e2e tiers.

### First-time install

```bash
git clone https://github.com/XChain-Platform/xchain-e2e-test.git
cd xchain-e2e-test
npm install
```

Create a `.env` (or let the suite discover config from xchain-hub). See [`README.md`](./README.md) for the full list of env vars. **Never commit a `.env` or any real credential.** Secrets live only in the local `.env`, loaded at runtime; never hard-code them into source, tests, or scripts.

---

## Running it

```bash
npm test    # full action test suite against a live regtest stack (--timeout 0)
```

---

## Tests

The suite is organized into tiers. Pick the tier that matches your change:

| Tier | Command | Needs live stack |
|---|---|---|
| Unit | `npm run test:unit` | No |
| Boundary | `npm run test:boundary` | No |
| Fuzz | `npm run test:fuzz` (`:quick` for 30s) | No |
| Chaos | `npm run test:chaos` | No |
| Regression | `npm run test:regression` (`:p0` = critical only) | No |
| Smoke | `npm run test:smoke` | Yes (connectivity) |
| Integration | `npm run test:integration` | Partial (stubbed + live) |
| E2E meta | `npm run test:e2e` | Yes |
| Security | `npm run test:security` | Yes (regtest) |
| SDK | `npm run test:sdk` | Yes |
| Federation | `npm run test:federation` | Yes (multi-hub) |
| Actions (full) | `npm test` | Yes |
| Mutation | `npm run test:mutate` | No |

Run the no-stack tiers (`test:unit`, `test:boundary`, `test:regression:p0`) before every commit. Before opening a PR, also run `test:smoke` against a regtest stack to confirm connectivity. Add a new test file to the tier that best matches its scope (see existing files in `test/` for naming conventions).

### Adding a test

- **Unit** (`test/unit/`): fast, no I/O, covers connector methods, helpers, and utilities.
- **Integration** (`test/integration/`): stubbed I/O or a short-lived live connection; exercises pipeline wiring.
- **E2E / Actions** (`test/actions/`, `test/e2e/`): real transactions against a live regtest; use `waitFor*` polling helpers and keep teardown clean.
- **Security** (`test/security/`): adversarial inputs and boundary probes; run against regtest, never mainnet.

New tests that introduce `.env`-like fixtures must not commit any real credentials. Use placeholder values and document the required env vars in the test file's top comment.

**Wait on a condition, never on a duration.** A standalone `await sleep(2500)` before an assertion passes or fails on how busy the venue is, and ~100 of them survive here from before this rule. Use `src/db.js`'s `_waitFor(checkFn, criteria, timeMax)` or one of its `waitForX` wrappers, or the poll helpers in `test/helpers/stakeHelper.js`, and carry the old sleep duration over as the timeout budget. For a negative expectation ("assert it was rejected"), do not poll for absence: wait on a positive signal proving the indexer has processed past the relevant point, then assert the negative. A `sleep()` that is the pause between iterations of a loop re-checking a condition is already deterministic and needs no change.

`npm run lint:sleep-flake` (chained into `npm run ci`) counts the standalone fixed-duration sleeps against `scripts/sleep-flake-baseline.json` and fails when the count rises. Converting one to a condition wait puts the count below the baseline; re-run with `--write-baseline` to lower it. The baseline only ever goes down.

---

## Coding style

- **Plain JavaScript**, no TypeScript. Raw parameterized SQL via the `mariadb` driver, no ORM.
- **No linter is configured.** Match the style of the surrounding file: naming, structure, and comment density.
- **Comments are rare on purpose.** Don't restate what well-named code already says. Do comment a *why* that isn't obvious: a hidden invariant, a timing dependency, or a workaround with a reference.
- **Never use the em-dash character** in code, comments, or docs. Rewrite the sentence (a comma, colon, or parentheses) instead.
- **Two trailing spaces** on consecutive bold-label markdown lines so CommonMark renders the line break instead of collapsing them.
- **Never commit credentials.** The suite touches wallet seeds, RPC passwords, and DB credentials. Zero buffers during teardown (the connectors already do this); do not log them.

---

## Commit messages

Match the existing log style: a concise subject line, then a short body explaining what changed and why.

- Branch off `master` and keep history linear (rebase, don't merge).
- One logical change per commit; don't batch unrelated work.
- **No `Co-Authored-By` trailers.** This is a project policy.
- **Never `--no-verify`.** If a hook fails, fix the cause; don't bypass it.

---

## Pull requests

Before opening a PR:

1. Run the no-stack tiers (`npm run test:unit`, `npm run test:regression:p0`) and confirm they pass.
2. Run `npm run test:smoke` against a regtest stack to confirm connectivity.
3. Update `CHANGELOG.md` with a terse entry for your change.
4. Make sure `git status` is clean apart from intended changes (no `node_modules/`, no editor leftovers, no `.env`).
5. Open the PR with a clear title and a description of what changed and why.

For non-security bugs, open an issue at <https://github.com/XChain-Platform/xchain-e2e-test/issues/new>. For security bugs, see [`SECURITY.md`](./SECURITY.md).

---

Last reviewed: 2026-06-16.
