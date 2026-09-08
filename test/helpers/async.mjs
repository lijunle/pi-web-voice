/** Bound awaited work, not just the pauses between polling attempts. */
import { setTimeout as sleep } from "node:timers/promises";

export async function withTimeout(work, description, timeoutMs = 15_000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function waitFor(condition, description, timeoutMs = 10_000) {
  const deadline = performance.now() + timeoutMs;
  do {
    const remaining = Math.max(0, deadline - performance.now());
    if (await withTimeout(condition, `waiting for ${description}`, remaining)) return;
    await sleep(Math.min(50, Math.max(0, deadline - performance.now())));
  } while (performance.now() < deadline);
  throw new Error(`Timed out: waiting for ${description}`);
}
