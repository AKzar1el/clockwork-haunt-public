# Clockwork Haunt

**Rehearse tomorrow’s failures before they happen.**

A Kiroween 2026 Frankenstein-category application for deterministic rehearsal of scheduled agent workflows, artifact freshness and failure scenarios.

## Status

The browser demo is implemented and locally tested. It is a single-clock simulator with fictional data, not a live scheduler or an integration with production workflows. [Open the demo](https://akzar1el.github.io/clockwork-haunt-public/).

## Included

- Four browser replay scenarios: fresh input, stale fallback, waiting for fresh input, and duplicate effects.
- Editable policy variants within the scenarios, a deterministic timeline and a downloadable JSON evidence bundle.
- Native Kiro requirements, design and tasks under the root `.kiro/` directory.

No paid runtime AI, no real scheduler mutation, no real production data.

## Development

Node.js 22.22.2 was used for verification. No dependency installation is required.

    node build.mjs
    node --experimental-strip-types --test "src/tests/*.test.ts"
    node scripts/browser-test.mjs
    node scripts/preview.mjs

Open http://127.0.0.1:8787/ on the same computer. The browser test starts its own ephemeral local server and Chromium profile. Set `CHROME_BIN` if your Chromium browser is not auto-detected. The build writes a static site to `dist/`, suitable for ordinary static hosting.

## Kiro usage

Kiro IDE generated the native feature specs, implementation tasks, first engine, deterministic evidence module and four synthetic fixtures. Codexify took over directly after the monthly Kiro limit: it fixed the finish-cutoff edge, added independent tests, and implemented and tested the browser UI and static build. No claims are made for Kiro CLI, Web, Crew, hooks or Powers.

## License

MIT. Third-party dependencies and assets must be individually reviewed and attributed as required.
