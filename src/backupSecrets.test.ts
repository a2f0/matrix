import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ROOT } from "./cli";

const SCRIPT = path.join(ROOT, "scripts", "backupSecrets.sh");
let temporary: string, secrets: string, output: string, gnupg: string;

function backup(...args: string[]): { status: number | null; stderr: string } {
  const env = { ...process.env, MATRIX_SECRETS_DIR: secrets, GNUPGHOME: gnupg, HOME: temporary };
  const result = spawnSync("bash", [SCRIPT, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { status: result.status, stderr: result.stderr };
}

function archives(directory = output): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(name => name.startsWith("matrix-secrets-backup-")).map(name => path.join(directory, name));
}

function mode(file: string): number { return statSync(file).mode & 0o777; }

function decrypt(archive: string, passphrase: string): string {
  const zip = path.join(temporary, "decrypted.zip");
  execFileSync("gpg", ["--batch", "--yes", "--pinentry-mode", "loopback", "--passphrase-fd", "0", "--output", zip, "--decrypt", archive],
    { env: { ...process.env, GNUPGHOME: gnupg }, input: passphrase, stdio: ["pipe", "ignore", "ignore"] });
  return zip;
}

function entry(zip: string, name: string): string { return execFileSync("unzip", ["-p", zip, name], { encoding: "utf8" }); }

beforeEach(() => {
  temporary = mkdtempSync(path.join(tmpdir(), "matrix-backup-"));
  secrets = path.join(temporary, "matrix-secrets");
  output = path.join(temporary, "backups");
  gnupg = path.join(temporary, "gnupg");
  mkdirSync(path.join(secrets, "demo", "prod"), { recursive: true });
  mkdirSync(gnupg, { mode: 0o700 });
  writeFileSync(path.join(secrets, "demo", "prod", "app.env"), "TOKEN=fixture-secret\n");
  writeFileSync(path.join(secrets, ".DS_Store"), "finder");
});

afterEach(() => rmSync(temporary, { recursive: true, force: true }));

test("non-interactive backups require an explicit encryption choice", () => {
  const result = backup(output);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("require --password or explicit --no-password");
  expect(archives()).toEqual([]);
});

test("rejects conflicting, empty, and unknown options", () => {
  expect(backup(output, "--password", "x", "--no-password").stderr).toContain("cannot be combined");
  expect(backup(output, "--password=").stderr).toContain("cannot be empty");
  expect(backup(output, "--force").stderr).toContain("unknown option");
  expect(backup(output, output, "--no-password").stderr).toContain("too many positional arguments");
});

test("refuses a missing source and an output directory inside it", () => {
  rmSync(secrets, { recursive: true });
  expect(backup(output, "--no-password").stderr).toContain("secrets directory not found");
  mkdirSync(path.join(secrets, "demo"), { recursive: true });
  symlinkSync(secrets, path.join(temporary, "alias"));
  expect(backup(path.join(temporary, "alias", "backups"), "--no-password").stderr).toContain("cannot be inside the secrets directory");
  const detour = path.join(temporary, "missing", "..", "matrix-secrets", "backups");
  expect(backup(detour, "--no-password").stderr).toContain("cannot be inside the secrets directory");
  expect(readdirSync(secrets)).toEqual(["demo"]);
  expect(existsSync(path.join(temporary, "missing"))).toBe(false);
});

test("encrypts the folder under its own name without touching earlier archives", () => {
  expect(backup(output, "--password", "fixture-passphrase").status).toBe(0);
  const [first] = archives();
  expect(first).toEndWith(".zip.gpg");
  expect(mode(first!)).toBe(0o600);
  const before = statSync(first!).mtimeMs;
  expect(backup(output, "--password", "fixture-passphrase").status).toBe(0);
  expect(archives()).toHaveLength(2);
  expect(statSync(first!).mtimeMs).toBe(before);
  const zip = decrypt(first!, "fixture-passphrase");
  expect(entry(zip, "matrix-secrets/demo/prod/app.env")).toBe("TOKEN=fixture-secret\n");
  expect(execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" })).not.toContain(".DS_Store");
  expect(() => decrypt(first!, "wrong-passphrase")).toThrow();
});

test("writes a private plain archive when asked for no password", () => {
  expect(backup(output, "--no-password").status).toBe(0);
  const [archive] = archives();
  expect(archive).toEndWith(".zip");
  expect(mode(archive!)).toBe(0o600);
  expect(entry(archive!, "matrix-secrets/demo/prod/app.env")).toBe("TOKEN=fixture-secret\n");
  expect(readdirSync(output).filter(name => name.startsWith("."))).toEqual([]);
});

test("defaults to ~/matrix-secrets-backups", () => {
  expect(backup("--no-password").status).toBe(0);
  expect(archives(path.join(temporary, "matrix-secrets-backups"))).toHaveLength(1);
});
