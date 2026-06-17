# Maintainers

This file lists the people responsible for `xchain-e2e-test`, what each of them owns, and how to escalate issues that need a human's attention beyond what `CONTRIBUTING.md` and `SECURITY.md` cover.

`xchain-e2e-test` is the internal end-to-end test suite for the XChain Platform. It is not a production service; it exists to drive and verify the full platform stack in regtest and live environments. The XChain Platform is in pre-launch development and ships under a single primary maintainer today. As contributors take on durable responsibility for areas of the codebase, they will be added here. This is a conventional MAINTAINERS file (an open-source norm used by distros and downstream packagers), not an aspirational org chart.

---

## Primary maintainer

| Role | Name | GitHub | Areas |
|---|---|---|---|
| Lead | J-Dog | [@J-Dog](https://github.com/J-Dog) | Everything: the end-to-end test suite and its harness |

Contact:

- General and non-sensitive: open an issue at <https://github.com/XChain-platform/xchain-e2e-test/issues>.
- Code of Conduct: `conduct@dankest.llc` (per `CODE_OF_CONDUCT.md`).
- Security disclosures: GitHub Private Vulnerability Reporting, or `security@dankest.llc` (per `SECURITY.md`).

---

## Areas of responsibility

Until additional maintainers join, the lead owns every area below. The table is here so a future contributor (or downstream packager) can see what each area entails when scoping a contribution.

| Area | What it covers |
|---|---|
| Action tests (`test/actions`) | Per-ACTION end-to-end suites: ISSUE, SEND, MINT, DESTROY, ORDER, DISPENSER, SWAP, DIVIDEND, AIRDROP, FILE, MESSAGE, BROADCAST, ADDRESS, LINK, LIST, CALLBACK, BATCH, SWEEP, SLEEP, COINPAY, STAKE, DEPLOY, EXECUTE, DEPOSIT, WITHDRAW |
| SDK tests (`test/sdk`) | SDK-driven suites: action generation via `xchain-sdk`, template exercising (AMM, escrow, chunked deploy), `sdk.submitAction` harness |
| Federation tests (`test/federation`) | Anchor acceptance and election flows, attestation signer wiring, multi-hub attestation, quorum boundary scenarios |
| Security tests (`test/security`) | VM sandbox attack probes, deploy-reject tests, VM access restrictions, and adversarial harness cases |
| Integration tests (`test/integration`) | Bootstrap flow, pipeline wiring, database polling, error propagation, wallet/UTXO cache; stubbed I/O (no live services required) |
| Harness and helper fixtures | Connector classes in `src/` (BlockchainConnector, XChainIndexerConnector, XChainHubConnector, etc.), cryptoHelper, transactionHelper, polling utilities, the `test/helpers/` and `test/fixtures/` layers |
| Regtest driving setup | Multi-chain regtest configuration, the gas-seed bootstrap, regtest miner integration, `.env` and hub-discovery wiring |
| Additional test tiers | Unit, smoke, boundary, fuzz, chaos, regression, mutation (Stryker), and performance suites |
| Documentation | `README`, `SECURITY`, `CODE_OF_CONDUCT`, `CONTRIBUTING`, `MAINTAINERS`, `CHANGELOG` |

---

## Adding a maintainer

A contributor becomes a maintainer when they have:

1. Sustained contribution in a specific area for at least one release cycle (typically 2 to 3 weeks of active work).
2. Reviewed and merged at least three PRs from outside contributors.
3. Demonstrated awareness of the project's conventions: harness tests run against a live regtest stack (never mocked at the transport layer), raw parameterized SQL for database polling assertions, the `Keep a Changelog` format, and Node 22 as the pinned runtime.

Open a PR adding the new maintainer to the table above with their GitHub handle and area(s) of responsibility. The lead approves and merges.

## Removing a maintainer

A maintainer steps down by opening a PR removing their row. The lead also removes a maintainer who has been inactive for six months or who violates the Code of Conduct, after a written notice period.

---

## Escalation paths

If you cannot reach the relevant area maintainer within a reasonable window:

| Situation | Escalate to |
|---|---|
| Active security incident | `security@dankest.llc` (per `SECURITY.md`) |
| Leaked test credentials or fixtures, or harness code repurposable against a live stack | Email `security@dankest.llc` |
| Code-of-conduct concern | `conduct@dankest.llc` (per `CODE_OF_CONDUCT.md`) |
| PR has been open without review for 14+ days | Comment `@J-Dog` on the PR; if no response within 7 more days, open an issue tagged `governance` with the PR link |

---

## Decision-making

The lead makes final calls on:

- Harness architecture and which tiers gate merges or releases.
- Which test tiers run in CI and what failure thresholds apply.
- Test conventions (polling timeouts, assertion strategy, multi-chain parity requirements).
- Adopting a new heavy dependency.
- Code-of-conduct enforcement, and maintainer additions or removals.

Smaller calls (new test cases, additions within an existing tier, documentation, dependency bumps inside an existing minor) go through PR review by the area maintainer.

---

## Cross-project relationships

| Project | Relationship |
|---|---|
| [`xchain-decoder`](https://github.com/XChain-platform/xchain-decoder) | The suite verifies decoded transaction state written by the decoder |
| [`xchain-indexer`](https://github.com/XChain-platform/xchain-indexer) | Database polling assertions verify indexer-produced records; failures often point here |
| [`xchain-hub`](https://github.com/XChain-platform/xchain-hub) | Used for service endpoint discovery and federation/attestation tests |
| [`xchain-explorer`](https://github.com/XChain-platform/xchain-explorer) | Exercised via the XChainExplorerConnector across action and SDK suites |
| [`xchain-encoder`](https://github.com/XChain-platform/xchain-encoder) | Constructs every XChain transaction broadcast by the harness |
| [`xchain-sdk`](https://github.com/XChain-platform/xchain-sdk) | Drives the `test/sdk` suite via `sdk.submitAction` |
| [`xchain-vm`](https://github.com/XChain-platform/xchain-vm) | Exercised through the security and contract-execution test cases |
| [`xchain-documentation`](https://github.com/XChain-platform/xchain-documentation) | Authoritative source for expected behavior that the suite encodes as assertions |
| [`xchain-regtest-miner`](https://github.com/XChain-platform/xchain-regtest-miner) | Required by the live-stack test tiers to mine blocks during action tests |

The e2e-test maintainer is not automatically a maintainer of those sibling projects. When a test failure points to a defect in another service, the fix goes through that service's own review process.
