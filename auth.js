/**
 * auth.js — PonyMail session management
 *
 * PonyMail Foal handles OAuth entirely server-side — the auth code from ASF OAuth
 * can only be exchanged by PonyMail's own backend (its redirect_uri is registered
 * with ASF OAuth, not ours). So we can't replicate the OAuth exchange from a CLI.
 *
 * Instead, this module:
 * 1. Opens the PonyMail login page in the user's browser
 * 2. Runs a tiny local server that waits for the user to paste their cookie
 *    OR watches for the cookie file to appear (if using browser extension)
 * 3. Caches the session cookie to ~/.ponymail-mcp/session.json
 *
 * The simplest reliable flow:
 * - Open lists.apache.org/oauth.html in the browser
 * - User logs in (ASF LDAP)
 * - After login, PonyMail sets a session cookie in the browser
 * - User copies the cookie value from DevTools (or we provide a bookmarklet)
 * - We cache it and use it for API requests
 *
 * Alternatively, set PONYMAIL_SESSION_COOKIE env var directly.
 */

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { exec } from "node:child_process";

const SESSION_DIR = path.join(os.homedir(), ".ponymail-mcp");
const SESSION_FILE = path.join(SESSION_DIR, "session.json");
const CALLBACK_PORT = 39817;
const LOGIN_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------

export function loadSession() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
    if (data.timestamp && Date.now() - data.timestamp > 20 * 60 * 60 * 1000) {
      console.error("[auth] Cached session expired");
      return null;
    }
    return data.cookie || null;
  } catch {
    return null;
  }
}

function saveSession(cookie, userInfo = {}) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(
    SESSION_FILE,
    JSON.stringify({ cookie, timestamp: Date.now(), user: userInfo }, null, 2)
  );
  console.error(`[auth] Session saved to ${SESSION_FILE}`);
}

export function clearSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      fs.unlinkSync(SESSION_FILE);
      console.error("[auth] Session cleared");
    }
  } catch (err) {
    console.error("[auth] Failed to clear session:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Browser helper
// ---------------------------------------------------------------------------

function openBrowser(url) {
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) console.error("[auth] Could not open browser:", err.message);
  });
}

// ---------------------------------------------------------------------------
// Login flow
// ---------------------------------------------------------------------------

/**
 * Perform login by:
 * 1. Opening PonyMail's login page in the browser
 * 2. Starting a local HTTP server with a simple form where the user pastes
 *    their cookie after logging in
 * 3. Saving the cookie once received
 *
 * @param {string} baseUrl - PonyMail base URL
 * @param {number} [timeoutMs] - Max time to wait (default 3 min)
 * @returns {Promise<string>} The session cookie string
 */
export function performLogin(baseUrl, timeoutMs = LOGIN_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let server;
    let settled = false;

    function settle(err, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (server) {
        try { server.close(); } catch {}
      }
      if (err) reject(err);
      else resolve(result);
    }

    const timer = setTimeout(() => {
      settle(new Error(
        `Login timed out after ${timeoutMs / 1000}s. Call login again to retry.`
      ));
    }, timeoutMs);

    server = http.createServer(async (req, res) => {
      // Serve the cookie-paste form
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(loginPage(baseUrl));
        return;
      }

      // Receive the pasted cookie
      if (req.method === "POST" && req.url === "/save") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const params = new URLSearchParams(body);
        const cookie = (params.get("cookie") || "").trim();

        if (!cookie) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(resultPage(false, "No cookie value provided. Please try again."));
          return;
        }

        // Validate the cookie by calling preferences endpoint
        try {
          const testUrl = new URL("/api/preferences.lua", baseUrl);
          const testResp = await fetch(testUrl.toString(), {
            headers: { Accept: "application/json", Cookie: cookie },
          });
          const testData = await testResp.json();

          if (testData.login && testData.login.credentials) {
            const name = testData.login.credentials.fullname || "Unknown";
            const email = testData.login.credentials.email || "";
            saveSession(cookie, { fullname: name, email });
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(resultPage(true, `Authenticated as ${name} (${email})`));
            settle(null, cookie);
          } else {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(resultPage(false,
              "Cookie was accepted but no login credentials found. " +
              "Make sure you copied the full cookie string. Try again."
            ));
          }
        } catch (err) {
          res.writeHead(500, { "Content-Type": "text/html" });
          res.end(resultPage(false, `Validation failed: ${err.message}`));
        }
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    server.on("error", (err) => {
      settle(new Error(`Could not start callback server on port ${CALLBACK_PORT}: ${err.message}`));
    });

    server.listen(CALLBACK_PORT, () => {
      // Open the local helper page (which has a link to PonyMail login + paste form)
      const helperUrl = `http://localhost:${CALLBACK_PORT}`;
      console.error(`[auth] Opening login helper at ${helperUrl}`);
      openBrowser(helperUrl);
    });
  });
}

// ---------------------------------------------------------------------------
// HTML pages
// ---------------------------------------------------------------------------

function loginPage(baseUrl) {
  const oauthUrl = `${baseUrl}/oauth.html`;
  return `<!DOCTYPE html>
<html>
<head><title>PonyMail MCP Login</title></head>
<body style="font-family:system-ui;max-width:640px;margin:40px auto;padding:0 20px">
  <h1>🐴 PonyMail MCP Login</h1>
  <p><strong>Step 1:</strong> Log into PonyMail in your browser:</p>
  <p><a href="${oauthUrl}" target="_blank" style="font-size:1.2em;color:#0066cc">
    ➜ Open ${oauthUrl}
  </a></p>
  <p><strong>Step 2:</strong> After logging in, open DevTools (<code>Cmd+Option+I</code> or <code>F12</code>)
     → <strong>Application</strong> tab → <strong>Cookies</strong> → <code>${new URL(baseUrl).hostname}</code></p>
  <p>Copy the <strong>entire cookie string</strong>. It typically looks like:<br>
     <code style="background:#f0f0f0;padding:2px 6px">ponymail=abc123def456...</code></p>
  <p><strong>Step 3:</strong> Paste it below:</p>
  <form method="POST" action="/save">
    <input name="cookie" type="text" placeholder="ponymail=..." 
      style="width:100%;padding:10px;font-size:1em;font-family:monospace;border:1px solid #ccc;border-radius:4px" />
    <br><br>
    <button type="submit" 
      style="padding:10px 24px;font-size:1em;background:#0066cc;color:white;border:none;border-radius:4px;cursor:pointer">
      Save Cookie
    </button>
  </form>
  <p style="color:#888;margin-top:30px;font-size:0.9em">
    The cookie will be saved to <code>~/.ponymail-mcp/session.json</code> and used for API requests.
    This page will close automatically after saving. Session expires after ~20 hours.
  </p>
</body>
</html>`;
}

function resultPage(success, message) {
  const icon = success ? "✅" : "❌";
  const color = success ? "#2e7d32" : "#c62828";
  return `<!DOCTYPE html>
<html>
<head><title>PonyMail MCP Login</title></head>
<body style="font-family:system-ui;max-width:640px;margin:40px auto;padding:0 20px;text-align:center">
  <h1 style="color:${color}">${icon} ${success ? "Authenticated!" : "Not Authenticated"}</h1>
  <p>${message}</p>
  ${success ? "<p>You can close this tab and return to Amazon Quick.</p>" : '<p><a href="/">← Try again</a></p>'}
</body>
</html>`;
}
