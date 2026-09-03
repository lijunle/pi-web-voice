"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * Recognition vocabulary derived from what you have actually been talking
 * about, instead of a list you have to maintain by hand.
 *
 * pi stores every session as JSONL under
 *   <agent dir>/sessions/<encoded cwd>/<timestamp>_<session id>.jsonl
 * so the session id from the browser is enough to find the current
 * conversation, and its sibling files are that project's history.
 *
 * Only user and assistant prose is read. Thinking blocks, tool arguments and
 * tool results are skipped: they are noisy, and they are where secrets live.
 */

const CACHE_TTL_MS = 20_000;
const cache = new Map();

function agentDir() {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

/** Locates the JSONL file for a session id and the project it belongs to. */
function resolveSession(sessionId) {
  if (!/^[\w-]{6,}$/.test(sessionId || "")) return null;
  const root = path.join(agentDir(), "sessions");
  let projects;
  try {
    projects = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = path.join(root, project.name);
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const match = files.find((name) => name.endsWith(`${sessionId}.jsonl`));
    if (match) return { file: path.join(dir, match), dir };
  }
  return null;
}

/**
 * Locates a project's session directory from its working directory.
 *
 * The directory name is an encoding of the path, but rather than depend on
 * that encoding this reads the `cwd` recorded in the first line of each
 * session file, which is part of the on-disk session format.
 */
let projectIndex = { expires: 0, byCwd: new Map() };

function resolveProject(cwd) {
  if (!cwd) return null;
  const now = Date.now();
  if (projectIndex.expires <= now) {
    const byCwd = new Map();
    const root = path.join(agentDir(), "sessions");
    let projects = [];
    try {
      projects = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      /* no sessions yet */
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const dir = path.join(root, project.name);
      try {
        const newest = fs
          .readdirSync(dir)
          .filter((name) => name.endsWith(".jsonl"))
          .sort()
          .pop();
        if (!newest) continue;
        const header = JSON.parse(readTail(path.join(dir, newest), 4096).split("\n")[0] || "{}");
        // The tail may start mid-file, so fall back to reading the head.
        const recorded = header.cwd ?? readHeaderCwd(path.join(dir, newest));
        if (recorded) byCwd.set(recorded, dir);
      } catch {
        /* skip unreadable projects */
      }
    }
    projectIndex = { expires: now + 60_000, byCwd };
  }
  const dir = projectIndex.byCwd.get(cwd);
  return dir ? { dir, file: null } : null;
}

function readHeaderCwd(file) {
  try {
    const buffer = Buffer.alloc(512);
    const handle = fs.openSync(file, "r");
    try {
      fs.readSync(handle, buffer, 0, 512, 0);
    } finally {
      fs.closeSync(handle);
    }
    const line = buffer.toString("utf8").split("\n")[0];
    return JSON.parse(line).cwd ?? null;
  } catch {
    return null;
  }
}

/** Reads the last `maxBytes` of a file, dropping the partial first line. */
function readTail(file, maxBytes) {
  let handle;
  try {
    const { size } = fs.statSync(file);
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return "";
    const buffer = Buffer.alloc(length);
    handle = fs.openSync(file, "r");
    fs.readSync(handle, buffer, 0, length, start);
    const text = buffer.toString("utf8");
    return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
  } catch {
    return "";
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

// ── candidate extraction ───────────────────────────────────────────────────

// Shapes a speech model tends to get wrong and a plain dictionary will not fix.
const PATTERNS = [
  /`([^`\n]{2,40})`/g, // `inline code`
  /\b([A-Za-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+)\b/g, // camelCase, PascalCase
  /\b([A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)+)\b/g, // kebab-case, snake_case
  /\b([A-Za-z][\w-]*\.(?:[a-z]{2,5}))\b/g, // package.json, hook.cjs
  /\b([\w.-]+\/[\w./-]+)\b/g, // spec/lock.yml, docs/probing.md
  /\b([A-Z]{3,8})\b/g, // MCP, USWDS, SSE
];

// Ordinary words that happen to be written in caps or wrapped in backticks.
// Boosting them wastes a slot; a speech model already gets them right.
const STOPWORDS = new Set([
  "AND", "THE", "FOR", "NOT", "YOU", "ALL", "ANY", "CAN", "GET", "SET", "NEW",
  "USE", "ADD", "RUN", "ONE", "TWO", "YES", "WILL", "MUST", "MAY", "SHOULD",
  "NOTE", "TODO", "WARNING", "REQUIRED", "OPTIONAL", "DEFINED", "RECOMMENDED",
  "HTTP", "HTTPS", "JSON", "HTML", "TEXT", "NULL", "TRUE", "FALSE",
]);

/**
 * Only terms with a distinctive written form are worth boosting: mixed case,
 * a separator, a digit, or an acronym. A plain lowercase word like "host" adds
 * nothing and crowds out the vocabulary budget.
 */
function hasShape(term) {
  return (
    /[a-z][A-Z]/.test(term) ||
    /[-_./]/.test(term) ||
    /^[A-Z]{3,8}$/.test(term) ||
    /\d/.test(term)
  );
}

/**
 * Conservative secret filter. Anything that looks like a credential is dropped
 * before it can reach a speech provider.
 */
function looksLikeSecret(term) {
  if (term.includes("@") || term.includes("://")) return true;
  if (/^(sk|ghp|gho|ghs|github_pat|xox[abprs]|AKIA|ASIA|AIza|glpat|dop_v1)[-_]/i.test(term)) return true;
  if (/^[0-9a-f]{16,}$/i.test(term)) return true; // hex digest
  if (/^[A-Za-z0-9+/]{24,}={0,2}$/.test(term) && /\d/.test(term)) return true; // base64-ish
  // Long, separator-free, mixed letters and digits: almost always a token.
  if (term.length >= 24 && /[A-Za-z]/.test(term) && /\d/.test(term) && !/[-_./]/.test(term)) return true;
  return false;
}

function acceptable(term) {
  if (term.length < 3 || term.length > 40) return false;
  if (STOPWORDS.has(term.toUpperCase())) return false;
  if (/^\d+$/.test(term)) return false;
  if (!/[A-Za-z]/.test(term)) return false;
  // A backtick span can hold a whole shell command; keep short fragments only.
  if ((term.match(/\s/g) ?? []).length > 1) return false;
  if (/[{}"'|$<>`]/.test(term)) return false;
  if (!hasShape(term)) return false;
  if (looksLikeSecret(term)) return false;
  return true;
}

