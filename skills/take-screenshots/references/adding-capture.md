# Adding screenshot capture to a repository

Every repository that captures screenshots follows one contract, so the
`take-screenshots` script, the shared store, and the matrix audit work the same
way everywhere. The capture code itself stays in the repository: it knows the
app's routes, seed data, and devices.

## Contract

- Root package script `screenshots` runs the whole capture and forwards extra
  arguments (a layout or project filter) to the runner.
- It writes below `<root>/.screenshots/`, resolved from the repository root,
  never from the current directory. Honor `SCREENSHOT_OUTPUT_DIR` when the
  runner already supports it, defaulting to `.screenshots`.
- The root `.gitignore` lists `.screenshots` with no trailing slash, so the
  symlink to the store is ignored too.
- Capture code removes or replaces files inside `.screenshots`, never
  `.screenshots` itself, and leaves `capture.json` alone.
- Builds never capture. A `build:*` or deploy script reads `.screenshots`
  only. A build that publishes screenshots checks `.screenshots/capture.json`
  (see [deploy guard](#deploy-guard)).
- Document the prerequisites and output layout in the repository's own docs,
  and point agents at this skill from `AGENTS.md` in one sentence.

## Layout

Use one of two shapes, named by what consumes them:

| Consumer | Layout | Example |
| --- | --- | --- |
| Website gallery or docs | `<layout>/<theme>/<screen>.png`, layouts `web`, `ipad`, `mobile`, themes `light`, `dark` | tearleads `.screenshots/mobile/dark/home.png` |
| Store listings (fastlane) | `<platform>/<device>/<NN-screen>[-dark].png` | nc `.screenshots/ios/iphone/01-home.png` |

Screen names are kebab-case and stable: a website keeps an allowlist and order
of them, so renaming one is a change to both.

## Web capture with Playwright

The pattern tearleads uses (`packages/app-web/playwright.screenshots.config.ts`
and `packages/app-web/screenshots/`):

- A separate Playwright config, so capture never runs in the e2e suite:
  `workers: 1`, `retries: 0`, a long test timeout, fixed `locale` and
  `timezoneId`.
- One project per layout:
  - `web`: `viewport: { width: 1440, height: 900 }`, `deviceScaleFactor: 2`;
  - `ipad`: `...devices["iPad Pro 11"]`;
  - `mobile`: `...devices["iPhone 13"]`;
  - `browserName: "chromium"` for all three, so output does not depend on
    WebKit; the device profiles still give touch input, viewport, and scale.
- Its own `webServer` entries on fixed, repository-specific ports with
  `reuseExistingServer: false`, against deterministic seed data or in-memory
  backends, never staging or production.
- Each theme is pinned through the app's stored preference and a reload, then
  verified (for example on `data-theme`) before capturing.
- Animations disabled with injected CSS after every navigation; wait for real
  readiness (data rendered, images decoded) instead of fixed sleeps.
- `page.screenshot({ path })` for routed layouts, or an element screenshot for
  a windowed desktop app; `mkdir` the theme directory first.

## Native capture with Maestro

The pattern nc uses (`scripts/testing/takeIosScreenshots.sh`,
`takeAndroidScreenshots.sh`, `maestro/screenshots/`):

- Dedicated, named simulators and emulators created on demand, so captures
  never depend on a day-to-day device's state; shut them down on exit.
- Status bar overridden to 9:41, full signal, battery discharging at 100%
  (`xcrun simctl status_bar ... override`; Android demo mode).
- Appearance set per capture (`xcrun simctl ui <udid> appearance dark`), with a
  short settle before the screenshot.
- Maestro flows only navigate; the shell script takes the screenshot
  (`xcrun simctl io <udid> screenshot --mask=ignored`, `adb exec-out screencap`).
- Validate every file: the exact store size for the device, and no alpha
  channel, which App Store Connect and Play reject.
- Maestro's driver uses port 7001 for every device, so one Maestro run drives
  this machine at a time: check for a running `maestro` before starting.

## Deploy guard

A build that copies screenshots into a site or upload reads the record first:

```ts
import { readFileSync } from "node:fs";
import path from "node:path";

/** Fails on a running or failed shared capture and returns a line naming its commit. */
export function captureProvenance(screenshotsDir: string): string | undefined {
  let record: { status?: string; commit?: string; finishedAt?: string; args?: string[] };
  try {
    record = JSON.parse(readFileSync(path.join(screenshotsDir, "capture.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (record.status !== "complete") {
    throw new Error(`The shared screenshot capture is ${record.status}; recapture before building.`);
  }
  const partial = record.args?.length ? ` (partial: ${record.args.join(" ")})` : "";
  return `Screenshots from ${record.commit?.slice(0, 10)} captured ${record.finishedAt}${partial}.`;
}
```

A missing record means the screenshots came from a direct capture or none at
all; CI builds, which have no store, take that path.

## Build caches

Turbo and similar caches hash declared inputs. A task that stages screenshots
must see changes made through the link: confirm that its input globs follow
the `.screenshots` symlink (recapture one screen and check the task misses its
cache), or mark the staging task `cache: false`.
