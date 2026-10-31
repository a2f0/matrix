#!/usr/bin/env bun
// Measures how fast a page becomes usable, so a performance pass compares
// rounds by numbers rather than impressions. Run it from the repository being
// measured: Chrome is driven through that repository's own `playwright`
// dependency, and nothing else outside Node's built-ins is needed.
//
//   serve <dir> [--port 8765]           serve a production build, compressed, revalidating
//   measure <url> --ready <js> [...]    cold loads: median time to ready, requests, bytes
//   shot <url> --ready <js> --out <png> a seeded screenshot of the ready state; --eval <js>, --hide <css>
//   diff <a.png> <b.png>                count differing pixels between two screenshots
//   graph <dir> <entry...>              an ES module's relative static and dynamic imports
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createSecureServer, type Http2ServerRequest, type Http2ServerResponse } from "node:http2";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync, inflateSync } from "node:zlib";

export interface Options {
  command: string;
  args: string[];
  ready: string;
  runs: number;
  latency: number;
  mbps: number;
  cpu: number;
  width: number;
  height: number;
  port: number;
  out: string | undefined;
  hide: string | undefined;
  eval: string | undefined;
  from: string | undefined;
  waterfall: boolean;
  profile: boolean;
  json: boolean;
  seed: boolean;
  http1: boolean;
}

const NUMBERS = new Set(["runs", "latency", "mbps", "cpu", "width", "height", "port"]);
const STRINGS = new Set(["ready", "out", "hide", "eval", "from"]);
const FLAGS = new Set(["waterfall", "profile", "json", "seed", "http1"]);

export function parseOptions(argv: string[]): Options {
  const options: Options = {
    command: argv[0] ?? "help", args: [], ready: "document.readyState === 'complete'",
    runs: 5, latency: 40, mbps: 20, cpu: 1, width: 1600, height: 900, port: 8765,
    out: undefined, hide: undefined, eval: undefined, from: undefined, waterfall: false, profile: false, json: false, seed: true, http1: false,
  };
  const record = options as unknown as Record<string, unknown>;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) { options.args.push(arg); continue; }
    const name = arg.slice(2);
    if (name === "no-seed") { options.seed = false; continue; }
    if (FLAGS.has(name)) { record[name] = true; continue; }
    if (!NUMBERS.has(name) && !STRINGS.has(name)) throw new Error(`Unknown option ${arg}.`);
    const value = argv[i += 1];
    if (value === undefined) throw new Error(`${arg} needs a value.`);
    if (NUMBERS.has(name)) {
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0) throw new Error(`${arg} needs a non-negative number.`);
      record[name] = number;
    } else record[name] = value;
  }
  if (options.runs < 1) throw new Error("--runs needs at least 1.");
  return options;
}

/** Median and spread of repeated samples; the median is what rounds compare. */
export function summarize(samples: number[]): { median: number; min: number; max: number; runs: number } {
  if (samples.length === 0) throw new Error("No samples.");
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return { median: Math.round(median), min: sorted[0]!, max: sorted.at(-1)!, runs: sorted.length };
}

/**
 * The source with comments blanked and every string literal's contents replaced by a
 * placeholder, keeping its quotes, so a scan for imports sees neither commented-out imports nor
 * text that only looks like one. Specifiers are kept in `strings`, indexed by placeholder.
 * Regular expression literals are not recognised: a quote inside one can hide later imports.
 */
function tokens(source: string): { code: string; strings: string[] } {
  let code = "", i = 0;
  const strings: string[] = [];
  while (i < source.length) {
    const char = source[i]!, next = source[i + 1];
    if (char === "/" && next === "/") { while (i < source.length && source[i] !== "\n") i += 1; continue; }
    if (char === "/" && next === "*") { const end = source.indexOf("*/", i + 2); i = end < 0 ? source.length : end + 2; code += " "; continue; }
    if (char === "'" || char === '"' || char === "`") {
      let j = i + 1, text = "";
      while (j < source.length && source[j] !== char) {
        if (source[j] === "\\") { text += source[j]! + (source[j + 1] ?? ""); j += 2; continue; }
        text += source[j]!;
        j += 1;
      }
      code += `${char}${strings.length}${char}`;
      strings.push(text);
      i = j + 1;
      continue;
    }
    code += char;
    i += 1;
  }
  return { code, strings };
}

