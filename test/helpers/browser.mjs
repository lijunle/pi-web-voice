/** Shared Playwright driver. Browser processes receive no provider credentials. */
import { chromium } from "playwright";
import { withTimeout } from "./async.mjs";
export { waitFor } from "./async.mjs";

export async function openBrowser({ signal } = {}) {
  signal?.throwIfAborted();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|HOME|USERPROFILE|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|LANG|LC_.*|DISPLAY|XAUTHORITY)$/i.test(key)));
  const browser = await chromium.launch({
    headless: true,
    env,
    args: ["--autoplay-policy=no-user-gesture-required"],
    timeout: 15_000,
  });
  const abort = () => { void browser.close().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  browser.once("disconnected", () => signal?.removeEventListener("abort", abort));
  try {
    signal?.throwIfAborted();
    const context = await browser.newContext({
      viewport: { width: 900, height: 700 }, locale: "en-US", serviceWorkers: "block",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(20_000);
    const evaluate = expression => withTimeout(() => page.evaluate(expression), "browser evaluation");
    return { browser, context, page, evaluate };
  } catch (error) {
    await browser.close();
    throw error;
  }
}
