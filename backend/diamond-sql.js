"use strict";

function connectProject(siteId, options = {}) {
  const apiKey = options.apiKey;
  const dbmsUrl = normalizeDbmsUrl(options.dbmsUrl);
  const timeoutMs = Number(options.timeoutMs || 15000);

  async function request(path, requestOptions = {}) {
    if (!siteId) throw new Error("SITE_ID is required");
    if (!apiKey) throw new Error("API_KEY is required");
    if (!dbmsUrl) throw new Error("DBMS_URL is required");

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
    const payload = await request("/gateway/query", {
      method: "POST",
      body: JSON.stringify({ sql, params }),
    });

    return payload.rows || [];
  }

  return {
    query,
    execute: query,
    status: () => request("/gateway/status", { method: "GET" }),
  };
}

function normalizeDbmsUrl(value) {
  return String(value || "").replace(/\/+$/, "");
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