/** Relative imports of an ES module's source: static `import`/`export from`, bare `import "x"`, and literal `import("x")`. */
export function importsOf(source: string): string[] {
  const { code, strings } = tokens(source);
  const found = new Set<string>();
  const patterns = [
    /(?:^|[^\w$.])(?:import|export)\b[^;'"`]*?\bfrom\s*["'](\d+)["']/g,
    /(?:^|[^\w$.])import\s*["'](\d+)["']/g,
    /(?:^|[^\w$.])import\s*\(\s*["'](\d+)["']\s*\)/g,
  ];
  for (const pattern of patterns) for (const match of code.matchAll(pattern)) {
    const specifier = strings[Number(match[1])]!;
    if (specifier.startsWith(".")) found.add(specifier);
  }
  return [...found];
}

/** Every module reachable from the entries through relative imports, as paths within `root`, entries first. */
export function moduleGraph(root: string, entries: string[]): string[] {
  const seen = new Set<string>();
  const walk = (rel: string) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    for (const spec of importsOf(readFileSync(path.join(root, rel), "utf8"))) walk(path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)));
  };
  for (const entry of entries) walk(path.posix.normalize(entry));
  return [...seen];
}

const TYPES: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".wasm": "application/wasm", ".txt": "text/plain",
};
const COMPRESSED = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg", ".txt"]);

/** A throwaway self-signed certificate for localhost, so the server can speak HTTP/2 as CDNs do. */
function certificate(): { key: Buffer; cert: Buffer } {
  const directory = mkdtempSync(path.join(tmpdir(), "perf-cert-"));
  try {
    const result = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=localhost",
      "-keyout", path.join(directory, "key.pem"), "-out", path.join(directory, "cert.pem")], { stdio: "ignore" });
    if (result.status !== 0) throw new Error("openssl could not make a localhost certificate; pass --http1 to serve without TLS.");
    return { key: readFileSync(path.join(directory, "key.pem")), cert: readFileSync(path.join(directory, "cert.pem")) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Serves a build the way a CDN with revalidation does: over HTTP/2 (browsers allow six
 * HTTP/1.1 connections per host, which queues module graphs that a CDN serves in parallel),
 * text compressed once per file version so compression never costs request time, and
 * `no-cache` with an ETag. Paths outside `root` 404.
 */
export function serve(root: string, port: number, http1 = false) {
  const base = realpathSync(path.resolve(root));
  const cache = new Map<string, { key: string; body: Buffer }>();
  // The file a path names, resolved through symlinks, or undefined when that leaves the root.
  const inside = (pathname: string) => {
    try {
      const file = realpathSync(path.resolve(base, `.${pathname}`));
      return file.startsWith(base + path.sep) && statSync(file).isFile() ? file : undefined;
    } catch { return undefined; }
  };
  const compressed = (file: string, etag: string, body: Buffer) => {
    if (cache.get(file)?.key !== etag) cache.set(file, { key: etag, body: gzipSync(body, { level: 9 }) });
    return cache.get(file)!.body;
  };
  // Compress every text file before serving, so the first measured load pays no compression.
  // Symlinked directories are left to be compressed on request.
  const warm = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { warm(full); continue; }
      const file = inside(`/${path.relative(base, full).split(path.sep).join("/")}`);
      if (!file || !COMPRESSED.has(path.extname(file).toLowerCase())) continue;
      const stats = statSync(file);
      compressed(file, `"${stats.size}-${stats.mtimeMs}"`, readFileSync(file));
    }
  };
  warm(base);
  const handler = (request: IncomingMessage | Http2ServerRequest, raw: ServerResponse | Http2ServerResponse) => {
    const response = raw as unknown as { writeHead(status: number, headers?: Record<string, string>): { end(body?: Buffer): unknown } };
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname); } catch { pathname = ""; }
    if (pathname.endsWith("/")) pathname += "index.html";
    const file = pathname ? inside(pathname) : undefined;
    if (!file) { response.writeHead(404).end(); return; }
    const stats = statSync(file);
    const extension = path.extname(file).toLowerCase();
    const etag = `"${stats.size}-${stats.mtimeMs}"`;
    const headers: Record<string, string> = { "content-type": TYPES[extension] ?? "application/octet-stream", "cache-control": "no-cache", etag };
    if (request.headers["if-none-match"] === etag) { response.writeHead(304, headers).end(); return; }
    let body: Buffer = readFileSync(file);
    if (COMPRESSED.has(extension) && /\bgzip\b/.test(String(request.headers["accept-encoding"] ?? ""))) {
      body = compressed(file, etag, body);
      headers["content-encoding"] = "gzip";
    }
    response.writeHead(200, headers).end(body);
  };
  const server = http1 ? createServer(handler) : createSecureServer({ ...certificate(), allowHTTP1: true }, handler);
  // Loopback only: the build is for this machine's browser, not the network.
  return server.listen(port, "127.0.0.1", () => console.log(`Serving ${base} at ${http1 ? "http" : "https"}://127.0.0.1:${(server.address() as AddressInfo).port}/`));
}

