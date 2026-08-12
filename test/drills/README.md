# Physical multi-box byzantine drill

The in-process suite `test/integration/multiHubByzantineF2.integration.test.js`
already proves f=2 at N=7 and f=3 at N=10. Every validator in it shares one
process, one event loop, one `127.0.0.1` and one connection pool, and every
fault is injected by reaching into the victim's memory from the test file. An
auditor is entitled to discount that, and the platform's threat model records
the gap: *"Run at least one physical multi-box byzantine drill (current
N=7/f=2, N=10/f=3 results are in-process)."*

This directory closes the harness half of that gap. It runs the same two scales
with:

- one validator per **OS process**, each with its own hub database, its own P2P
  port and its own signing identity;
- validators spread across **separate boxes**, reached over ssh;
- faults injected **inside the victim's own process**, so the harness never
  touches an honest node's memory;
- outcomes read only out of **each validator's own MariaDB**.

## Layout

| File | Role |
|---|---|
| `lib/drillPlan.js` | Pure topology planner: quorum arithmetic, box assignment, fault placement, and the guards that stop a layout from only looking distributed. |
| `lib/drillVerdict.js` | Pure pass/fail rules. Missing evidence grades INCONCLUSIVE, never PASS. |
| `lib/liveByzantineFaults.js` | Fault injectors that run inside the victim process (crash, active signature forgery, forged proposals). |
| `lib/drillNode.js` | One validator, one process. Configured by environment, driven over stdio. |
| `lib/drillRunner.js` | Spawns validators locally or over ssh and speaks the control protocol. |
| `lib/protocol.js` | The tagged newline-JSON control channel. |
| `physicalByzantine.drill.js` | The drill: phases A to F at N=7 and N=10. |
| `unit/` | Everything above that can be proven without hardware. |

## Phases

| | Phase | What a failure would mean |
|---|---|---|
| A | MESH | The boxes never formed one federation, so nothing after it means anything. |
| B | LIVENESS | f faults stalled the federation: the fault budget is smaller than claimed. |
| C | BOUNDARY | f+1 faults still committed: quorum is not being enforced. |
| D | SAFETY | A forged-digest PRE_PREPARE changed state. |
| E | ACTIVE-BFT | f validators that keep voting with invalid signatures stalled the federation. |
| F | EXCLUSION | f+1 forging validators still committed, which means honest nodes counted signatures that do not verify. |

E and F are the pair that matters. A crashed validator is a strictly weaker
adversary than one that keeps voting garbage; E proves the federation survives
the stronger one, and F proves the forged votes were genuinely discarded rather
than accepted (if they were being counted, F would commit exactly like E). This
is the config-PBFT analogue of the signature-set divergence that graded the N=3
relay-mesh result; `evaluateSignatureExclusion` in `lib/drillVerdict.js` is that older rule, kept
for the cross-chain relay variant where the signer set is stored per round.

## Running the unit tests

No venue, no database, no network:

```
npx mocha --no-config --timeout 90000 --exit 'test/drills/unit/*.test.js'
```

`unit/drillRunner.test.js` spawns real child processes in a no-hub mode. That
mode exists so a harness bug cannot burn a venue window; it models no consensus
whatsoever and the drill refuses to grade a run against it.

## Running the drill

The drill skips unless `XCHAIN_DRILL_HOSTS` is set. Each box needs a
`xchain-hub` checkout with its dependencies installed, a reachable MariaDB, and
a credentials file **on that box** holding `HUB_DB_HOST/PORT/USER/PASS`. The
harness passes the credentials file's *path*, never its contents, so hub
passwords never cross the control channel and never reach a drill log.

```
export XCHAIN_DRILL_HOSTS='[
  {"id":"boxA","ssh":"<user>@boxa.example","advertise":"<boxA routable ip>",
   "hubPath":"<remote hub checkout>","envFile":"<remote credentials file>"},
  {"id":"boxB","ssh":"<user>@boxb.example","advertise":"<boxB routable ip>",
   "hubPath":"<remote hub checkout>","envFile":"<remote credentials file>"}
]'
npx mocha --no-config --timeout 0 --exit test/drills/physicalByzantine.drill.js
```

`advertise` must be the address the **other** boxes dial. Every validator's
P2P port must be open between the boxes.

Optional knobs: `XCHAIN_DRILL_PEER_WAIT_MS`, `XCHAIN_DRILL_APPLY_WAIT_MS`,
`XCHAIN_DRILL_STALL_WAIT_MS`, `XCHAIN_DRILL_LOG_DIR`.

### Single-box shakedown

`XCHAIN_DRILL_ALLOW_SINGLE_HOST=1` runs the whole thing out-of-process on one
box. Useful for validating the hub boot path before spending a multi-box
window. It is not a multi-box result and the planner, the plan summary and the
rendered report all say so.

## What the planner refuses

Two guards exist because a plausible-looking layout can prove nothing:

- **No box may hold quorum-many validators.** If one box can assemble a quorum
  alone, the drill never tests consensus *between* boxes, and a compromised
  host would carry the round by itself.
- **With two or more faults, the faulty set must straddle two or more boxes.**
  Faults concentrated on one box make the run a box-down test wearing a
  byzantine label; it would pass even against an implementation that trusts
  every peer sharing its own host.

The plan also reports `survivesHostLoss`: whether the federation still reaches
quorum after losing any single box. Two boxes at N=7 do not (losing the
4-validator box leaves 3 against a quorum of 5). That is a fact about the
venue, not a defect in the drill, and it is printed so the result is read with
it in view.

## Venue

A true multi-box run needs at least two boxes that can dial each other's P2P
ports. Only one non-production test box is currently reachable, and the
`xchain.io` production hosts are off limits. Until a second drill box exists,
the honest options are a single-box shakedown (labelled as such) or an
operator decision to provision one.
