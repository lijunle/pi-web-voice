import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { collectTerms, resolveProject, resolveSession, __cache, __resetIndex } = require("../../lib/context.cjs");
const config = { context: { maxTerms: 400, bytes: 4096, sessions: 5 } };

function fixture(t, lines) {
  const agent = mkdtempSync(path.join(tmpdir(), "pi-web-voice-context-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  __cache.clear();
  __resetIndex();
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    __cache.clear();
    __resetIndex();
    rmSync(agent, { recursive: true, force: true });
  });
  const dir = path.join(agent, "sessions", "fixture-project");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "2026-01-01_fixture-session.jsonl");
  writeFileSync(file, lines.map(line => JSON.stringify(line)).join("\n") + "\n");
  return { file, dir };
}

test("session vocabulary narrows malformed JSON shapes and reads only user/assistant text", t => {
  fixture(t, [
    { type: "session", cwd: "/fixture/project" },
    { type: "message", message: null },
    { type: "message", message: 42 },
    { type: "message", message: { role: "user", content: [
      null, 42, { type: "text", text: 42 }, { type: "text", text: "retry_safe implementation.md" },
      { type: "thinking", text: "private_thought" }, { type: "toolCall", arguments: "private_argument" },
    ] } },
    { type: "message", message: { role: "assistant", content: "retry_safe" } },
    { type: "message", message: { role: "toolResult", content: "private_result" } },
  ]);
  const terms = collectTerms("fixture-session", "", config, 60);
  assert.ok(terms.includes("retry_safe"));
  assert.ok(terms.includes("implementation.md"));
  assert.ok(terms.every(term => !term.startsWith("private_")));
  assert.equal(resolveProject("/fixture/project")?.dir.endsWith("fixture-project"), true);
});

test("project lookup reads a long complete header even with an incomplete tail", t => {
  const cwd = "/fixture/" + "中文-project/".repeat(1000);
  const { file, dir } = fixture(t, []);
  writeFileSync(file, JSON.stringify({ type: "session", cwd }) + '\n{"type":"message","unfinished":"' + 'x'.repeat(9000));
  assert.equal(resolveProject(cwd)?.dir, dir);
});

test("project lookup accepts a header at EOF and ignores cwd fields in later messages", t => {
  const { file, dir } = fixture(t, []);
  writeFileSync(file, JSON.stringify({ type: "session", cwd: "/fixture/project" }));
  assert.equal(resolveProject("/fixture/project")?.dir, dir);
  __resetIndex();
  writeFileSync(file, JSON.stringify({ type: "session", cwd: "/fixture/project" }) + '\n' +
    'x'.repeat(9000) + '\n' + JSON.stringify({ type: "message", cwd: "/wrong/project" }) + '\n');
  assert.equal(resolveProject("/fixture/project")?.dir, dir);
  assert.equal(resolveProject("/wrong/project"), null);
});

test("session lookup matches the complete id instead of its suffix", t => {
  const { file, dir } = fixture(t, [{ type: "session", cwd: "/fixture/project" }]);
  assert.ok(resolveSession("fixture-session"));
  assert.equal(resolveSession("session"), null);
  rmSync(file);
  writeFileSync(path.join(dir, "2026-01-01_long_fixture-session.jsonl"), '{}\n');
  assert.ok(resolveSession("long_fixture-session"));
  assert.equal(resolveSession("fixture-session"), null);
});

test("project lookup bounds header reads and skips oversized or malformed headers", t => {
  const { file } = fixture(t, []);
  for (const header of [
    JSON.stringify({ type: "session", cwd: "/fixture/project", padding: "x".repeat(70 * 1024) }),
    '{"cwd":',
    'null',
  ]) {
    __resetIndex();
    writeFileSync(file, header + '\n');
    assert.equal(resolveProject("/fixture/project"), null);
  }
});

test("project lookup accepts only string working-directory metadata", t => {
  fixture(t, [{ type: "session", cwd: 42 }]);
  assert.equal(resolveProject("/fixture/project"), null);
  assert.deepEqual(collectTerms("missing-session", "/fixture/project", config, 60), []);
});
