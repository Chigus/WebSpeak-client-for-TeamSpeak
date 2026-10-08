// Run inside the new image with the release directory mounted read-only at /release.
// Do not print the resolved Compose configuration: it may contain private settings.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

const app = process.env.WEBSPEAK_APP_ROOT;
const image = process.env.WEBSPEAK_CANDIDATE_IMAGE;
const rollbackImage = process.env.WEBSPEAK_ROLLBACK_IMAGE;
const releaseDirectory = process.env.WEBSPEAK_COMPOSE_DIRECTORY ?? "/release";
assert.ok(app?.startsWith("/") && app !== "/", "An absolute app root is required");
assert.match(image ?? "", /^webspeak-local:git-[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
assert.match(rollbackImage ?? "", /^webspeak-rollback:release-[A-Za-z0-9_.-]+$/);
const repository = path.posix.join(app, "repo");
const before = JSON.parse(readFileSync(path.join(releaseDirectory, "compose.before.json"), "utf8"));
const candidate = JSON.parse(readFileSync(path.join(releaseDirectory, "compose.candidate.json"), "utf8"));
const rollback = JSON.parse(readFileSync(path.join(releaseDirectory, "compose.rollback.json"), "utf8"));

function validate(config, expectedImage) {
  const service = config.services?.webspeak;
  assert.ok(service, "Existing webspeak service is required");
  assert.equal(service.container_name, "webspeak", "Unexpected container name");
  assert.equal(service.image, expectedImage, "Unexpected WebSpeak image");
  assert.equal(service.build, undefined, "Runtime Compose must not build application code");
  assert.ok(service.volumes?.some((volume) =>
    volume.type === "bind" && volume.target === "/data" &&
    path.posix.normalize(volume.source) === path.posix.join(app, "data")),
  "The existing external data bind mount must be retained");
  for (const current of Object.values(config.services)) {
    for (const volume of current.volumes ?? []) {
      if (volume.type !== "bind") continue;
      assert.ok(path.posix.isAbsolute(volume.source), "Bind sources must resolve to absolute paths");
      const source = path.posix.normalize(volume.source);
      assert.ok(source !== repository && !source.startsWith(`${repository}/`), "Runtime mounts must stay outside the Git checkout");
    }
  }
  const normalized = structuredClone(config);
  normalized.services.webspeak.image = before.services.webspeak.image;
  assert.ok(isDeepStrictEqual(normalized, before), "A code release may change only services.webspeak.image");
}

validate(candidate, image);
validate(rollback, rollbackImage);
console.log(JSON.stringify({ passed: true, onlyChangedField: "services.webspeak.image", externalDataRetained: true }));
