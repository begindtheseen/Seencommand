// The zero-cost ad designer: Canvas 2D templates in Seen's own brand (the seenjobs.io tokens + its fonts,
// Syne / Instrument Sans / DM Mono under the SIL OFL, vendored in lib/growth/assets/fonts) at five sizes —
// 1080×1080, 1080×1350, 1080×1920, 1200×628, 1500×500. Text is fitted (shrinks, wraps, then ellipsizes —
// never spills), every data card carries a source line, margins are safe for platform UI, and a layout
// rendered from sample data is stamped "SAMPLE LAYOUT — NOT REAL DATA" so it can never be posted by mistake.
// Icons: Lucide v0.460.0 paths (ISC licence, lib/growth/assets/LICENSE-lucide.txt).
// Plain browser JS, inlined into the dashboard by scripts/build-dashboard.mjs. Also loadable in Node (vm)
// for tests and for the server's template list: nothing here touches the DOM until render() is called.
(function (root) {
  var T = {
    ink: '#05070f', deep: '#02040a', panel: '#0c0f1a', line: 'rgba(255,255,255,0.10)', text: '#e5e7eb', sub: '#9ca3af', white: '#f9fafb', faint: 'rgba(255,255,255,0.06)',
    green: '#10b981', red: '#ef4444', amber: '#f59e0b', blue: '#3b82f6', indigo: '#6366f1', violet: '#7c3aed', purple: '#a855f7',
    grad: ['#1d4ed8', '#7c3aed', '#a855f7'], display: 'Syne', body: 'Instrument Sans', mono: 'DM Mono',
  };
  var SIZES = {
    square: { w: 1080, h: 1080, label: 'Square 1080×1080', use: 'Instagram / LinkedIn / Reddit feed' },
    portrait: { w: 1080, h: 1350, label: 'Portrait 1080×1350', use: 'Instagram / LinkedIn feed (tallest feed post)' },
    story: { w: 1080, h: 1920, label: 'Story 1080×1920', use: 'Stories, Reels, TikTok, Shorts covers' },
    link: { w: 1200, h: 628, label: 'Link card 1200×628', use: 'X / LinkedIn / Facebook link shares' },
    banner: { w: 1500, h: 500, label: 'Banner 1500×500', use: 'X header, newsletter header' },
  };
  // Lucide v0.460.0 (ISC). circle/polyline elements converted to equivalent path data.
  var circ = function (cx, cy, r) { return 'M' + (cx - r) + ' ' + cy + 'a' + r + ' ' + r + ' 0 1 0 ' + 2 * r + ' 0a' + r + ' ' + r + ' 0 1 0 ' + -2 * r + ' 0'; };
  var ICONS = {
    ghost: ['M9 10h.01', 'M15 10h.01', 'M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z'],
    check: [circ(12, 12, 10), 'm9 12 2 2 4-4'],
    search: [circ(11, 11, 8), 'm21 21-4.3-4.3'],
    arrow: ['M5 12h14', 'm12 5 7 7-7 7'],
    clock: [circ(12, 12, 10), 'M12 6 12 12 16 14'],
    shield: ['M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z', 'm9 12 2 2 4-4'],
    silent: ['M20.5 14.9A9 9 0 0 0 9.1 3.5', 'm2 2 20 20', 'M5.6 5.6C3 8.3 2.2 12.5 4 16l-2 6 6-2c3.4 1.8 7.6 1.1 10.3-1.7'],
    badge: ['M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z', 'm9 12 2 2 4-4'],
  };

  // ---- text fitting (pure: needs only ctx.font + ctx.measureText) ----------------------------------
  function font(weight, size, family) { return weight + ' ' + Math.round(size) + 'px "' + family + '"'; }
  function wrap(ctx, text, maxWidth) {
    var out = [];
    String(text == null ? '' : text).split('\n').forEach(function (para) {
      var words = para.split(/\s+/).filter(Boolean); var line = '';
      if (!words.length) { out.push(''); return; }
      words.forEach(function (w) {
        while (ctx.measureText(w).width > maxWidth && w.length > 1) { // a word wider than the box: hard-break it
          var k = w.length - 1; while (k > 1 && ctx.measureText((line ? line + ' ' : '') + w.slice(0, k)).width > maxWidth) k--;
          if (line && ctx.measureText(line + ' ' + w.slice(0, k)).width > maxWidth) { out.push(line); line = ''; continue; }
          out.push((line ? line + ' ' : '') + w.slice(0, k)); line = ''; w = w.slice(k);
        }
        var t = line ? line + ' ' + w : w;
        if (ctx.measureText(t).width <= maxWidth) line = t; else { if (line) out.push(line); line = w; }
      });
      out.push(line);
    });
    return out;
  }
  /**
   * Largest size in [min, max] at which `text` wraps into ≤ maxLines lines of ≤ maxWidth. At min it still
   * overflowing → keep maxLines and ellipsize the last one (overflow: true). Returns { size, lines, font, lineHeight, overflow }.
   */
  function fitText(ctx, text, o) {
    var max = o.max, min = o.min || Math.max(10, Math.round(o.max * 0.35)), lines = o.maxLines || 1, lh = o.lineHeight || 1.12;
    var w = o.weight || 600, fam = o.family || T.body;
    for (var size = max; size >= min; size -= Math.max(1, Math.round(size * 0.04))) {
      ctx.font = font(w, size, fam);
      var l = wrap(ctx, text, o.maxWidth);
      if (l.length <= lines && l.every(function (x) { return ctx.measureText(x).width <= o.maxWidth; })) return { size: size, lines: l, font: ctx.font, lineHeight: size * lh, overflow: false };
    }
    ctx.font = font(w, min, fam);
    var all = wrap(ctx, text, o.maxWidth), kept = all.slice(0, lines);
    if (all.length > lines) { var last = kept[lines - 1] + '…'; while (last.length > 1 && ctx.measureText(last).width > o.maxWidth) last = last.slice(0, -2).replace(/\s+$/, '') + '…'; kept[lines - 1] = last; }
    return { size: min, lines: kept, font: ctx.font, lineHeight: min * lh, overflow: all.length > lines };
  }
  function drawLines(ctx, fit, x, y, o) {
    o = o || {}; ctx.font = fit.font; ctx.fillStyle = o.color || T.white; ctx.textBaseline = 'alphabetic'; ctx.textAlign = o.align || 'left';
    fit.lines.forEach(function (l, i) { ctx.fillText(l, x, y + fit.size * 0.86 + i * fit.lineHeight); });
    return fit.size + (fit.lines.length - 1) * fit.lineHeight;
  }

  // ---- brand primitives ------------------------------------------------------------------------------
  function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function gradient(ctx, x0, y0, x1, y1) { var g = ctx.createLinearGradient(x0, y0, x1, y1); g.addColorStop(0, T.grad[0]); g.addColorStop(0.55, T.grad[1]); g.addColorStop(1, T.grad[2]); return g; }
  function background(ctx, W, H) {
    ctx.fillStyle = T.ink; ctx.fillRect(0, 0, W, H);
    var R = Math.max(W, H);
    var g1 = ctx.createRadialGradient(W * 0.18, -H * 0.05, 0, W * 0.18, -H * 0.05, R * 0.95); g1.addColorStop(0, 'rgba(99,102,241,0.22)'); g1.addColorStop(1, 'rgba(99,102,241,0)'); ctx.fillStyle = g1; ctx.fillRect(0, 0, W, H);
    var g2 = ctx.createRadialGradient(W * 0.95, H * 1.05, 0, W * 0.95, H * 1.05, R * 0.8); g2.addColorStop(0, 'rgba(124,58,237,0.20)'); g2.addColorStop(1, 'rgba(124,58,237,0)'); ctx.fillStyle = g2; ctx.fillRect(0, 0, W, H);
    // a fine dot grid for texture
    var step = Math.round(Math.min(W, H) / 20); ctx.fillStyle = 'rgba(255,255,255,0.035)';
    for (var gx = step / 2; gx < W; gx += step) for (var gy = step / 2; gy < H; gy += step) { ctx.beginPath(); ctx.arc(gx, gy, Math.max(1, step * 0.03), 0, Math.PI * 2); ctx.fill(); }
  }
  function icon(ctx, name, x, y, size, color, width) {
    if (typeof Path2D === 'undefined') return;
    ctx.save(); ctx.translate(x, y); ctx.scale(size / 24, size / 24); ctx.strokeStyle = color; ctx.lineWidth = width || 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    (ICONS[name] || []).forEach(function (d) { ctx.stroke(new Path2D(d)); }); ctx.restore();
  }
  function wordmark(ctx, x, y, size, o) { // y = baseline-centre line; returns the width
    o = o || {}; var r = size * 0.17; var cx = x + r, cy = y;
    ctx.save(); ctx.shadowColor = 'rgba(59,130,246,0.7)'; ctx.shadowBlur = size * 0.45; ctx.fillStyle = T.blue; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    ctx.font = font(800, size, T.display); ctx.fillStyle = T.white; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    var tx = x + r * 2 + size * 0.32; ctx.fillText('Seen', tx, cy + size * 0.04);
    var w = tx - x + ctx.measureText('Seen').width;
    if (o.domain) { ctx.font = font(500, size * 0.5, T.mono); ctx.fillStyle = T.sub; ctx.fillText('seenjobs.io', x + w + size * 0.45, cy + size * 0.05); w += size * 0.45 + ctx.measureText('seenjobs.io').width; }
    ctx.textBaseline = 'alphabetic'; return w;
  }
  function mark(ctx, cx, cy, r, alpha) { // the favicon "signal" mark: gradient ring + green core
    ctx.save(); ctx.globalAlpha = alpha == null ? 1 : alpha;
    ctx.lineWidth = r * 0.2; ctx.lineCap = 'round'; ctx.strokeStyle = gradient(ctx, cx - r, cy - r, cx + r, cy + r);
    ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI * 0.25 - 2.3, -Math.PI * 0.25 + 1.85); ctx.stroke();
    var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 0.9); g.addColorStop(0, 'rgba(16,185,129,0.55)'); g.addColorStop(1, 'rgba(16,185,129,0)'); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r * 0.9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = T.green; ctx.beginPath(); ctx.arc(cx, cy, r * 0.41, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.beginPath(); ctx.arc(cx - r * 0.14, cy - r * 0.14, r * 0.13, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  function pill(ctx, text, xRight, yMid, size, o) { // CTA pill, right-aligned at xRight; returns its box
    o = o || {}; ctx.font = font(600, size, T.body); var tw = ctx.measureText(text).width; var ic = size * 1.05; var padX = size * 1.0; var h = size * 2.3;
    var w = Math.min(o.maxWidth || 1e9, padX * 2 + tw + ic + size * 0.4); var x = xRight - w, y = yMid - h / 2;
    ctx.save(); ctx.shadowColor = 'rgba(124,58,237,0.45)'; ctx.shadowBlur = size * 1.2; ctx.fillStyle = gradient(ctx, x, y, x + w, y + h); rr(ctx, x, y, w, h, h / 2); ctx.fill(); ctx.restore();
    ctx.fillStyle = T.white; ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.font = font(600, size, T.body);
    ctx.fillText(text, x + padX, yMid + size * 0.04, w - padX * 2 - ic - size * 0.4); icon(ctx, 'arrow', x + w - padX - ic + size * 0.15, yMid - ic / 2, ic, T.white, 2.4);
    ctx.textBaseline = 'alphabetic'; return { x: x, y: y, w: w, h: h };
  }
  function chip(ctx, text, x, y, size, color, o) { // returns width
    o = o || {}; ctx.font = font(500, size, T.mono); var tw = ctx.measureText(text).width; var h = size * 2, w = tw + size * 1.6; var x0 = o.right ? x - w : x;
    ctx.fillStyle = hexA(color, 0.12); rr(ctx, x0, y, w, h, h / 2); ctx.fill(); ctx.strokeStyle = hexA(color, 0.45); ctx.lineWidth = Math.max(1, size * 0.08); ctx.stroke();
    ctx.fillStyle = color; ctx.textBaseline = 'middle'; ctx.fillText(text, x0 + size * 0.8, y + h / 2 + size * 0.05); ctx.textBaseline = 'alphabetic'; return w;
  }
  function hexA(hex, a) { var h = hex.replace('#', ''); var n = parseInt(h.length === 3 ? h.split('').map(function (c) { return c + c; }).join('') : h, 16); return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')'; }
  function sourceLine(ctx, text, x, y, maxWidth, size) { var f = fitText(ctx, text, { maxWidth: maxWidth, max: size, min: Math.max(11, size * 0.6), weight: 500, family: T.mono }); ctx.globalAlpha = 0.9; drawLines(ctx, f, x, y, { color: T.sub }); ctx.globalAlpha = 1; return f.size; }
  function sampleStamp(ctx, W, s) {
    var h = 44 * s; ctx.fillStyle = 'rgba(245,158,11,0.92)'; ctx.fillRect(0, 0, W, h);
    ctx.font = font(500, 20 * s, T.mono); ctx.fillStyle = '#1a1205'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('SAMPLE LAYOUT — NOT REAL DATA · fill from a live callout before posting', W / 2, h / 2 + 1); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }
  var metricColor = function (ghostPct) { return ghostPct >= 50 ? T.red : ghostPct >= 30 ? T.amber : T.green; };
  var confColor = function (c) { return /high|good/i.test(c || '') ? T.green : /moderate/i.test(c || '') ? T.blue : T.amber; };
  function frame(W, H) { // layout family + scale + safe margins (story keeps clear of top/bottom app UI)
    var kind = W / H > 1.6 ? 'wide' : H / W > 1.5 ? 'story' : H > W ? 'portrait' : 'square';
    var s = kind === 'wide' ? H / 628 * (W / H > 2.5 ? 1.08 : 0.95) : W / 1080; var m = Math.round((kind === 'wide' ? 56 : 72) * s);
    var top = kind === 'story' ? Math.round(H * 0.13) : m, bottom = kind === 'story' ? Math.round(H * 0.18) : m;
    return { kind: kind, s: s, m: m, top: top, bottom: bottom, x0: m, x1: W - m, y0: top, y1: H - bottom, w: W - 2 * m };
  }

  // ---- layout: blocks stacked in the content box, shrunk together until they fit, then centred ----------
  // A block is { h, draw(y) }. build(k) returns the blocks at scale k (1 = full size); the first k whose
  // blocks fit the box wins, so nothing ever runs into the footer.
  function textBlock(ctx, text, o) {
    var f = fitText(ctx, text, o); var h = f.size + (f.lines.length - 1) * f.lineHeight + (o.descent == null ? f.size * 0.18 : o.descent);
    return { h: h, fit: f, draw: function (y) { drawLines(ctx, f, o.x, y, { color: o.color, align: o.align }); } };
  }
  var gapB = function (h) { return { h: h }; };
  function stack(build, top, bottom, o) {
    o = o || {}; var avail = bottom - top, blocks = null, total = 0;
    for (var k = 1; k >= 0.5; k -= 0.06) { blocks = build(k); total = blocks.reduce(function (n, b) { return n + b.h; }, 0); if (total <= avail) break; }
    var y = top + (o.center === false ? 0 : Math.max(0, (avail - total) * (o.bias == null ? 0.5 : o.bias)));
    blocks.forEach(function (b) { if (b.draw) b.draw(y); y += b.h; });
    return { top: top, used: total };
  }
  // The content box above the footer (and above the source line, when the card has one).
  function content(F, hasSource) { var foot = F.y1 - (F.kind === 'wide' ? 64 : 84) * F.s; var src = foot - (F.kind === 'wide' ? 46 : 64) * F.s; return { top: F.y0, bottom: (hasSource ? src : foot) - (F.kind === 'wide' ? 22 : 36) * F.s, src: src, foot: foot }; }
  function footer(ctx, F, cta) {
    var s = F.kind === 'wide' ? F.s * 0.86 : F.s; var y = F.y1 - 26 * s;
    wordmark(ctx, F.x0, y, 40 * s, { domain: F.kind !== 'wide' || F.w > 1000 * F.s });
    if (cta) pill(ctx, cta, F.x1, y, 25 * s, { maxWidth: F.w * 0.5 });
  }

  // ---- templates -----------------------------------------------------------------------------------------
  var TEMPLATES = {
    'data-callout': {
      name: 'Data callout', what: 'One employer\'s ghost (or response) rate, its sample size, confidence and source.',
      fields: ['name', 'ghostPct', 'responsePct', 'reports', 'confidence', 'sourceLine', 'cta', 'metric'],
      sample: { sample: true, name: 'Example Staffing Co.', ghostPct: 72, responsePct: 28, reports: 18, confidence: 'Low confidence', sourceLine: 'seenjobs.io · 18 applicant reports, trust-weighted · low confidence · as of 2026-10-21 PT', cta: 'Check before you apply', metric: 'ghost' },
      draw: function (ctx, W, H, d) {
        var F = frame(W, H), s = F.s, C = content(F, true); var resp = d.metric === 'response'; var pct = resp ? d.responsePct : d.ghostPct;
        var col = resp ? (pct >= 50 ? T.green : T.amber) : metricColor(pct); var label = resp ? 'RESPONSE RATE' : 'GHOST RATE';
        var sub = (resp ? 'heard back' : 'never heard back') + ', across ' + d.reports + ' applicant reports';
        var eyebrow = function (k, size) { return { h: size * 2 + 26 * s * k, draw: function (y) { chip(ctx, 'APPLICANT-REPORTED · ' + label, F.x0, y, size, T.indigo); } }; };
        var confChip = function (size) { return { h: size * 2, draw: function (y) { chip(ctx, d.confidence + ' · ' + d.reports + ' reports', F.x0, y, size, confColor(d.confidence)); } }; };
        var number = function (k, maxW, x, align, max) { var b = textBlock(ctx, pct + '%', { x: x, align: align, color: col, maxWidth: maxW, max: max * s * k, min: 70 * s, weight: 800, family: T.display, lineHeight: 1, descent: 0 });
          return { h: b.h * 0.98, draw: function (y) { ctx.save(); ctx.shadowColor = hexA(col, 0.38); ctx.shadowBlur = 70 * s; b.draw(y - b.fit.size * 0.06); ctx.restore(); } }; };
        if (F.kind === 'wide') {
          var colW = F.w * 0.55, rx = F.x0 + colW + 44 * s, rw = F.x1 - rx;
          stack(function (k) { return [eyebrow(k, 15 * s), textBlock(ctx, d.name, { x: F.x0, maxWidth: colW, maxLines: 2, max: 60 * s * k, min: 26 * s, weight: 700, family: T.display, lineHeight: 1.05 }), gapB(10 * s * k),
            textBlock(ctx, sub, { x: F.x0, maxWidth: colW, maxLines: 2, max: 27 * s * k, min: 15 * s, weight: 500, color: T.text }), gapB(16 * s * k), confChip(14 * s)]; }, C.top, C.bottom);
          stack(function (k) { var n = number(k, rw, F.x1, 'right', 240); return [n, gapB(22 * s * k), { h: 12 * s, draw: function (y) { bar(ctx, rx, y, rw, 12 * s, pct, col); } }]; }, C.top, C.bottom);
        } else {
          var tall = F.kind !== 'square';
          stack(function (k) {
            var b = [eyebrow(k, 20 * s), textBlock(ctx, d.name, { x: F.x0, maxWidth: F.w, maxLines: 2, max: 92 * s * k, min: 40 * s, weight: 700, family: T.display, lineHeight: 1.04 }), gapB((tall ? 36 : 14) * s * k),
              number(k, F.w, F.x0 - 6 * s, 'left', tall ? 400 : 330), gapB(18 * s * k),
              textBlock(ctx, sub, { x: F.x0, maxWidth: F.w, maxLines: 2, max: 40 * s * k, min: 22 * s, weight: 500, color: T.text }), gapB(22 * s * k),
              { h: 16 * s, draw: function (y) { bar(ctx, F.x0, y, F.w, 16 * s, pct, col); } }, gapB(32 * s * k), confChip(20 * s)];
            if (tall) b.push(gapB(54 * s * k), textBlock(ctx, 'A small sample is labelled small. When there is no data, Seen says so.', { x: F.x0, maxWidth: F.w, maxLines: 3, max: 34 * s * k, min: 20 * s, weight: 400, color: T.sub, lineHeight: 1.3 }));
            return b;
          }, C.top, C.bottom, { bias: tall ? 0.45 : 0.3 });
        }
        sourceLine(ctx, d.sourceLine, F.x0, C.src, F.w, (F.kind === 'wide' ? 16 : 21) * s); footer(ctx, F, d.cta);
      },
    },
    'agency-leaderboard': {
      name: 'Agency index leaderboard', what: 'Ranked staffing agencies by applicant-reported ghost rate, each with its report count.',
      fields: ['title', 'subtitle', 'rows', 'sourceLine', 'cta'],
      sample: { sample: true, title: 'Staffing Agency Ghost Index', rows: [{ name: 'Example Agency A', ghostPct: 81, reports: 12, confidence: 'Low confidence' }, { name: 'Example Agency B', ghostPct: 64, reports: 25, confidence: 'Moderate confidence' }, { name: 'Example Agency C', ghostPct: 52, reports: 9, confidence: 'Low confidence' }, { name: 'Example Agency D', ghostPct: 37, reports: 31, confidence: 'Moderate confidence' }, { name: 'Example Agency E', ghostPct: 22, reports: 7, confidence: 'Low confidence' }], sourceLine: 'seenjobs.io/agencies · applicant reports, trust-weighted · as of 2026-10-21 PT', cta: 'See the full index' },
      draw: function (ctx, W, H, d) {
        var F = frame(W, H), s = F.s, C = content(F, true); var wide = F.kind === 'wide'; var banner = wide && W / H > 2.5;
        var maxRows = banner ? 3 : wide ? 4 : F.kind === 'story' ? 7 : F.kind === 'portrait' ? 6 : 5;
        var rows = (d.rows || []).slice(0, maxRows);
        var headH = 0;
        var title = function (k) { var iz = (wide ? 40 : 56) * s * k; var t = textBlock(ctx, d.title || 'Staffing Agency Ghost Index', { x: F.x0 + iz + 18 * s, maxWidth: F.w - iz - 18 * s, maxLines: wide ? 1 : 2, max: (wide ? 46 : 64) * s * k, min: 24 * s, weight: 700, family: T.display, lineHeight: 1.05 });
          return { h: Math.max(iz, t.h), draw: function (y) { icon(ctx, 'ghost', F.x0, y + Math.max(0, (t.fit.size - iz) / 2), iz, T.purple, 2); t.draw(y); } }; };
        var rowBlock = function (r, i, rh) { var col = metricColor(r.ghostPct); var ih = rh - 12 * s;
          return { h: rh, draw: function (y) {
            ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.05)'; rr(ctx, F.x0 - 16 * s, y, F.w + 32 * s, ih, Math.min(20 * s, ih / 3)); ctx.fill();
            var mid = y + ih / 2; ctx.textBaseline = 'middle';
            ctx.font = font(500, ih * 0.27, T.mono); ctx.fillStyle = T.sub; ctx.fillText(String(i + 1).padStart(2, '0'), F.x0 + 2 * s, mid);
            var nx = F.x0 + ih * 0.78, nameW = F.w * (wide ? 0.36 : 0.46);
            var nf = fitText(ctx, r.name, { maxWidth: nameW, max: ih * 0.3, min: ih * 0.18, weight: 600 }); ctx.font = nf.font; ctx.fillStyle = T.white; ctx.fillText(nf.lines[0], nx, mid - ih * 0.14);
            ctx.font = font(500, ih * 0.17, T.mono); ctx.fillStyle = T.sub; ctx.fillText(r.reports + ' reports · ' + String(r.confidence || '').replace(/ confidence/i, '').toLowerCase(), nx, mid + ih * 0.2);
            var pctW = ih * 1.45, bx = nx + nameW + 24 * s, bw = F.x1 - bx - pctW;
            bar(ctx, bx, mid - 6 * s, bw, 12 * s, r.ghostPct, col);
            ctx.font = font(800, ih * 0.34, T.display); ctx.fillStyle = col; ctx.textAlign = 'right'; ctx.fillText(r.ghostPct + '%', F.x1 + 4 * s, mid + 2 * s); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
          } }; };
        stack(function (k) {
          var b = [title(k), gapB((wide ? 10 : 18) * s * k), textBlock(ctx, d.subtitle || 'Ghost rate from applicant reports — most-reported first, sample size on every row', { x: F.x0, maxWidth: F.w, max: (wide ? 18 : 25) * s * k, min: 12 * s, weight: 500, color: T.sub }), gapB((wide ? 14 : 26) * s * k)];
          headH = b.reduce(function (n, x) { return n + x.h; }, 0);
          var rh = Math.min((banner ? 92 : wide ? 76 : 132) * s * k, (C.bottom - C.top - headH) / Math.max(1, rows.length));
          if (!rows.length) b.push(textBlock(ctx, 'No agency has enough reports yet — that is the honest answer.', { x: F.x0, maxWidth: F.w, maxLines: 2, max: 30 * s, min: 16 * s, weight: 500, color: T.sub }));
          rows.forEach(function (r, i) { b.push(rowBlock(r, i, rh)); });
          return b;
        }, C.top, C.bottom, { bias: 0.4 });
        sourceLine(ctx, d.sourceLine, F.x0, C.src, F.w, (wide ? 15 : 21) * s); footer(ctx, F, d.cta);
      },
    },
    quote: {
      name: 'Quote / statement card', what: 'A real, attributed quote (with permission) — or, without attribution, a plain brand statement.',
      fields: ['text', 'attribution', 'context', 'cta'],
      sample: { text: 'Silence is information. Check whether they answer applicants before you spend the hour.', attribution: '', context: 'From the founder of Seen', cta: 'Check a company' },
      draw: function (ctx, W, H, d) {
        var F = frame(W, H), s = F.s, C = content(F, false); var quoted = !!(d.attribution && d.attribution.trim()); var wide = F.kind === 'wide';
        var textW = wide ? F.w * 0.7 : F.w;
        if (wide) mark(ctx, F.x1 - 110 * s, (C.top + C.bottom) / 2, Math.min(100 * s, (C.bottom - C.top) * 0.42), 0.95);
        stack(function (k) {
          var b = [];
          if (quoted) { var qs = (wide ? 120 : 220) * s * k; b.push({ h: qs * 0.5, draw: function (y) { ctx.font = font(800, qs, T.display); ctx.fillStyle = gradient(ctx, F.x0, y, F.x0 + qs, y + qs); ctx.fillText('“', F.x0 - 8 * s, y + qs * 0.72); } }); }
          else b.push({ h: (wide ? 15 : 20) * s * 2 + (wide ? 20 : 34) * s * k, draw: function (y) { chip(ctx, (d.context || 'Seen').toUpperCase(), F.x0, y, (wide ? 15 : 20) * s, T.indigo); } });
          b.push(textBlock(ctx, d.text, { x: F.x0, maxWidth: textW, maxLines: wide ? 3 : F.kind === 'story' ? 8 : 6, max: (wide ? 50 : F.kind === 'story' ? 88 : 76) * s * k, min: 24 * s, weight: 700, family: T.display, lineHeight: 1.14 }));
          if (quoted) { b.push(gapB(34 * s * k), { h: 4 * s, draw: function (y) { ctx.fillStyle = gradient(ctx, F.x0, 0, F.x0 + 64 * s, 0); ctx.fillRect(F.x0, y, 64 * s, 4 * s); } }, gapB(26 * s * k),
            textBlock(ctx, '— ' + d.attribution + (d.context ? ', ' + d.context : ''), { x: F.x0, maxWidth: textW, maxLines: 2, max: 30 * s * k, min: 16 * s, weight: 500, color: T.sub })); }
          return b;
        }, C.top, C.bottom, { bias: 0.42 });
        footer(ctx, F, d.cta);
      },
    },
    'cta-banner': {
      name: 'Headline + CTA', what: 'The promise in one line with a call to action — link cards, headers, ads.',
      fields: ['headline', 'sub', 'cta'],
      sample: { headline: 'Check if they ghost before you apply.', sub: 'Response and ghost rates for employers and staffing agencies, from applicant reports — with the sample size on every number.', cta: 'Look one up — free' },
      draw: function (ctx, W, H, d) {
        var F = frame(W, H), s = F.s, C = content(F, false); var wide = F.kind === 'wide';
        if (wide) {
          var r = Math.min((C.bottom - C.top) * 0.46, 150 * s); mark(ctx, F.x1 - r - 6 * s, (C.top + C.bottom) / 2 + 6 * s, r, 1);
          var colW = F.w - r * 2 - 70 * s;
          stack(function (k) { return [textBlock(ctx, d.headline, { x: F.x0, maxWidth: colW, maxLines: 2, max: 70 * s * k, min: 28 * s, weight: 700, family: T.display, lineHeight: 1.04 }), gapB(18 * s * k),
            textBlock(ctx, d.sub, { x: F.x0, maxWidth: colW * 0.94, maxLines: 3, max: 25 * s * k, min: 14 * s, weight: 400, color: T.sub, lineHeight: 1.32 })]; }, C.top, C.bottom);
        } else {
          stack(function (k) { var mr = 64 * s * k; return [{ h: mr * 2, draw: function (y) { mark(ctx, F.x0 + mr, y + mr, mr, 1); } }, gapB(64 * s * k),
            textBlock(ctx, d.headline, { x: F.x0, maxWidth: F.w, maxLines: 4, max: (F.kind === 'story' ? 132 : 112) * s * k, min: 44 * s, weight: 700, family: T.display, lineHeight: 1.04 }), gapB(40 * s * k),
            { h: 6 * s, draw: function (y) { ctx.fillStyle = gradient(ctx, F.x0, 0, F.x0 + 120 * s, 0); ctx.fillRect(F.x0, y, 120 * s, 6 * s); } }, gapB(40 * s * k),
            textBlock(ctx, d.sub, { x: F.x0, maxWidth: F.w * 0.94, maxLines: 4, max: 38 * s * k, min: 20 * s, weight: 400, color: T.text, lineHeight: 1.34 })]; }, C.top, C.bottom, { bias: 0.4 });
        }
        footer(ctx, F, d.cta);
      },
    },
    steps: {
      name: 'How it works (3 steps)', what: 'Check → apply where they answer → put the outcome on the record.',
      fields: ['title', 'steps', 'cta'],
      sample: { title: 'Ten seconds before every application', steps: ['Look up the employer or agency on Seen', 'Apply where people actually hear back', 'Ghosted? Put it on the record — it warns the next applicant'], cta: 'Try it — seenjobs.io' },
      draw: function (ctx, W, H, d) {
        var F = frame(W, H), s = F.s, C = content(F, false); var wide = F.kind === 'wide'; var icons = ['search', 'check', 'silent']; var cols = [T.blue, T.green, T.red];
        var steps = (d.steps || []).slice(0, 3);
        stack(function (k) {
          var b = [textBlock(ctx, d.title, { x: F.x0, maxWidth: F.w, maxLines: 2, max: (wide ? 46 : 76) * s * k, min: 24 * s, weight: 700, family: T.display, lineHeight: 1.06 }), gapB((wide ? 22 : 48) * s * k)];
          if (wide) {
            var cw = (F.w - 36 * s) / 3; var ch = Math.min(250 * s * k, C.bottom - C.top - b[0].h - 22 * s * k);
            b.push({ h: ch, draw: function (y) { steps.forEach(function (st, i) { var x = F.x0 + i * (cw + 18 * s); ctx.fillStyle = 'rgba(255,255,255,0.05)'; rr(ctx, x, y, cw, ch, 18 * s); ctx.fill();
              var iz = Math.min(36 * s, ch * 0.24); icon(ctx, icons[i], x + 20 * s, y + 18 * s, iz, cols[i], 2);
              var f = fitText(ctx, st, { maxWidth: cw - 40 * s, maxLines: 3, max: Math.min(30 * s, ch * 0.19), min: 12 * s, weight: 600, lineHeight: 1.2 }); drawLines(ctx, f, x + 20 * s, y + 18 * s + iz + 14 * s); }); } });
          } else {
            var bh = Math.min(220 * s * k, (C.bottom - C.top - b[0].h - 48 * s) / 3);
            steps.forEach(function (st, i) { b.push({ h: bh, draw: function (y) { var ih = bh - 22 * s, mid = y + ih / 2; ctx.fillStyle = 'rgba(255,255,255,0.05)'; rr(ctx, F.x0, y, F.w, ih, 26 * s); ctx.fill();
              ctx.fillStyle = hexA(cols[i], 0.14); ctx.beginPath(); ctx.arc(F.x0 + 70 * s, mid, 42 * s, 0, Math.PI * 2); ctx.fill(); icon(ctx, icons[i], F.x0 + 47 * s, mid - 23 * s, 46 * s, cols[i], 2);
              var f = fitText(ctx, st, { maxWidth: F.w - 180 * s, maxLines: 2, max: 40 * s, min: 20 * s, weight: 600, lineHeight: 1.18 }); var th = f.size + (f.lines.length - 1) * f.lineHeight;
              ctx.font = font(500, 21 * s, T.mono); ctx.fillStyle = T.sub; ctx.fillText('0' + (i + 1), F.x0 + 142 * s, mid - th / 2 - 12 * s);
              drawLines(ctx, f, F.x0 + 142 * s, mid - th / 2 + 4 * s); } }); });
          }
          return b;
        }, C.top, C.bottom, { bias: 0.4 });
        footer(ctx, F, d.cta);
      },
    },
  };
  function bar(ctx, x, y, w, h, pct, col) {
    ctx.fillStyle = 'rgba(255,255,255,0.08)'; rr(ctx, x, y, w, h, h / 2); ctx.fill();
    var fw = Math.max(h, w * Math.max(0, Math.min(100, pct)) / 100); ctx.fillStyle = col; rr(ctx, x, y, fw, h, h / 2); ctx.fill();
  }

  /** Validate data for a template: returns a list of missing fields (empty = renderable as real data). */
  function missing(templateId, d) {
    var t = TEMPLATES[templateId]; if (!t) return ['template'];
    if (templateId === 'data-callout') return ['name', 'reports', 'sourceLine'].filter(function (k) { return d[k] == null || d[k] === ''; }).concat(Number.isFinite(d.ghostPct) ? [] : ['ghostPct']);
    if (templateId === 'agency-leaderboard') return (d.rows && d.rows.length ? [] : ['rows']).concat(d.sourceLine ? [] : ['sourceLine']);
    if (templateId === 'quote') return d.text ? [] : ['text'];
    if (templateId === 'cta-banner') return d.headline ? [] : ['headline'];
    return [];
  }
  /** Draw `templateId` at `sizeId` onto `canvas` with `data` (sample data when none). Returns { w, h, sample, missing }. */
  function render(canvas, templateId, sizeId, data) {
    var t = TEMPLATES[templateId], sz = SIZES[sizeId]; if (!t || !sz) throw new Error('unknown template or size');
    var d = data || t.sample; var miss = missing(templateId, d); if (miss.length) { d = t.sample; }
    canvas.width = sz.w; canvas.height = sz.h; var ctx = canvas.getContext('2d');
    ctx.save(); background(ctx, sz.w, sz.h); t.draw(ctx, sz.w, sz.h, d); if (d.sample) sampleStamp(ctx, sz.w, frame(sz.w, sz.h).s); ctx.restore();
    return { w: sz.w, h: sz.h, sample: !!d.sample, missing: miss };
  }
  var fontsReady = null;
  function loadFonts(base) {
    if (fontsReady) return fontsReady;
    if (typeof FontFace === 'undefined' || typeof document === 'undefined') return Promise.resolve(false);
    base = base || '/api/growth/fonts/';
    var faces = [new FontFace(T.display, 'url(' + base + 'Syne.woff2)', { weight: '400 800' }), new FontFace(T.body, 'url(' + base + 'InstrumentSans.woff2)', { weight: '400 700' }), new FontFace(T.mono, 'url(' + base + 'DMMono-Medium.woff2)', { weight: '500' })];
    fontsReady = Promise.all(faces.map(function (f) { return f.load().then(function (x) { document.fonts.add(x); return true; }).catch(function () { return false; }); })).then(function (r) { return r.every(Boolean); });
    return fontsReady;
  }
  function meta() { return { sizes: SIZES, templates: Object.keys(TEMPLATES).map(function (id) { return { id: id, name: TEMPLATES[id].name, what: TEMPLATES[id].what, fields: TEMPLATES[id].fields }; }), tokens: T }; }
  root.GrowthDesign = { TOKENS: T, SIZES: SIZES, TEMPLATES: TEMPLATES, ICONS: ICONS, wrap: wrap, fitText: fitText, frame: frame, missing: missing, render: render, loadFonts: loadFonts, meta: meta };
})(typeof window !== 'undefined' ? window : globalThis);
