"use strict";

/**
 * Narrow values from JSON and caught exceptions before reading properties.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  try {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false; // Array.isArray can throw for a revoked Proxy.
  }
}

/**
 * Read exception metadata once, tolerating accessors and revoked proxies.
 * @param {unknown} value
 * @param {"message" | "status"} name
 * @returns {unknown}
 */
function errorProperty(value, name) {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return undefined;
  try {
    return Reflect.get(value, name);
  } catch {
    return undefined;
  }
}

/**
 * Preserve string error details and give other thrown values a readable form.
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  const message = errorProperty(error, "message");
  if (typeof message === "string") return message;
  try {
    return String(error);
  } catch {
    return "Unknown error";
  }
}

/**
 * Read only integer HTTP-status metadata from an exception.
 * @param {unknown} error
 * @returns {number | undefined}
 */
function errorStatus(error) {
  const status = errorProperty(error, "status");
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

module.exports = { isRecord, errorMessage, errorStatus };
