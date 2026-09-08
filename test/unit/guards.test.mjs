import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { isRecord, errorMessage, errorStatus } = require("../../lib/guards.cjs");

test("record guards narrow JSON objects and errors while excluding primitives and arrays", () => {
  for (const value of [null, undefined, "text", 42, true, [], () => {}]) {
    assert.equal(isRecord(value), false);
  }
  for (const value of [{}, Object.create(null), new Error("example")]) {
    assert.equal(isRecord(value), true);
  }
});

test("error helpers tolerate hostile properties and unstringifiable thrown values", () => {
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const hostile = {
    get message() { throw new Error("PRIVATE_GETTER_MESSAGE"); },
    get status() { throw new Error("PRIVATE_GETTER_STATUS"); },
    [Symbol.toPrimitive]() { throw new Error("PRIVATE_COERCION"); },
  };
  for (const value of [Object.create(null), hostile, revoked.proxy]) {
    assert.equal(errorMessage(value), "Unknown error");
    assert.equal(errorStatus(value), undefined);
  }
  assert.equal(isRecord(revoked.proxy), false);
});

test("error metadata is read once and supports callable or array-shaped exceptions", () => {
  let reads = 0;
  const value = { get message() { return ++reads === 1 ? "first read" : 42; } };
  assert.equal(errorMessage(value), "first read");
  assert.equal(reads, 1);
  for (const error of [Object.assign([], { message: "array error", status: 429 }),
    Object.assign(() => {}, { message: "callable error", status: 503 })]) {
    assert.equal(errorMessage(error), error.message);
    assert.equal(errorStatus(error), error.status);
  }
});

test("exception helpers preserve string details and integer status metadata", () => {
  const error = Object.assign(new Error("provider failure"), { status: 429 });
  assert.equal(errorMessage(error), "provider failure");
  assert.equal(errorStatus(error), 429);
  assert.equal(errorMessage({ message: "plain object failure" }), "plain object failure");
  for (const value of [null, undefined, "transport failure", 42]) {
    assert.equal(errorMessage(value), String(value));
    assert.equal(errorStatus(value), undefined);
  }
  for (const status of [undefined, null, "429", NaN, Infinity, 400.5]) {
    assert.equal(errorStatus({ status }), undefined);
  }
});