// A deterministic Math.random for screenshots, so randomly placed decoration matches between rounds.
const SEED_SCRIPT = "{ let s = 0x2545f491; Math.random = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; }";

async function chromium(from = process.cwd()) {
  const require = createRequire(path.join(path.resolve(from), "package.json"));
  let resolved: string;
  try { resolved = require.resolve("playwright"); } catch {
    throw new Error(`perf.ts drives Chrome through the measured repository's \`playwright\`, which ${path.resolve(from)} does not install; run it there or pass --from <repository>.`);
  }
  const playwright = await import(resolved);
  return (playwright.chromium ?? playwright.default.chromium).launch({ channel: "chrome", args: ["--ignore-gpu-blocklist", "--enable-gpu"] });
}

interface Request { url: string; start: number; end?: number; bytes?: number }

/**
 * Opens the page and returns once its navigation commits, so a ready signal that comes before
 * the `load` event is timed when it comes, and slow unrelated assets cannot hold the wait.
 */
export function navigate(page: { goto(url: string, options: { waitUntil: "commit" }): Promise<unknown> }, url: string): Promise<unknown> {
  return page.goto(url, { waitUntil: "commit" });
}

async function load(browser: any, url: string, options: Options, capture: { profile?: boolean; seed?: boolean } = {}) {
  // The local server's certificate is self-signed.
  const context = await browser.newContext({ viewport: { width: options.width, height: options.height }, ignoreHTTPSErrors: true });
  try {
    if (capture.seed) await context.addInitScript(SEED_SCRIPT);
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    if (options.latency > 0 || options.mbps > 0) {
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false, latency: options.latency,
        downloadThroughput: options.mbps > 0 ? options.mbps * 125_000 : -1, uploadThroughput: -1,
      });
    }
    if (options.cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: options.cpu });
    const requests = new Map<string, Request>();
    cdp.on("Network.requestWillBeSent", (event: any) => requests.set(event.requestId, { url: event.request.url, start: event.timestamp }));
    cdp.on("Network.loadingFinished", (event: any) => {
      const request = requests.get(event.requestId);
      if (request) Object.assign(request, { end: event.timestamp, bytes: event.encodedDataLength });
    });
    if (capture.profile) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
      await cdp.send("Profiler.start");
    }
    const started = Date.now();
    await navigate(page, url);
    await page.waitForFunction(options.ready, null, { timeout: 180_000, polling: 20 });
    const ready = Date.now() - started;
    const profile = capture.profile ? (await cdp.send("Profiler.stop")).profile : undefined;
    return { page, context, ready, requests: [...requests.values()], profile };
  } catch (error) {
    await context.close();
    throw error;
  }
}

/** Self and inclusive milliseconds per function from a CPU profile, heaviest first. */
export function profileTable(profile: { nodes: any[]; samples: number[]; timeDeltas: number[] }, limit = 25) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  const name = (node: any) => `${node.callFrame.functionName || "(anonymous)"} ${node.callFrame.url.split("/").slice(-2).join("/")}${node.callFrame.url ? `:${node.callFrame.lineNumber + 1}` : ""}`;
  const self = new Map<string, number>(), total = new Map<string, number>();
  profile.samples.forEach((id, index) => {
    const time = profile.timeDeltas[index]! / 1000;
    self.set(name(nodes.get(id)), (self.get(name(nodes.get(id))) ?? 0) + time);
    const counted = new Set<string>();
    for (let current: number | undefined = id; current !== undefined; current = parent.get(current)) {
      const label = name(nodes.get(current));
      if (counted.has(label)) continue;
      counted.add(label);
      total.set(label, (total.get(label) ?? 0) + time);
    }
  });
  const top = (map: Map<string, number>) => [...map].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([fn, ms]) => ({ fn, ms: Math.round(ms * 10) / 10 }));
  return { self: top(self), inclusive: top(total) };
}

