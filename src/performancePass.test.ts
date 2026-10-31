import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { createServer } from "node:http";
import { connect } from "node:http2";
import { compareImages, importsOf, measureLoad, moduleGraph, navigate, parseOptions, profileTable, serve, shot, summarize } from "../skills/performance-pass/scripts/perf";

const temps: string[] = [];
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "performance-pass-"));
  temps.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  }
  return root;
}

describe("performance-pass perf.ts", () => {
  test("parses commands, numbers, flags and rejects unknown or invalid options", () => {
    const options = parseOptions(["measure", "http://x/", "--runs", "7", "--cpu", "4", "--waterfall", "--no-seed", "--ready", "window.ok", "--from", "checkouts/app"]);
    expect(options).toMatchObject({ command: "measure", args: ["http://x/"], runs: 7, cpu: 4, waterfall: true, seed: false, ready: "window.ok", latency: 40, mbps: 20, from: "checkouts/app" });
    expect(() => parseOptions(["measure", "--bogus"])).toThrow("Unknown option --bogus.");
    expect(() => parseOptions(["measure", "--runs"])).toThrow("--runs needs a value.");
    expect(() => parseOptions(["measure", "--runs", "-1"])).toThrow("non-negative");
    expect(() => parseOptions(["measure", "--runs", "0"])).toThrow("at least 1");
  });

  test("summarizes samples by median and spread", () => {
    expect(summarize([30, 10, 20])).toEqual({ median: 20, min: 10, max: 30, runs: 3 });
    expect(summarize([10, 20, 40, 30])).toEqual({ median: 25, min: 10, max: 40, runs: 4 });
    expect(() => summarize([])).toThrow("No samples.");
  });

  test("follows relative static, bare and dynamic imports, but not packages", () => {
    const source = 'import { a } from "./a.js";\nexport { b } from "../b.js";\nimport "./c.js";\nimport * as THREE from "three";\nconst d = import(/* webpackIgnore: true */ "./d.js");\nconst text = "from ./e.js";';
    expect(importsOf(source).sort()).toEqual(["../b.js", "./a.js", "./c.js", "./d.js"]);
    // Minified imports count; commented-out ones and import-like text in strings do not.
    const tricky = 'import{x}from"./x.js";export*from"./y.js";import"./z.js"\n// import "./no-1.js"\n/* import { a } from "./no-2.js" */\nconst s = "import \'./no-3.js\'";\nconst url = "https://example.com/x"; import { w } from "./w.js";';
    expect(importsOf(tricky).sort()).toEqual(["./w.js", "./x.js", "./y.js", "./z.js"]);
    const root = tree({
      "main.js": 'import "./lib/a.js";\nconst later = import("./late.js");',
      "lib/a.js": 'import { b } from "../b.js";\nimport { main } from "../main.js";',
      "b.js": "export const b = 1;",
      "late.js": "export {};",
    });
    expect(moduleGraph(root, ["main.js"])).toEqual(["main.js", "lib/a.js", "b.js", "late.js"]);
  });

  test("measures from the navigation's commit, not its load event", async () => {
    const calls: unknown[][] = [];
    await navigate({ goto: async (...args: unknown[]) => { calls.push(args); } }, "https://x/");
    expect(calls).toEqual([["https://x/", { waitUntil: "commit" }]]);
  });

  test("totals CPU profile time by function, self and inclusive", () => {
    const frame = (functionName: string) => ({ functionName, url: "http://x/app/main.js", lineNumber: 0 });
    const table = profileTable({
      nodes: [{ id: 1, callFrame: frame("(root)"), children: [2] }, { id: 2, callFrame: frame("outer"), children: [3] }, { id: 3, callFrame: frame("inner") }],
      samples: [3, 3, 2],
      timeDeltas: [1000, 1000, 500],
    });
    expect(table.self[0]).toEqual({ fn: "inner app/main.js:1", ms: 2 });
    expect(table.inclusive.find((row) => row.fn.startsWith("outer"))?.ms).toBe(2.5);
  });

  test("serves files compressed with revalidation, and nothing outside its directory", async () => {
    const root = tree({ "site/index.html": "<p>hello</p>", "site/app.js": "export const x = 1;", "site/lib/inner.js": "export {};", "secret.txt": "no", "private/key.txt": "no" });
    // Links that lead out of the served directory must not serve what they point at.
    symlinkSync(path.join(root, "secret.txt"), path.join(root, "site/leak.txt"));
    symlinkSync(path.join(root, "private"), path.join(root, "site/private"));
    symlinkSync(path.join(root, "site/app.js"), path.join(root, "site/alias.js"));
    const server = serve(path.join(root, "site"), 0, true);
    await new Promise((resolve) => server.once("listening", resolve));
    expect((server.address() as AddressInfo).address, "loopback only").toBe("127.0.0.1");
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const page = await fetch(`${origin}/`, { headers: { "accept-encoding": "identity" } });
      expect(await page.text()).toBe("<p>hello</p>");
      const etag = page.headers.get("etag")!;
      expect(page.headers.get("cache-control")).toBe("no-cache");
      expect((await fetch(`${origin}/`, { headers: { "if-none-match": etag } })).status).toBe(304);
      const script = await fetch(`${origin}/app.js`, { headers: { "accept-encoding": "gzip" }, decompress: false } as RequestInit);
      expect(script.headers.get("content-encoding")).toBe("gzip");
      expect(gunzipSync(Buffer.from(await script.arrayBuffer())).toString()).toBe("export const x = 1;");
      expect((await fetch(`${origin}/../secret.txt`)).status).toBe(404);
      expect((await fetch(`${origin}/%2e%2e/secret.txt`)).status).toBe(404);
      expect((await fetch(`${origin}/missing.js`)).status).toBe(404);
      expect((await fetch(`${origin}/leak.txt`)).status).toBe(404);
      expect((await fetch(`${origin}/private/key.txt`)).status).toBe(404);
      expect((await fetch(`${origin}/%E0%A4%A`)).status).toBe(404);
      expect(await (await fetch(`${origin}/alias.js`)).text()).toBe("export const x = 1;");
      expect(await (await fetch(`${origin}/lib/inner.js`)).text()).toBe("export {};");
    } finally {
      server.close();
    }
  });

  // These drive the system Chrome through this workspace's own playwright.
  test("serves HTTP/2 by default and times a page's ready signal, not its load event", async () => {
    // A page that is ready at once but holds an image from a server that never answers in time.
    const slow = createServer(() => { /* never responds */ });
    await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));
    const slowPort = (slow.address() as AddressInfo).port;
    const root = tree({ "index.html": `<script>window.ready = true</script><img src="http://127.0.0.1:${slowPort}/slow.png">` });
    const server = serve(root, 0);
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const session = connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false });
      const status = await new Promise((resolve, reject) => {
        const request = session.request({ ":path": "/" });
        request.on("response", (headers) => resolve(headers[":status"]));
        request.on("error", reject);
        request.end();
      });
      session.close();
      expect(status).toBe(200);
      const report = await measureLoad(parseOptions(["measure", `https://127.0.0.1:${port}/`, "--runs", "1", "--latency", "0", "--mbps", "0", "--ready", "window.ready === true"]));
      expect(report.readyMs.median).toBeLessThan(10_000);
      expect(report.pendingRequests, "the image was still loading").toBeGreaterThanOrEqual(1);
    } finally {
      server.close();
      slow.closeAllConnections();
      slow.close();
    }
  }, { timeout: 60_000 });

  test("screenshots a seeded page identically, and counts what an interaction changes", async () => {
    const root = tree({
      "index.html": '<body style="margin:0"><div id="box" style="width:100px;height:100px;background:#000"></div><p id="noise"></p><script>document.querySelector("#noise").textContent = Math.random(); window.ready = true</script></body>',
    });
    const server = serve(root, 0);
    await new Promise((resolve) => server.once("listening", resolve));
    const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const out = (name: string) => path.join(root, `${name}.png`);
    const options = (...extra: string[]) => parseOptions(["shot", url, "--ready", "window.ready === true", "--width", "200", "--height", "150", ...extra]);
    try {
      await shot(options("--out", out("a")));
      await shot(options("--out", out("b")));
      expect((compareImages(parseOptions(["diff", out("a"), out("b")]))).differing, "seeded randomness repeats").toBe(0);
      await shot(options("--out", out("c"), "--eval", 'document.querySelector("#box").style.background = "#fff"'));
      const changed = compareImages(parseOptions(["diff", out("a"), out("c")]));
      expect(changed.differing).toBe(100 * 100);
      expect(changed.cells[0]).toEqual({ at: "0,0", pixels: 2500 });
      await shot(options("--out", out("d"), "--no-seed", "--hide", "#noise"));
      await shot(options("--out", out("e"), "--no-seed", "--hide", "#noise"));
      expect((compareImages(parseOptions(["diff", out("d"), out("e")]))).differing, "hidden noise").toBe(0);
    } finally {
      server.close();
    }
  }, { timeout: 120_000 });
});
