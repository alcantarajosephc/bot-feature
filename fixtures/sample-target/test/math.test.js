import { test } from "node:test";
import assert from "node:assert/strict";
import { add, subtract } from "../src/math.js";

test("add adds", () => {
  assert.equal(add(2, 3), 5);
});

test("subtract subtracts", () => {
  assert.equal(subtract(5, 3), 2);
});
