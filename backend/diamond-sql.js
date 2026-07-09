"use strict";

function connectProject(siteId, options = {}) {
  const apiKey = options.apiKey;
  const dbmsUrls = normalizeDbmsUrls(options.dbmsUrl);
  const timeoutMs = Number(options.timeoutMs || 15000);

  async function requestAt(dbmsUrl, path, requestOptions = {}) {
    if (!siteId) throw new Error("SITE_ID is required");
    if (!apiKey) throw new Error("API_KEY is required");
    if (!dbmsUrls.length) throw new Error("DBMS_URL is required");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${dbmsUrl}${path}`, {
        ...requestOptions,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "x-site-id": siteId,
          "x-api-key": apiKey,
          ...(requestOptions.headers || {}),
        },
      });

      const payload = await readPayload(response);
      if (!response.ok) {
        const message = payload?.error || payload?.message || `DBMS Gateway request failed with HTTP ${response.status}`;
        throw new Error(message);
      }

      return payload;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(`DBMS Gateway request timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function query(sql, params = []) {
    const payload = await requestAny(["/gateway/query", "/query", "/api/gateway/query"], {
      method: "POST",
      body: JSON.stringify({ sql, params }),
    });

    return payload.rows || [];
  }

  async function requestAny(paths, requestOptions = {}) {
    const errors = [];

    for (const dbmsUrl of dbmsUrls) {
      for (const path of paths) {
        try {
          return await requestAt(dbmsUrl, path, requestOptions);
        } catch (error) {
          errors.push(`${dbmsUrl}${path}: ${compactError(error.message)}`);
        }
      }
    }

    throw new Error(`DBMS Gateway request failed. Tried ${errors.join(" | ")}`);
  }

  return {
    query,
    execute: query,
    status: () => requestAny(["/gateway/status", "/status", "/api/gateway/status"], { method: "GET" }),
  };
}

function normalizeDbmsUrls(value) {
  const raw = String(value || "").replace(/\/+$/, "");
  if (!raw) return [];

  const urls = [raw];
  if (raw.endsWith("/api")) urls.push(raw.slice(0, -4));
  return [...new Set(urls)];
}

function compactError(message) {
  return String(message || "").replace(/\s+/g, " ").slice(0, 180);
}

async function readPayload(response) {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

module.exports = {
  connectProject,
};
