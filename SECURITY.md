# Security Policy

`xchain-e2e-test` is the end-to-end Mocha test suite that drives all XChain services together against a live (usually regtest) stack. It is internal test tooling, not a deployed or fund-bearing component. That said, we do take security reports seriously: leaked credentials in test fixtures or harness code that could be repurposed against a real deployment are real concerns.

If you've found a security issue, please **do not open a public issue or pull request**. Use the private channels below.

---

## How to report

### Preferred: GitHub Private Vulnerability Reporting

Open a draft advisory at:

<https://github.com/XChain-Platform/xchain-e2e-test/security/advisories/new>

This is the fastest path. The advisory is private until we publish it.

### Alternative: Email

Email **security@dankest.llc** with:

- A description of the issue and the threat it poses.
- Reproduction steps or a proof-of-concept (the test file, fixture, or config that demonstrates the problem).
- The affected version (see `CHANGELOG.md` and the version badge in `README.md`).
- Any patches or mitigations you'd like considered.

For sensitive reports, encrypt the email body to our PGP key. The fingerprint will be published alongside the first signed release artifact; until then, the email channel is acceptable for first contact and we will coordinate an encrypted exchange before you share proof-of-concept details.

We do not currently offer a paid bug bounty. We do offer public credit in release notes and the advisory itself, unless you prefer to remain anonymous.

---

## Response timeline

| Stage | Target |
|---|---|
| Initial acknowledgement | within 72 hours |
| Triage + severity assignment | within 7 days |
| Fix or mitigation in master | within 30 days for high/critical, 90 days for lower severities |
| Coordinated public disclosure | up to 90 days from initial report, or sooner if a fix has shipped and operators are protected |

If we cannot meet a timeline, we will tell you why and propose a new one. We will not silently let a report age.

---

## Scope

### In scope

- Leaked test credentials or fixtures that, if the repository were cloned, would expose real secrets or valid credentials for a deployed stack.
- Test harness code that could be repurposed to attack a real (non-regtest) deployment: for example, a helper that accepts a target URL without sufficient validation, or automation that could be misconfigured to run against mainnet.
- Anything in this repository that, if shipped as part of an `xchain-node` install or similar, weakens the security posture of a production deployment.

### Out of scope

- Protocol or service vulnerabilities that a test happens to surface. If a test reveals a bug in the indexer, decoder, hub, or another service, report the root cause against that service's own repository. The test suite is the messenger, not the source.
- The chains and external coin nodes the suite talks to.
- Misconfiguration of the operator's own regtest stack or `.env` setup.

If you are unsure, send the report anyway and we will tell you whether it falls in scope.

---

## What we ask

- Give us a reasonable window to fix before disclosing publicly. The 90-day ceiling is firm; earlier is fine once a fix has shipped.
- Test concerns against `regtest` where possible. Do not run automated scans against shared XChain infrastructure in a way that would affect availability for other operators.
- Do not access data beyond what is needed to demonstrate the issue.

---

## What we will do

- Confirm receipt within the SLA above.
- Keep you informed as triage and remediation proceed.
- Credit you in the advisory and `CHANGELOG.md` entry, on request.
- Coordinate a CVE assignment when the severity warrants it.
- Publish a post-fix advisory describing the issue, the fix, and the affected version range.

---

## Versions covered

We ship security fixes against the latest release on `master`. Older releases are unsupported. The current version is recorded in `CHANGELOG.md` and the badge in `README.md`.

---

Last reviewed: 2026-06-16.
