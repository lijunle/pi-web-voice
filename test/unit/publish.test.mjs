/** Exercise the workflow's actual release validator without npm/network access. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const workflow = readFileSync(new URL("../../.github/workflows/publish.yml", import.meta.url), "utf8");
const match = workflow.match(/          node <<'NODE'\n([\s\S]*?)          NODE/);
assert.ok(match, "the publish workflow supplies a testable Node validation step");
const script = match[1].replace(/^          /gm, "");

async function validate(options = {}) {
  const version = options.version ?? "0.2.0";
  const pkg = {
    name: options.name ?? "pi-web-voice", version, private: options.private ?? false,
    repository: { url: options.repositoryUrl ?? "git+https://github.com/lijunle/pi-web-voice.git" },
  };
  const lock = { version: options.lockVersion ?? version, packages: { "": { version: options.rootVersion ?? version } } };
  const process = { env: { RELEASE_TAG: options.tag ?? `v${version}`, GITHUB_REPOSITORY: "lijunle/pi-web-voice" }, exitCode: 0 };
  const calls = [];
  const errors = [];
  const sandbox = {
    process, AbortSignal,
    require(id) {
      if (id === "node:assert/strict") return assert;
      if (id === "./package.json") return pkg;
      if (id === "./package-lock.json") return lock;
      throw new Error(`Unexpected validation dependency: ${id}`);
    },
    async fetch(url, init) {
      calls.push(url);
      assert.ok(init.signal, "registry lookup has a timeout");
      if (options.networkFailure) throw new Error("Offline fixture");
      const status = options.status ?? 404;
      return { status, ok: status >= 200 && status < 300 };
    },
    console: { log() {}, error(message) { errors.push(message); } },
  };
  await vm.runInNewContext(script, sandbox, { timeout: 1000 });
  return { code: process.exitCode, calls, errors };
}

test("publication responds to newly created v* tags, not GitHub Release events", () => {
  assert.match(workflow, /on:\n  push:\n    tags: \["v\*"\]/);
  assert.match(workflow, /github\.event\.created && !github\.event\.deleted/);
  assert.match(workflow, /RELEASE_TAG: \$\{\{ github\.ref_name \}\}/);
  assert.doesNotMatch(workflow, /github\.event\.release|\n  release:/);
});

test("publication retains the CI gate, tag commit checkout, and environment-scoped OIDC", () => {
  assert.match(workflow, /checks:\n    needs: validate\n    uses: \.\/\.github\/workflows\/ci\.yml/);
  const publish = workflow.slice(workflow.indexOf("\n  publish:\n"));
  assert.match(publish, /needs: checks/);
  assert.match(publish, /environment: npm/);
  assert.match(publish, /id-token: write/);
  assert.match(publish, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(publish, /npm publish --access public --provenance --ignore-scripts/);
});

test("an unused v0.2.0 tag with matching package and lockfile versions passes validation", async () => {
  const result = await validate();
  assert.equal(result.code, 0);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.calls, ["https://registry.npmjs.org/pi-web-voice/0.2.0"]);
});

for (const [name, options] of [
  ["a tag without the v prefix", { tag: "0.2.0" }],
  ["a tag/package mismatch", { tag: "v0.3.0" }],
  ["a prerelease", { version: "0.2.0-rc.1" }],
  ["build metadata", { version: "0.2.0+build" }],
  ["a leading-zero version component", { version: "0.02.0" }],
  ["a lockfile version mismatch", { lockVersion: "0.1.7" }],
  ["a lockfile root mismatch", { rootVersion: "0.1.7" }],
  ["a different package", { name: "another-package" }],
  ["a private package", { private: true }],
  ["a different repository", { repositoryUrl: "git+https://github.com/other/project.git" }],
]) {
  test(`release validation rejects ${name} before contacting npm`, async () => {
    const result = await validate(options);
    assert.equal(result.code, 1);
    assert.equal(result.errors.length, 1);
    assert.deepEqual(result.calls, []);
  });
}

for (const [name, options] of [
  ["an already-published version", { status: 200 }],
  ["a registry error", { status: 503 }],
  ["a network failure", { networkFailure: true }],
]) {
  test(`release validation fails closed for ${name}`, async () => {
    const result = await validate(options);
    assert.equal(result.code, 1);
    assert.equal(result.calls.length, 1);
    assert.equal(result.errors.length, 1);
  });
}
