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

A build that copies screenshots into a site or upload checks the record before
and after copying. Every capture writes a `running` record before it touches
an image, so an unchanged `complete` record on both sides proves no capture
overlapped the copy:

```ts
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

interface CaptureRecord { status?: string; commit?: string; dirty?: boolean; finishedAt?: string; args?: string[] }

function readCapture(screenshotsDir: string): string | undefined {
  try {
    return readFileSync(path.join(screenshotsDir, "capture.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Copies shared screenshots only from a finished, committed capture that no capture overlapped. */
export async function withSharedCapture<T>(screenshotsDir: string, copy: () => Promise<T>): Promise<T> {
  const before = readCapture(screenshotsDir);
  // CI and unlinked clones have a plain directory, or none; the shared store always has a record.
  const shared = lstatSync(screenshotsDir, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
  if (before === undefined && shared && readdirSync(screenshotsDir).length > 0) {
    throw new Error("The shared screenshots have no capture record; capture once through the take-screenshots skill.");
  }
  if (before !== undefined) {
    const record = JSON.parse(before) as CaptureRecord;
    if (record.status !== "complete") throw new Error(`The shared screenshot capture is ${record.status}; wait for it or recapture.`);
    if (typeof record.commit !== "string" || !/^[0-9a-f]{40}$/.test(record.commit)) throw new Error("The shared screenshot capture record names no commit; recapture.");
    if (record.dirty !== false) throw new Error("The shared screenshots were captured from uncommitted changes; recapture from a commit.");
    const partial = record.args?.length ? ` (partial: ${record.args.join(" ")})` : "";
    console.log(`Screenshots from ${record.commit?.slice(0, 10)}, captured ${record.finishedAt}${partial}.`);
  }
  const result = await copy();
  if (readCapture(screenshotsDir) !== before) throw new Error("A screenshot capture started while copying; build again once it finishes.");
  return result;
}
```

Without a record, a plain `.screenshots` directory (CI, or a clone not yet
linked) builds as before, but a linked, non-empty store does not: its images
have no known commit, as after `link` moves an older capture into the store,
until one capture through the skill records them. Copy into the build
output inside `copy`, and publish only what was copied.

## Build caches

Turbo and similar caches hash declared inputs. A task that stages screenshots
must see changes made through the link: confirm that its input globs follow
the `.screenshots` symlink (recapture one screen and check the task misses its
cache), or mark the staging task `cache: false`.
