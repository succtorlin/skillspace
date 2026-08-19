/* SkillSpace landing — live hero canvas.
 *
 * Discipline 3: the hero shows the product running, not a picture of it.
 * The metaphor is the product's actual behaviour — a directory being read and
 * assembled into a card wall — so cells land in a grid one after another,
 * carry a category tint, and settle. The data is simulated; the mechanics
 * (scan order, fill, category distribution) are the real ones.
 *
 * Lifecycle contract from references/canvas-hero.md:
 *   DPR-aware (capped at 2, re-applied on resize) · reduced-motion renders ONE
 *   static frame with the same composition · RAF cancelled while the tab is
 *   hidden · cleanup removes every listener · colours read from the CSS tokens
 *   so the canvas can never drift from the palette.
 */
(function () {
  const cv = document.getElementById("hero-canvas");
  if (!cv) return;
  const ctx = cv.getContext("2d");
  if (!ctx) return;

  // Palette-locked: pull the same values the stylesheet uses.
  const css = getComputedStyle(document.querySelector(".page"));
  const tok = (n, f) => (css.getPropertyValue(n) || "").trim() || f;
  const ACCENT = tok("--accent", "#6ee7b7");
  const HAIR = tok("--hair", "#262626");
  const HAIR_LIT = tok("--hair-lit", "#3a3a3a");
  const INK2 = tok("--ink-2", "#b8b8b8");
  const GROUND = tok("--ground", "#0d0d0d");

  const reduce = window.matchMedia("(prefers-reduced-motion:reduce)").matches;

  // ---- DPR-aware sizing, re-applied on resize ----
  let W = 0, H = 0, cols = 0, rows = 0, cw = 0, ch = 0;
  const GAP = 6;
  const size = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = cv.getBoundingClientRect();
    W = rect.width; H = rect.height;
    cv.width = Math.max(1, Math.round(W * dpr));
    cv.height = Math.max(1, Math.round(H * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.max(2, Math.round(W / 108));
    rows = Math.max(2, Math.round(H / 74));
    cw = (W - GAP * (cols - 1)) / cols;
    ch = (H - GAP * (rows - 1)) / rows;
  };
  size();

  // ---- cells: a directory being read in order ----
  // Category mix mirrors the real app's distribution — most skills are
  // uncategorised-ish, a minority carry a strong category.
  let cells = [];
  const build = () => {
    cells = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        cells.push({
          x: c * (cw + GAP),
          y: r * (ch + GAP),
          // scan order: left-to-right, top-to-bottom, like reading a directory
          order: r * cols + c,
          tagged: Math.random() < 0.28,      // carries a category chip
          lines: 1 + Math.round(Math.random()), // 1-2 lines of "description"
          t: 0,                               // 0..1 fill progress
        });
      }
    }
  };
  build();

  const ease = (t) => 1 - Math.pow(1 - t, 3);

  const drawCell = (cell, a) => {
    if (a <= 0) return;
    const x = cell.x, y = cell.y, w = cw, h = ch;
    ctx.globalAlpha = a;

    // card body — hairline only, matching the direction's separation strategy
    ctx.fillStyle = "#141414";
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = a > 0.92 ? HAIR_LIT : HAIR;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

    // title bar
    ctx.fillStyle = INK2;
    ctx.globalAlpha = a * 0.85;
    ctx.fillRect(x + 8, y + 9, Math.min(w - 40, w * 0.52), 3);

    // description lines
    ctx.globalAlpha = a * 0.32;
    for (let i = 0; i < cell.lines; i++) {
      ctx.fillRect(x + 8, y + 19 + i * 6, w * (0.66 - i * 0.14), 2);
    }

    // category chip — the accent, used sparingly, exactly as on the real cards
    if (cell.tagged) {
      ctx.globalAlpha = a;
      ctx.fillStyle = ACCENT;
      ctx.fillRect(x + w - 20, y + 8, 12, 4);
    }

    // the action outline — hairline, never filled (mirrors the app)
    ctx.globalAlpha = a * 0.75;
    ctx.strokeStyle = ACCENT;
    ctx.strokeRect(x + w - 30.5, y + h - 14.5, 22, 7);
    ctx.globalAlpha = 1;
  };

  const frame = (progress) => {
    ctx.setTransform(Math.min(window.devicePixelRatio || 1, 2), 0, 0, Math.min(window.devicePixelRatio || 1, 2), 0, 0);
    ctx.fillStyle = GROUND;
    ctx.fillRect(0, 0, W, H);

    // faint reference grid behind everything
    ctx.globalAlpha = 1;
    ctx.strokeStyle = HAIR;
    ctx.lineWidth = 1;
    for (const cell of cells) {
      ctx.globalAlpha = 0.35;
      ctx.strokeRect(cell.x + 0.5, cell.y + 0.5, cw - 1, ch - 1);
    }
    ctx.globalAlpha = 1;

    const total = cells.length;
    for (const cell of cells) {
      // each cell starts when the scan reaches it, then fills over ~18% of the run
      const start = cell.order / total;
      const local = (progress - start) / 0.18;
      drawCell(cell, ease(Math.max(0, Math.min(1, local))));
    }
  };

  // ---- reduced motion: ONE static frame, same composition, no loop ----
  if (reduce) {
    frame(1.4); // fully settled
    const onResizeStatic = () => { size(); build(); frame(1.4); };
    window.addEventListener("resize", onResizeStatic, { passive: true });
    return;
  }

  let raf = 0;
  let t0 = 0;
  const DURATION = 5200; // one full assembly pass
  const HOLD = 1400;     // settled before it restarts

  const tick = (ts) => {
    if (!t0) t0 = ts;
    const elapsed = (ts - t0) % (DURATION + HOLD);
    const progress = Math.min(1.25, elapsed / DURATION);
    frame(progress);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  // ---- pause while hidden: a tab left open must not spin a core ----
  const onVisibility = () => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
    } else if (!raf) {
      t0 = 0;
      raf = requestAnimationFrame(tick);
    }
  };
  document.addEventListener("visibilitychange", onVisibility);

  const onResize = () => { size(); build(); };
  window.addEventListener("resize", onResize, { passive: true });

  // ---- cleanup: cancel RAF, remove every listener added ----
  window.addEventListener("pagehide", () => {
    cancelAnimationFrame(raf);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("resize", onResize);
  });
})();