/** Times cold loads of `options.args[0]` and reports them; `measure` prints the report. */
export async function measureLoad(options: Options) {
  const url = options.args[0];
  if (!url) throw new Error("measure needs a URL.");
  const browser = await chromium(options.from);
  try {
    const samples: number[] = [];
    let first: { requests: Request[]; profile: unknown } | undefined;
    for (let run = 0; run < options.runs; run += 1) {
      const result = await load(browser, url, options, { profile: run === 0 && options.profile, seed: options.seed });
      samples.push(result.ready);
      first ??= { requests: result.requests, profile: result.profile };
      await result.context.close();
    }
    const requests = first!.requests;
    const origin = Math.min(...requests.map((request) => request.start));
    const report = {
      url, conditions: { latencyMs: options.latency, mbps: options.mbps || "unthrottled", cpuSlowdown: options.cpu, viewport: `${options.width}x${options.height}` },
      readyMs: summarize(samples), samples,
      requests: requests.length, transferredBytes: requests.reduce((sum, request) => sum + (request.bytes ?? 0), 0),
      networkDoneMs: Math.round((Math.max(origin, ...requests.flatMap((request) => request.end === undefined ? [] : [request.end])) - origin) * 1000),
      // Requests still loading, or failed, when the page was ready: network-done excludes them.
      pendingRequests: requests.filter((request) => request.end === undefined).length,
      waterfall: options.waterfall ? requests.sort((a, b) => a.start - b.start).map((request) => ({
        start: Math.round((request.start - origin) * 1000), end: request.end === undefined ? null : Math.round((request.end - origin) * 1000),
        bytes: request.bytes ?? null, path: request.url.replace(/^https?:\/\/[^/]+/, ""),
      })) : undefined,
      cpu: first!.profile ? profileTable(first!.profile as any) : undefined,
    };
    return report;
  } finally {
    await browser.close();
  }
}

async function measure(options: Options) {
    const report = await measureLoad(options);
    if (options.json) { console.log(JSON.stringify(report, null, 2)); return; }
    const { url, readyMs } = report;
    console.log(`${url}  ready median ${readyMs.median} ms (min ${readyMs.min}, max ${readyMs.max}, ${readyMs.runs} runs)`);
    console.log(`  ${report.requests} requests, ${report.transferredBytes} bytes, network done at ${report.networkDoneMs} ms${report.pendingRequests ? ` (${report.pendingRequests} still pending)` : ""}; ${JSON.stringify(report.conditions)}`);
    for (const row of report.waterfall ?? []) console.log(`  ${String(row.start).padStart(6)} ${String(row.end ?? "-").padStart(6)} ${String(row.bytes ?? "").padStart(8)} ${row.path}`);
    if (report.cpu) {
      console.log("  CPU self (ms):");
      for (const row of report.cpu.self) console.log(`  ${row.ms.toFixed(1).padStart(8)} ${row.fn}`);
      console.log("  CPU inclusive (ms):");
      for (const row of report.cpu.inclusive) console.log(`  ${row.ms.toFixed(1).padStart(8)} ${row.fn}`);
    }
}

export async function shot(options: Options): Promise<void> {
  const url = options.args[0];
  if (!url || !options.out) throw new Error("shot needs a URL and --out <png>.");
  const browser = await chromium(options.from);
  try {
    const result = await load(browser, url, { ...options, latency: 0, mbps: 0, cpu: 1 }, { seed: options.seed });
    // An interaction to compare after, such as switching a mode on; it may return a promise.
    if (options.eval) await result.page.evaluate(options.eval);
    // Let a frame or two settle after the ready signal or the interaction.
    await result.page.waitForTimeout(500);
    // Decoration that is random by design, hidden by a CSS selector that reaches into open shadow roots.
    if (options.hide) await result.page.locator(options.hide).evaluateAll((elements: HTMLElement[]) => elements.forEach((element) => { element.style.visibility = "hidden"; }));
    await result.page.screenshot({ path: options.out, animations: "disabled" });
    await result.context.close();
    console.log(`Wrote ${options.out}`);
  } finally {
    await browser.close();
  }
}

