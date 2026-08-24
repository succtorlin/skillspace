// Pure helpers: no DOM, no storage, no network. Split out so node:test can
// require() them - public/app.js ends in a bare boot() call, so requiring it
// would run the whole app. Loaded as a classic script before app.js, matching
// how icons.js already works.

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// escAttr exists for values that land inside an ATTRIBUTE - today the title on
// a project row, which carries a user-supplied path. esc() alone handles only
// & < >, so a path containing a double quote would close the attribute and let
// the rest parse as markup. Order matters: esc() escapes & first, so appending
// the quote replacement after it is what keeps " -> &quot; rather than
// &amp;quot;.
function escAttr(s) {
  return esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// What the rail should show for a given /api/projects response. `ok` is
// response.ok; `data` is the parsed body, or null if there was none.
// A structured error from a well-behaved server must NOT read as "empty":
// checking only Array.isArray(data.projects) sent a 500 {"error":…} into the
// empty state, which told the user to add projects they already have. The API
// accepts the same path twice, so following that advice duplicates records.
function railState(ok, data) {
  if (!ok || !data || data.error || !Array.isArray(data.projects)) {
    return { kind: 'error', projects: [] };
  }
  if (!data.projects.length) return { kind: 'empty', projects: [] };
  return { kind: 'list', projects: data.projects };
}

// What a DELETE response means. `body` is the parsed body, or null when the
// request produced none at all (unreachable server / unparseable response).
// shouldReload distinguishes the two failure kinds: a 404 says the record is
// already gone, so the view is stale and must reconcile or the phantom row
// keeps 404ing on every retry. An unreachable server says nothing about the
// record, so re-rendering would only trade a good list for an error box.
function deleteOutcome(body) {
  if (body === null) {
    return { ok: false, message: '删除失败：无法连接服务器', shouldReload: false };
  }
  if (!body || body.error || body.ok !== true) {
    return {
      ok: false,
      message: '删除失败：' + ((body && body.error) || '未知错误'),
      shouldReload: true,
    };
  }
  return { ok: true, message: null, shouldReload: true };
}

// Inert in the browser: a classic script has no `module`, so the typeof guard
// short-circuits and the declarations above simply stay globals.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { esc, escAttr, railState, deleteOutcome };
}
