'use strict';

// Every /api/* request must carry the server's per-boot secret (lib/auth.js).
// A server whose stdout is not a TTY - every server a test spawns - prints the
// link redacted plus the path of the 0600 console-link file holding it (under
// its SKILLSPACE_HOME), which is the documented way for any launcher. This
// reads that path off stdout and the secret out of the file.
//
// Requiring this file wraps globalThis.fetch so a request to a port whose
// secret has been registered sends the header unless the caller set one. That
// keeps the hundreds of existing call sites unchanged and makes "forgot the
// header" impossible to write by accident; a test ABOUT the secret uses
// rawFetch, which is the untouched original.
const fs = require('fs');
const HEADER = 'X-SkillSpace-Auth';
const LINK_FILE = /console link: (.+)\n/;
const SECRET_IN_LINK = /\/\?auth=([0-9a-f]{64})/;

const rawFetch = globalThis.fetch;
const secrets = new Map(); // port (string) -> secret

// Resolves with the secret of a spawned server, via the console-link file its
// stdout names. Attach it right after spawn(): it listens for the line, it
// does not re-read earlier output.
function secretFrom(proc, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const cleanup = () => {
      clearTimeout(timer);
      proc.stdout.off('data', onData);
      proc.off('exit', onExit);
    };
    const onData = (c) => {
      buf += c;
      const m = buf.match(LINK_FILE);
      if (!m) return;
      cleanup();
      try {
        const link = fs.readFileSync(m[1].trim(), 'utf8');
        const k = link.match(SECRET_IN_LINK);
        if (k) resolve(k[1]); else reject(new Error('console-link file holds no link: ' + link));
      } catch (e) { reject(e); }
    };
    const onExit = () => { cleanup(); reject(new Error('server exited before naming its console-link file: ' + buf)); };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`no console-link file named on stdout within ${timeoutMs}ms: ${buf}`));
    }, timeoutMs);
    proc.stdout.on('data', onData);
    proc.on('exit', onExit);
  });
}

function register(port, secret) {
  secrets.set(String(port), secret);
  return secret;
}

function secretFor(port) {
  return secrets.get(String(port)) || null;
}

// "X-SkillSpace-Auth: <secret>\r\n" for a raw-socket request, or '' when the
// port has none registered.
function authLine(port) {
  const s = secretFor(port);
  return s ? `${HEADER}: ${s}\r\n` : '';
}

function urlOf(input) {
  if (typeof input === 'string') return input;
  if (input && typeof input.url === 'string') return input.url;
  return String(input);
}

function authedFetch(input, init) {
  let port;
  try { port = new URL(urlOf(input)).port; } catch (_) { return rawFetch(input, init); }
  const secret = secretFor(port);
  if (!secret) return rawFetch(input, init);
  const headers = new Headers((init && init.headers) || undefined);
  if (!headers.has(HEADER)) headers.set(HEADER, secret);
  return rawFetch(input, { ...(init || {}), headers });
}

globalThis.fetch = authedFetch;

module.exports = { HEADER, rawFetch, secretFrom, register, secretFor, authLine };
