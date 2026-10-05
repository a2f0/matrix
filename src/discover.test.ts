import { expect, test } from "bun:test";
import { planDiscovery } from "./discover";
import { parseManifest } from "./manifest";

const manifest = parseManifest(JSON.stringify({
  schemaVersion: 1,
  protocol: "ssh",
  discover: { owner: "a2f0", visibility: "public", exclude: ["a2f0/matrix"] },
  repos: ["a2f0/tearleads", "a2f0/retired", "a2f0/private-addition"],
}));

test("adds newly discovered repositories in name order and honors exclusions", () => {
  const plan = planDiscovery(manifest, ["a2f0/tearleads", "a2f0/Zeta", "a2f0/matrix", "A2F0/alpha", "a2f0/retired"]);
  expect(plan.added).toEqual(["A2F0/alpha", "a2f0/Zeta"]);
  expect(plan.notDiscovered).toEqual(["a2f0/private-addition"]);
});

test("reports managed repositories discovery no longer finds without removing them", () => {
  expect(planDiscovery(manifest, [])).toEqual({ added: [], notDiscovered: manifest.repos });
});
