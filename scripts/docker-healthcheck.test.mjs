import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { healthcheckUsesHttps } from "./docker-healthcheck.mjs";

test("Docker healthcheck selects HTTP or HTTPS from the same certificate marker as the server", (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), "webspeak-healthcheck-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  assert.equal(healthcheckUsesHttps(directory), false);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "cert.pem"), "test certificate marker");
  assert.equal(healthcheckUsesHttps(directory), true);
});
