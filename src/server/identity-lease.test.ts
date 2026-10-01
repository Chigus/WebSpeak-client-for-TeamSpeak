import assert from "node:assert/strict";
import test from "node:test";
import { IdentityLeaseStore } from "./identity-lease.js";

test("an identity lease rejects another session until its owner disconnects", () => {
  const leases = new IdentityLeaseStore();
  const key = "voice.example.com:9987|identity-1";
  assert.equal(leases.acquire(key, "session-a"), true);
  assert.equal(leases.acquire(key, "session-a"), true);
  assert.equal(leases.acquire(key, "session-b"), false);
  leases.release(key, "session-b");
  assert.equal(leases.acquire(key, "session-b"), false);
  leases.release(key, "session-a");
  assert.equal(leases.acquire(key, "session-b"), true);
  leases.release(key, "session-a");
  assert.equal(leases.acquire(key, "session-c"), false);
});

test("distinct target or identity keys can be leased independently", () => {
  const leases = new IdentityLeaseStore();
  assert.equal(leases.acquire("one.example.com|identity-1", "a"), true);
  assert.equal(leases.acquire("two.example.com|identity-1", "b"), true);
  assert.equal(leases.acquire("one.example.com|identity-2", "c"), true);
});