/** An 8-bit RGB or RGBA, non-interlaced PNG, as Chrome writes screenshots, decoded to RGBA. */
export function decodePng(file: Buffer): { width: number; height: number; data: Uint8Array } {
  if (file.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("Not a PNG.");
  let width = 0, height = 0, channels = 0;
  const chunks: Buffer[] = [];
  for (let at = 8; at < file.length;) {
    const length = file.readUInt32BE(at), type = file.toString("latin1", at + 4, at + 8), body = file.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, colour, , , interlace] = [body[8], body[9], body[10], body[11], body[12]];
      channels = colour === 6 ? 4 : colour === 2 ? 3 : 0;
      if (depth !== 8 || !channels || interlace !== 0) throw new Error("Only 8-bit RGB or RGBA, non-interlaced PNGs are supported.");
    } else if (type === "IDAT") chunks.push(body);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * channels;
  const pixels = new Uint8Array(stride * height), data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!, row = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[y * (stride + 1) + 1 + x]!;
      const left = x >= channels ? pixels[row + x - channels]! : 0, up = y ? pixels[row - stride + x]! : 0;
      const corner = x >= channels && y ? pixels[row - stride + x - channels]! : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - corner, a = Math.abs(estimate - left), b = Math.abs(estimate - up), c = Math.abs(estimate - corner);
        predicted = a <= b && a <= c ? left : b <= c ? up : corner;
      }
      pixels[row + x] = (value + predicted) & 255;
    }
  }
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    for (let c = 0; c < channels; c += 1) data[pixel * 4 + c] = pixels[pixel * channels + c]!;
    if (channels === 3) data[pixel * 4 + 3] = 255;
  }
  return { width, height, data };
}

/** Counts the pixels that differ between two PNG screenshots; `diff` prints the result. */
export function compareImages(options: Options) {
  const [a, b] = options.args;
  if (!a || !b) throw new Error("diff needs two PNG paths.");
  const x = decodePng(readFileSync(a)), y = decodePng(readFileSync(b));
  if (x.width !== y.width || x.height !== y.height) return { sizeMismatch: true, differing: -1, total: 0, maxChannelDelta: 255, cells: [] as { at: string; pixels: number }[] };
  // Differences per 50-pixel cell, so a few moved stars read differently from a changed building.
  const CELL = 50, cells = new Map<string, number>();
  let differing = 0, maxChannelDelta = 0;
  for (let i = 0; i < x.data.length; i += 4) {
    let pixel = 0;
    for (let c = 0; c < 4; c += 1) pixel = Math.max(pixel, Math.abs(x.data[i + c]! - y.data[i + c]!));
    if (pixel > 0) {
      differing += 1;
      const index = i / 4, key = `${Math.floor((index % x.width) / CELL) * CELL},${Math.floor(index / x.width / CELL) * CELL}`;
      cells.set(key, (cells.get(key) ?? 0) + 1);
    }
    maxChannelDelta = Math.max(maxChannelDelta, pixel);
  }
  const busiest = [...cells].sort((first, second) => second[1] - first[1]).slice(0, 20).map(([at, pixels]) => ({ at, pixels }));
  return { sizeMismatch: false, differing, total: x.width * x.height, maxChannelDelta, cells: busiest };
}

function diff(options: Options) {
  const result = compareImages(options);
  console.log(JSON.stringify(result));
  if (result.differing !== 0) process.exitCode = 1;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseOptions(argv);
  switch (options.command) {
    case "serve": {
      if (!options.args[0]) throw new Error("serve needs a directory.");
      serve(options.args[0], options.port, options.http1);
      return;
    }
    case "measure": return measure(options);
    case "shot": return shot(options);
    case "diff": return diff(options);
    case "graph": {
      const [root, ...entries] = options.args;
      if (!root || entries.length === 0) throw new Error("graph needs a directory and at least one entry.");
      const graph = moduleGraph(root, entries);
      if (options.out) writeFileSync(options.out, `${JSON.stringify(graph, null, 2)}\n`);
      console.log(JSON.stringify(graph));
      return;
    }
    default:
      console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 11).map((line) => line.replace(/^\/\/ ?/, "")).join("\n"));
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
