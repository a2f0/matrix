# Performance lessons

Cross-repository findings from performance passes, newest first. Each names
the repository and PR it came from; recheck before relying on one.

## Unbundled ES module graphs pay one round trip per import level

skyline (a2f0/skyline) ships tsc output without a bundler, so the viewer's
first frame waited on a chain seven requests deep. Listing the graph at build
time and preloading it with `modulepreload` from the mounting code moved
network-done from 1471 to 833 ms and the ready median from 2369 to 1763 ms at
40 ms / 20 Mbps (5204 to 4514 ms on the slow profile), pixel-identical with
the random stars hidden. Generate the list from the built files so it cannot
drift, leave out modules the host may replace, and expect a host-bundle size
budget to need room for the preloading code.

## Seeded randomness still drifts when load order changes

Three.js draws object UUIDs from `Math.random`, so a seeded page that builds
its scene earlier or later relative to random decoration (skyline's stars)
shows that decoration elsewhere. Hide the decoration with `shot --hide` and
diff the rest; two base shots must still diff to zero first.
