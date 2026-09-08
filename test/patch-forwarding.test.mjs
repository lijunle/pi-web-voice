import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../lib/patch.cjs", import.meta.url), "utf8");

test("a throwing header accessor propagates once before native forwarding", () => {
  const expected = new Error("header accessor failure");
  let reads = 0, calls = 0;
  const headers = { get "content-type"() { reads += 1; throw expected; } };
  class Server {
    listen() { return this; }
    emit(_event, _req, res) { res.writeHead(200, headers); return true; }
  }
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, Buffer, process,
    require: id => id === "node:http" ? { Server } : require(id),
  });
  const errors = [];
  module.exports.install({ prefix: "/__voice", tag: "<script></script>", handleRoute() {}, onError: error => errors.push(error) });
  const res = {
    getHeader() {}, removeHeader() {}, write() {}, end() {},
    writeHead() { calls += 1; return this; },
  };
  assert.throws(() => new Server().emit("request", { url: "/", headers: {} }, res), error => error === expected);
  assert.equal(reads, 1);
  assert.equal(calls, 0);
  assert.deepEqual(errors, []);
});

for (const contentType of ["application/json", "text/html"]) {
  for (const method of ["writeHead", "write", "end"]) {
    test(`${method} errors propagate once for ${contentType}`, () => {
      const expected = new Error("native writer failure");
      let calls = 0;
      const errors = [];
      class Server {
        listen() { return this; }
        emit(_event, _req, res) {
          if (method === "writeHead") res.writeHead(200, { "content-type": contentType });
          else res[method]("<html><head></head><body>fixture</body></html>");
          return true;
        }
      }
      const module = { exports: {} };
      vm.runInNewContext(source, {
        module, exports: module.exports, Buffer, process,
        require: id => id === "node:http" ? { Server } : require(id),
      });
      module.exports.install({
        prefix: "/__voice", tag: "<script></script>", handleRoute() {},
        onError: error => errors.push(error),
      });
      const res = {
        getHeader: name => name === "content-type" ? contentType : undefined,
        removeHeader() {},
        writeHead() { calls += 1; throw expected; },
        write() { calls += 1; throw expected; },
        end() { calls += 1; throw expected; },
      };
      const server = new Server();
      assert.throws(() => server.emit("request", { url: "/", headers: {} }, res), error => error === expected);
      assert.equal(calls, 1, "the hook must not retry a writer that throws");
      assert.deepEqual(errors, [], "native errors are not transformation failures");
    });
  }
}
