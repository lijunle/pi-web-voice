/** Fail closed before a live run can submit extra paid uploads or agent requests. */
import assert from "node:assert/strict";

export function requestPolicy(origin, { live = false } = {}) {
  let selectingProject = true;
  let permitted = !live;
  let issued = false;
  const state = {
    violations: [],
    uploads: 0,
    finishSetup() { selectingProject = false; },
    permitUpload() {
      assert.ok(live && !issued, "a live run permits exactly one upload");
      issued = true;
      permitted = true;
    },
    allow(method, address) {
      const url = new URL(address);
      const sameOrigin = url.origin === origin;
      if (sameOrigin && url.pathname === "/__voice/transcribe") {
        if (method !== "POST" || !permitted) {
          state.violations.push("unpermitted transcription request");
          return false;
        }
        if (live) permitted = false;
        state.uploads++;
        return true;
      }
      if (["GET", "HEAD"].includes(method)) return sameOrigin;
      if (sameOrigin && selectingProject && method === "POST" && url.pathname === "/api/default-cwd") return true;
      // Record external writes too, but retain no potentially private URLs/bodies.
      state.violations.push("unexpected application write");
      return false;
    },
  };
  return state;
}
