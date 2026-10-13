// The console's half of the per-boot API secret (lib/auth.js on the server).
// Loaded FIRST, before any script that calls the API.
//
// The server hands the secret to this page only, in a <meta>, and only to a
// browser holding the cookie the printed terminal link set. Every same-origin
// /api/* fetch then carries it as a header - which a cross-site page cannot
// set without a preflight, so it is the CSRF token too. EventSource cannot send
// headers, so a stream URL carries it as ?auth= instead (authUrl below).
//
// Wrapping window.fetch rather than editing every call site: the console has
// dozens of them, and one that forgot the header would be a silent 401. A
// wrapper cannot be forgotten.
(function () {
  'use strict';
  const meta = document.querySelector('meta[name="skillspace-auth"]');
  const secret = meta ? meta.getAttribute('content') : '';
  const HEADER = 'X-SkillSpace-Auth';
  const nativeFetch = window.fetch.bind(window);

  function isApi(url) {
    try {
      const u = new URL(url, location.href);
      return u.origin === location.origin && u.pathname.startsWith('/api/');
    } catch (_) { return false; }
  }

  // A key that stopped working means the server restarted. Say so once, in
  // words, rather than letting every panel fail on its own.
  let told = false;
  function tellLocked() {
    if (told) return;
    told = true;
    const n = document.createElement('div');
    n.setAttribute('role', 'alert');
    n.textContent = 'SkillSpace 已重启，这个页面的钥匙失效了：回到启动它的终端，重新打开里面打印的链接。';
    n.style.cssText = 'position:fixed;left:16px;right:16px;bottom:16px;z-index:9999;padding:12px 16px;' +
      'border-radius:8px;background:#5c1d1d;color:#fff;font:14px/1.5 system-ui,sans-serif';
    document.body.appendChild(n);
  }

  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    if (!isApi(url)) return nativeFetch(input, init);
    const headers = new Headers((init && init.headers) || (input && input.headers) || undefined);
    if (!headers.has(HEADER)) headers.set(HEADER, secret);
    return nativeFetch(input, Object.assign({}, init, { headers })).then((r) => {
      if (r.status === 401) tellLocked();
      return r;
    });
  };

  // For EventSource, which cannot send a header. GET only on the server side.
  window.skillspaceAuthUrl = function (url) {
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'auth=' + encodeURIComponent(secret);
  };
})();
