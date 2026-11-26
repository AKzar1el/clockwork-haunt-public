# Clockwork Haunt

**Rehearse tomorrow’s failures before they happen.**

A deterministic simulator of scheduled agent workflows, built for the
Kiroween 2026 Frankenstein category. Rehearse late inputs, missed deadlines
and duplicate outputs before changing a real workflow.

## Status

Try the [public demo](https://akzar1el.github.io/clockwork-haunt-public/) or
view the [published source](https://github.com/AKzar1el/clockwork-haunt-public).
The demo follows its published revision and may not match newer source.
Clockwork Haunt uses fictional data and one simulated clock independent of
your local time zone. It does not run live jobs or connect to production
workflows.

## Who it helps

If you maintain an overnight dashboard or batch report, a green status alone
doesn't tell you whether the report used current data. Start with the same
synthetic incident under two policies, find the arrival where waiting misses
the deadline, and attach the exported JSON to a discussion about the trade-off.
The verifier can reconstruct the exact result from that fixture.

This is a rehearsal tool with fixed examples and a configurable arrival
minute. It does not import your data, monitor jobs, or recommend a universal
freshness policy.
Once the page has loaded, the simulation and JSON download do not require
network access. Loading the hosted page itself requires a connection.

## Reproduce one decision

With the [local build](#development) open, choose **Compare two policies on
the same incident** and then **Show freshness trade-off**. At an 08:12
collector arrival, running on schedule finishes at 08:08 with prior-window
data; waiting finishes at 08:14 with fresh data.

Select **Show cutoff miss**. The fresh window arrives at 08:14, but the
earliest possible finish is 08:16, after the 08:15 cutoff. Use
**Export comparison JSON** to see that the waiting policy observed the
artifact even though the report never started and therefore never read it.

## Included

- Four browser replay scenarios: on-time input, late input, waiting for fresh input, and duplicate effects.
- In the waiting scenario, **Input is already too old** shows how the requested window can exist without meeting freshness policy.
- Selectable presets, shareable replay URLs, a deterministic timeline, and a versioned JSON evidence download with replay inputs.
- A side-by-side policy lab with a movable collector arrival; compare on-schedule fallback versus waiting for fresh input.
- Native Kiro requirements, design and tasks under the root `.kiro/` directory.

Use **Show replay link** to share just the synthetic preset, its variant, and
the arrival minute. The link leaves out unrelated query parameters and anchors.
Back and Forward restore the committed choices.
Use **Copy link** or copy the selected URL manually if clipboard access is
unavailable. The URL never contains exported evidence or personal information
from the app.

To separate job success from input freshness, open **Late collector** and
switch from **Use the previous window** to **Do not fall back**. The job still
finishes at 08:08; its read at 08:06 changes from Stale to Unknown.

No paid runtime AI, no real scheduler mutation, no real production data. The core must work independently of Crew.

## Development

Node.js 22.22.2 was used for verification. No npm packages are required.
The static build strips TypeScript syntax with Node. It does not run a
TypeScript type checker; the default verification exercises runtime behavior
with Node and Chromium instead.
Browser modules use static relative imports in the source tree; the build
rewrites their `.ts` extensions for browsers. It is not a general bundler.
Use flat, lowercase regular TypeScript files in the four browser module
directories. The builder rejects unexpected entries before replacing output.
Text outputs use LF line endings on all checkouts.

Run the full engine, static build and Chromium checks without npm or shell globs:

    node scripts/check.mjs

Use `node scripts/check.mjs --engine-only` where Chromium is unavailable.
It still verifies the static module graph; it does not test browser behavior.
That runs Node tests (including a loopback HTTP check) and the static build,
but does not verify browser behavior.

Before packaging a release, run
`node --experimental-vm-modules scripts/verify-dist.mjs` after the build.
It links the emitted static import graph without executing it and rejects
missing or external module references. The check also requires an explicit
allowlist of release paths; review intentional output changes before updating
it. It caps all emitted files at 160 KiB before compression; that size budget
doesn't guarantee a particular load time. Run Chromium as well to verify behavior.

Or run individual steps:

    node build.mjs
    node --experimental-strip-types --test "src/tests/*.test.ts"
    node scripts/browser-test.mjs
    node scripts/preview.mjs

Open http://127.0.0.1:8787/ on the same computer. Preview needs a build, not
a Chromium installation. The browser check uses a locally installed Chromium
browser, its own loopback server and a temporary browser profile. If automatic
detection fails, set `CHROME_BIN` to the full path to the browser executable
before running the check. The build writes a static site to `dist/`, suitable
for ordinary static hosting.
Serve that directory over HTTP or HTTPS rather than double-clicking its
`index.html`; the simulator loads browser modules.

The generated page has a [meta content security policy](https://www.w3.org/TR/CSP3/#meta-element).
It allows local modules and assets, authorizes only the reviewed inline startup
script by its content hash, and denies browser connection requests. This is
not a hosting header or a control over which sites can embed the page.

If port 8787 is already in use, run `node scripts/preview.mjs 0` and open
the loopback URL it prints.

For a repeatable local timing sample, run
`node --experimental-strip-types scripts/benchmark.mjs`. It times five runs
of one fixed synthetic 3,000-job workload after a warm-up, and checks identical
results outside the timed section. Compare only the same workload, replay model
and runtime on the same machine. A new model may intentionally change the
output digest. This is not a release gate or a live latency claim.
Use `--fanout` instead to time 1,200 blocked jobs competing for the same slot
with 120 future supplied publication minutes. The workload checks that every
job starts at the first eligible publication rather than a later attempt.
Use `--supplied-index` for the 25,001-artifact planning workload. It checks
that an ordinary report still reads an unwatched window while the waiting
report starts at the right publication. These fixture timings are local.
Use `--help` to list the fixed workloads without running a benchmark.
When comparing a change against an earlier receipt for the same workload and
replay model, append `--expect SHA256` with its `outputSha256`. A mismatch stops
before timed sampling, even if the new result would be consistent across runs.

Check a downloaded preset or comparison JSON locally:

    node --experimental-strip-types scripts/verify-evidence.mjs path/to/evidence.json

The verifier reads one regular UTF-8 JSON file up to 8 MiB. A single replay is
reconstructed from its embedded scenario. A policy comparison is reconstructed
from its arrival minute using the two built-in policies from this release; both
recorded branches must match. Neither check establishes who created the file,
when it was produced, or whether it represents a live job. A single replay can
still verify after its input and output are changed consistently.
Run the command with `--help` to see the supported replay model. Exit status
0 means success (including help), 1 means the file could not be verified,
and 2 means the command was invoked with the wrong number of arguments.
For local resource bounds, a preset is limited to 10,000 jobs, 30,000
supplied artifacts and 100,000 configured reads in the offline verifier,
with at most 32 nested JSON containers.
Numeric values must fit the verifier's finite number range.

JSON from the initial release lacks replay inputs and cannot be verified
this way. Later evidence records its document schema and replay model
separately. Use the verifier from the matching release if the model changes.

Trace entries distinguish a planned producer from the actual attempt used.
Completion events record whether a declared output was accepted, suppressed
or failed to publish; a completed job with no output has an explicit null output.
A failed producer retry does not replace an earlier valid artifact or count as
a commit attempt. The read still identifies the attempt that produced its data.
A suppressed duplicate also cannot refresh an old artifact or release a wait.
For a slot with several configured producers, the plan names the earliest
scheduled finish, with job ID breaking ties. That is a planning assumption,
not proof of publication or a prediction of the attempt the reader will use.
The evidence token `ArtifactNeverPublished` means no usable publication by the
cutoff. It does not rule out a publication later in the replay.
A circular wait without an eligible starting artifact ends at the jobs'
individual cutoffs. The simulator models the resulting misses; it does not
reject circular dependencies in advance.
For an ordinary read with no observed artifact and no usable fallback, a
future schedule hint is not proof of publication. Once that scheduled minute
has arrived, the lack of an artifact is Missing. An observed early artifact
takes precedence over the hint.
A wait policy gates on its configured key and window, not every declared input.
Other reads are classified separately when the job starts. A job can finish
on time and still report Missing for a different input.
Reads at a wake see every output accepted in that same simulated minute;
a different slot published a minute later cannot change the recorded read.
When the policy observes a fresh artifact, the evidence records that artifact's
attempt, publication time and age at the decision separately from ordinary
reads. A fresh policy artifact can still arrive too late for the job to finish.

## Kiro usage

Kiro IDE generated the native feature specs, implementation tasks, first engine, deterministic evidence module and four synthetic fixtures. Codexify took over directly after the monthly Kiro limit: it fixed the finish-cutoff edge, added independent tests, and implemented and tested the browser UI and static build. No claims are made for Kiro CLI, Web, Crew, hooks or Powers.

The original [requirements](.kiro/specs/scenario-artifact-contracts/requirements.md),
[design](.kiro/specs/scenario-artifact-contracts/design.md) and
[tasks](.kiro/specs/scenario-artifact-contracts/tasks.md) are preserved as
generated. The task plan proposed Vitest and esbuild; the shipped revision
uses Node's test runner and a dependency-free static build instead.

Three ways to verify what the spec drove:

- **AC-002, AC-003 and AC-024:** a successful report can use an older window,
  and a later publication does not rewrite that read.
  [Read-evidence tests](src/tests/read-evidence-contract.test.ts)
- **AC-018 to AC-023:** waiting does not start a job early, and the job must
  be able to finish by the cutoff. The policy lab applies that rule to the
  same input as its on-schedule counterpart.
  [Wait-boundary tests](src/tests/independent-wait-boundaries.test.ts)
- **AC-029, AC-033 and AC-034:** repeat the same input to get the same
  event order and distinguish commit attempts from accepted effects.
  [Replay-evidence tests](src/tests/replay-evidence.test.ts)

## License

MIT. Third-party dependencies and assets must be individually reviewed and attributed as required.
