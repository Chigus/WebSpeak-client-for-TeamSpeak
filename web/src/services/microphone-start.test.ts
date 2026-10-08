import assert from "node:assert/strict";
import test from "node:test";
import { requestMediaBeforeAudioResume } from "./microphone-start.js";

test("starts the permission prompt before audio resume and does not wait on resume", async () => {
  const calls: string[] = [];
  let finishResume!: () => void;
  const media = requestMediaBeforeAudioResume(
    async () => { calls.push("permission"); return "microphone"; },
    () => { calls.push("resume"); return new Promise<void>(resolve => { finishResume = resolve; }); },
  );
  assert.deepEqual(calls, ["permission", "resume"]);
  assert.equal(await media, "microphone");
  finishResume();
});

test("keeps microphone request failures visible to the caller", async () => {
  const error = new Error("permission denied");
  await assert.rejects(requestMediaBeforeAudioResume(() => Promise.reject(error), async () => undefined), error);
});