function harvest(text, weight, scores) {
  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const term = match[1].trim().replace(/[.,;:)]+$/, "");
      if (!acceptable(term)) continue;
      scores.set(term, (scores.get(term) ?? 0) + weight);

      // "spec/lock.yml" is rarely spoken whole; the basename usually is.
      if (term.includes("/")) {
        const base = term.slice(term.lastIndexOf("/") + 1);
        if (acceptable(base)) scores.set(base, (scores.get(base) ?? 0) + weight * 0.5);
      }
    }
  }
}

/** Pulls prose out of one session file and scores the terms inside it. */
function scoreSession(file, weight, scores, maxBytes) {
  for (const line of readTail(file, maxBytes).split("\n")) {
    if (!line.startsWith("{")) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "message") continue;

    const role = entry.message?.role;
    if (role !== "user" && role !== "assistant") continue;

    // What you said yourself is the strongest signal for what you will say next.
    const roleWeight = role === "user" ? weight * 1.5 : weight;
    const content = entry.message?.content;

    if (typeof content === "string") {
      harvest(content, roleWeight, scores);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") {
        harvest(block.text, roleWeight, scores);
      }
    }
  }
}

function recentProjectSessions(dir, currentFile, limit) {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => path.join(dir, name))
      .filter((file) => file !== currentFile)
      .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit)
      .map((entry) => entry.file);
  } catch {
    return [];
  }
}

/**
 * Returns the ranked vocabulary for a request, mined from the conversation and
 * capped at `limit`.
 *
 * `sessionId` pins it to the exact conversation the tab is showing. `cwd` is
 * the fallback for a session that does not exist yet, where the project's
 * earlier conversations are still the right vocabulary.
 */
function collectTerms(sessionId, cwd, config, limit) {
  if (config.context.scope === "off") return [];

  const key = `${sessionId || ""}|${cwd || ""}|${config.context.scope}`;
  const cached = cache.get(key);
  const now = Date.now();

  if (cached && cached.expires > now) return cached.terms.slice(0, limit);

  const found = resolveSession(sessionId) ?? resolveProject(cwd);
  if (!found) return [];

  const scores = new Map();
  if (found.file) scoreSession(found.file, 3, scores, config.context.bytes);

  // Project history is used when asked for, and always when there is no
  // current conversation to learn from yet.
  if (config.context.scope === "project" || !found.file) {
    for (const file of recentProjectSessions(found.dir, found.file, config.context.sessions)) {
      scoreSession(file, 1, scores, Math.min(config.context.bytes, 128 * 1024));
    }
  }

  const mined = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([term]) => term)
    .slice(0, config.context.maxTerms);

  cache.set(key, { expires: now + CACHE_TTL_MS, terms: mined });
  return mined.slice(0, limit);
}

module.exports = {
  collectTerms,
  resolveSession,
  resolveProject,
  looksLikeSecret,
  __cache: cache,
  __resetIndex: () => {
    projectIndex = { expires: 0, byCwd: new Map() };
  },
};
