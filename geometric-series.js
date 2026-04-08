const $ = id => document.getElementById(id);
const rSlider = $('rSlider');
const rValueEl = $('rValue');
const MAX_N = 50;
const partialSumEl = $('partialSum'), termNumEl = $('termNum');
const headerR = $('headerR');
const sequenceEl = $('sequence');
const canvas = $('chart'), ctx = canvas.getContext('2d');
const bobCanvas = $('bobCanvas'), bobCtx = bobCanvas.getContext('2d');
const bobDistanceEl = $('bobDistance');
const playBtn = $('playBtn'), stepBtn = $('stepBtn'), resetBtn = $('resetBtn');
const speedBtns = document.querySelectorAll('.speed-btn');

const negToggle = $('negToggle');
let rNegative = false;
let visibleCount = 0, isPlaying = false, playTimer = null, speed = 550, bobDone = false;
// Bob's view bounds (fast lerp)
let bobViewMin = null, bobViewMax = null;
let bobTargetMin = null, bobTargetMax = null;
let bobZooming = false;
// Bob arc animation state — hop first, pause, then zoom
let bobArcT = 1;           // 0..1 progress along current arc (1 = done)
let bobArcAnimating = false;
let bobZoomPending = false; // zoom queued until hop finishes
let bobPauseFrames = 0;    // pause frames between hop and zoom

function fmt(v, d = 4) {
  const abs = Math.abs(v);
  if (abs === 0) return '0';
  if (abs > 1e6 || (abs < 0.001 && abs > 0)) return v.toExponential(2);
  return Number(v.toFixed(d)).toString();
}

function series(a, r, n) {
  const terms = [], partials = [];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const t = a * Math.pow(r, i);
    sum += t; terms.push(t); partials.push(sum);
  }
  return { terms, partials };
}

function drawChart(partials, totalN, a, r) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  const W = rect.width, H = rect.height;
  ctx.clearRect(0, 0, W, H);

  const pad = { top: 25, right: 25, bottom: 40, left: 60 };
  const pw = W - pad.left - pad.right;
  const ph = H - pad.top - pad.bottom;
  const n = partials.length;

  // Y-axis based on partial sums up to the next group of 10 (minimum 10)
  const nextBucket = Math.max(Math.ceil(n / 10) * 10, 10);
  const bucketPartials = series(a, r, Math.min(nextBucket, totalN)).partials;

  let yMin = Math.min(0, ...bucketPartials);
  let yMax = Math.max(0, ...bucketPartials);
  const range = yMax - yMin || 1;
  yMin -= range * 0.05;
  yMax += range * 0.08;

  // X-axis grows: show up to visible count, minimum 10
  const xExtent = Math.max(n, 10);
  const xPos = i => pad.left + (i / Math.max(xExtent - 1, 1)) * pw;
  const yPos = v => pad.top + (1 - (v - yMin) / (yMax - yMin)) * ph;

  // Grid
  ctx.strokeStyle = 'rgba(212,210,205,0.8)';
  ctx.lineWidth = 1;
  ctx.font = '11px IBM Plex Mono';
  ctx.fillStyle = '#6b7280';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 5; i++) {
    const v = yMin + (yMax - yMin) * (i / 5);
    const y = yPos(v);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
    ctx.fillText(fmt(v, 2), pad.left - 8, y + 4);
  }
  ctx.textAlign = 'center';
  const st = xExtent <= 15 ? 1 : Math.ceil(xExtent / 10);
  for (let i = 0; i < xExtent; i += st) {
    ctx.fillText(i + 1, xPos(i), H - pad.bottom + 18);
  }

  if (n === 0) return;

  const conv = Math.abs(r) < 1;
  const col = conv ? '#c8952e' : '#9e2b2b';
  if (n > 1) {
    ctx.beginPath();
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.lineJoin = 'round';
    for (let i = 0; i < n; i++) {
      const x = xPos(i), y = yPos(partials[i]);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  const glow = conv ? 'rgba(200,149,46,0.25)' : 'rgba(158,43,43,0.2)';
  for (let i = 0; i < n; i++) {
    const x = xPos(i), y = yPos(partials[i]);
    const last = i === n - 1;
    ctx.beginPath(); ctx.arc(x, y, last ? 6 : 3.5, 0, Math.PI * 2); ctx.fillStyle = glow; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, last ? 4 : 2, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
  }
}

function computeBobBounds(terms, shown, a, r) {
  let pos = 0;
  for (let i = 0; i < shown; i++) pos += terms[i];

  // Center on where Bob will be after the next jump
  const nextTerm = shown < terms.length ? terms[shown] : terms[shown - 1] * r;
  const center = pos + nextTerm;

  // Window must include current jump + next landing
  const curStart = pos - terms[shown - 1];
  let lo = Math.min(curStart, pos, center);
  let hi = Math.max(curStart, pos, center);

  if (shown >= 2) {
    const prevStart = curStart - terms[shown - 2];
    lo = Math.min(lo, prevStart);
    hi = Math.max(hi, prevStart);
  }

  const span = hi - lo || Math.abs(terms[shown - 1]);
  const padding = span * 0.25;
  const halfWindow = Math.max(Math.abs(hi - center), Math.abs(center - lo)) + padding;
  return { min: center - halfWindow, max: center + halfWindow };
}

function updateBobZoom(terms, shown, a, r) {
  if (shown === 0) return;

  // Use fixed bounds for the first step so sliding r doesn't shift the view
  if (shown <= 1) {
    const fixed = { min: -1, max: 3 };
    if (bobViewMin === null) {
      bobViewMin = fixed.min;
      bobViewMax = fixed.max;
    }
    bobTargetMin = fixed.min;
    bobTargetMax = fixed.max;
    bobZooming = true;
    return;
  }

  const bounds = computeBobBounds(terms, shown, a, r);

  if (bobViewMin === null) {
    bobViewMin = bounds.min;
    bobViewMax = bounds.max;
  }

  bobTargetMin = bounds.min;
  bobTargetMax = bounds.max;
  bobZooming = true;
}

function drawBob(terms, shown, a, r) {
  const dpr = window.devicePixelRatio || 1;
  const rect = bobCanvas.getBoundingClientRect();
  bobCanvas.width = rect.width * dpr;
  bobCanvas.height = rect.height * dpr;
  bobCtx.scale(dpr, dpr);
  const W = rect.width, H = rect.height;
  bobCtx.clearRect(0, 0, W, H);

  const groundY = H * 0.82;
  const pad = { left: 40, right: 30 };
  const trackW = W - pad.left - pad.right;

  // Use animated view bounds (computed from step-based zoom)
  const fallback = shown > 0 ? computeBobBounds(terms, shown, a, r) : { min: -1, max: 1 };
  const xMin = bobViewMin !== null ? bobViewMin : fallback.min;
  const xMax = bobViewMax !== null ? bobViewMax : fallback.max;

  const toX = v => pad.left + ((v - xMin) / (xMax - xMin)) * trackW;

  // Draw ground
  bobCtx.strokeStyle = var_border;
  bobCtx.lineWidth = 1;
  bobCtx.beginPath();
  bobCtx.moveTo(pad.left, groundY);
  bobCtx.lineTo(W - pad.right, groundY);
  bobCtx.stroke();

  // Tick marks
  bobCtx.fillStyle = '#6b7280';
  bobCtx.font = '9px IBM Plex Mono';
  bobCtx.textAlign = 'center';
  const nTicks = 6;
  for (let i = 0; i <= nTicks; i++) {
    const v = xMin + (xMax - xMin) * (i / nTicks);
    const x = toX(v);
    bobCtx.beginPath();
    bobCtx.moveTo(x, groundY - 3);
    bobCtx.lineTo(x, groundY + 3);
    bobCtx.stroke();
    bobCtx.fillText(fmt(v, 6), x, groundY + 14);
  }

  // Origin marker
  const originX = toX(0);
  bobCtx.strokeStyle = 'rgba(12,26,58,0.3)';
  bobCtx.setLineDash([3, 3]);
  bobCtx.beginPath();
  bobCtx.moveTo(originX, groundY - 20);
  bobCtx.lineTo(originX, groundY);
  bobCtx.stroke();
  bobCtx.setLineDash([]);

  if (shown === 0) {
    // Draw Bob at origin, idle
    drawGrasshopper(bobCtx, originX, groundY, 1, r, 0);
    bobDistanceEl.textContent = 'Distance: 0';
    return;
  }

  // Draw step arcs (cup shapes)
  let pos = 0;
  for (let i = 0; i < shown; i++) {
    const t = terms[i];
    const x1 = toX(pos);
    const x2 = toX(pos + t);
    const midX = (x1 + x2) / 2;
    const arcH = Math.min(8 + i * 3, groundY - 20);
    const isLast = i === shown - 1;

    let strokeCol, fillCol;
    if (isLast) {
      strokeCol = t >= 0 ? 'rgba(200,149,46,0.8)' : 'rgba(158,43,43,0.8)';
      fillCol = t >= 0 ? 'rgba(200,149,46,0.12)' : 'rgba(158,43,43,0.12)';
    } else {
      strokeCol = 'rgba(180,180,175,0.35)';
      fillCol = 'rgba(180,180,175,0.06)';
    }

    // Fill the cup
    bobCtx.beginPath();
    bobCtx.moveTo(x1, groundY);
    bobCtx.quadraticCurveTo(midX, groundY - arcH * 2, x2, groundY);
    bobCtx.closePath();
    bobCtx.fillStyle = fillCol;
    bobCtx.fill();

    // Stroke the cup arc
    bobCtx.beginPath();
    bobCtx.moveTo(x1, groundY);
    bobCtx.quadraticCurveTo(midX, groundY - arcH * 2, x2, groundY);
    bobCtx.strokeStyle = strokeCol;
    bobCtx.lineWidth = isLast ? 2 : 1.2;
    bobCtx.stroke();

    // Dots at the endpoints
    bobCtx.beginPath();
    bobCtx.arc(x1, groundY, isLast ? 2.5 : 1.5, 0, Math.PI * 2);
    bobCtx.fillStyle = strokeCol;
    bobCtx.fill();
    bobCtx.beginPath();
    bobCtx.arc(x2, groundY, isLast ? 2.5 : 1.5, 0, Math.PI * 2);
    bobCtx.fill();

    // Step number label at the top of the arc
    if (Math.abs(x2 - x1) > 10) {
      bobCtx.fillStyle = isLast ? var_muted : 'rgba(180,180,175,0.5)';
      bobCtx.font = '7px IBM Plex Mono';
      bobCtx.textAlign = 'center';
      bobCtx.fillText(i + 1, midX, groundY - arcH - 2);
    }
    pos += t;
  }

  // Bob follows the last arc using quadratic bezier at parameter bobArcT
  const lastTerm = terms[shown - 1];
  const lastStart = pos - lastTerm;
  const p0x = toX(lastStart), p0y = groundY;
  const p2x = toX(pos), p2y = groundY;
  const cpx = (p0x + p2x) / 2;
  const lastArcH = Math.min(8 + (shown - 1) * 3, groundY - 20);
  const cpy = groundY - lastArcH * 2;
  const t = bobArcT;
  const mt = 1 - t;
  const bobX = mt * mt * p0x + 2 * mt * t * cpx + t * t * p2x;
  const bobY = mt * mt * p0y + 2 * mt * t * cpy + t * t * p2y;
  const facingRight = lastTerm >= 0;
  drawGrasshopper(bobCtx, bobX, bobY, facingRight ? 1 : -1, r, shown);

  // Speech bubble when done
  if (bobDone && bobArcT >= 1) {
    const bx = bobX, by = bobY - 50;
    const text = bobDone;
    bobCtx.font = '600 11px IBM Plex Mono';
    const tw = bobCtx.measureText(text).width;
    const px = 8, py = 5, bw = tw + px * 2, bh = 18 + py * 2;

    // Bubble
    bobCtx.fillStyle = '#fff';
    bobCtx.strokeStyle = var_border;
    bobCtx.lineWidth = 1.5;
    bobCtx.beginPath();
    bobCtx.roundRect(bx - bw / 2, by - bh / 2, bw, bh, 6);
    bobCtx.fill();
    bobCtx.stroke();

    // Tail
    bobCtx.fillStyle = '#fff';
    bobCtx.beginPath();
    bobCtx.moveTo(bx - 4, by + bh / 2);
    bobCtx.lineTo(bx, by + bh / 2 + 8);
    bobCtx.lineTo(bx + 4, by + bh / 2);
    bobCtx.closePath();
    bobCtx.fill();
    bobCtx.strokeStyle = var_border;
    bobCtx.stroke();
    // Cover the line between bubble and tail
    bobCtx.fillStyle = '#fff';
    bobCtx.fillRect(bx - 3.5, by + bh / 2 - 1.5, 7, 3);

    // Text
    bobCtx.fillStyle = var_navy;
    bobCtx.textAlign = 'center';
    bobCtx.textBaseline = 'middle';
    bobCtx.fillText(text, bx, by);
    bobCtx.textBaseline = 'alphabetic';
  }

  bobDistanceEl.textContent = bobDone
    ? `Distance: ${fmt(pos)} — ${bobDone}`
    : 'Distance: ' + fmt(pos);
}

const var_border = '#d4d2cd';
const var_muted = '#6b7280';
const var_gold = '#c8952e';
const var_navy = '#0c1a3a';

function drawGrasshopper(c, x, y, dir, r, step) {
  c.save();
  c.translate(x, y);
  c.scale(dir, 1);

  const isNeg = r < 0;
  const green = isNeg ? '#9c27b0' : '#4caf50';
  const greenDark = isNeg ? '#6a1b9a' : '#2e7d32';
  const greenLight = isNeg ? '#ce93d8' : '#81c784';
  const cheekPink = isNeg ? 'rgba(180, 100, 255, 0.35)' : 'rgba(255, 120, 130, 0.35)';

  // Leg scale: |r| mapped from 0..1.5 → 0.4..2.4
  const legS = 0.4 + Math.min(Math.abs(r), 1.5) * 1.33;

  // Abdomen (tall oval)
  c.beginPath();
  c.ellipse(-12, -10, 8, 9, -0.1, 0, Math.PI * 2);
  c.fillStyle = green;
  c.fill();
  c.strokeStyle = greenDark;
  c.lineWidth = 0.6;
  c.stroke();

  // Thorax (tall plump middle)
  c.beginPath();
  c.ellipse(0, -11, 6, 8, 0, 0, Math.PI * 2);
  c.fillStyle = greenLight;
  c.fill();
  c.strokeStyle = greenDark;
  c.stroke();

  // Belly highlight
  c.beginPath();
  c.ellipse(0, -10, 3, 4, 0, 0, Math.PI * 2);
  c.fillStyle = 'rgba(255,255,255,0.15)';
  c.fill();

  // Head (big round)
  c.beginPath();
  c.ellipse(9, -13, 6, 6, 0.1, 0, Math.PI * 2);
  c.fillStyle = green;
  c.fill();
  c.strokeStyle = greenDark;
  c.stroke();

  // Big cute eyes — white
  c.beginPath();
  c.arc(11, -15, 3.2, 0, Math.PI * 2);
  c.fillStyle = '#fff';
  c.fill();
  c.strokeStyle = greenDark;
  c.lineWidth = 0.4;
  c.stroke();

  // Pupil
  c.beginPath();
  c.arc(11.8, -15.3, 1.6, 0, Math.PI * 2);
  c.fillStyle = '#222';
  c.fill();

  // Eye sparkle
  c.beginPath();
  c.arc(12.5, -16.2, 0.6, 0, Math.PI * 2);
  c.fillStyle = '#fff';
  c.fill();

  // Blush cheek
  c.beginPath();
  c.ellipse(12.5, -10, 2.2, 1.4, 0, 0, Math.PI * 2);
  c.fillStyle = cheekPink;
  c.fill();

  // Cute smile
  c.strokeStyle = greenDark;
  c.lineWidth = 0.8;
  c.beginPath();
  c.arc(10.5, -11, 2.8, 0.2, Math.PI * 0.8);
  c.stroke();

  // Antennae (curly, cute)
  c.strokeStyle = greenDark;
  c.lineWidth = 0.9;
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(10, -18);
  c.bezierCurveTo(13, -30, 20, -30, 21, -25);
  c.stroke();
  c.beginPath();
  c.moveTo(11, -18);
  c.bezierCurveTo(15, -28, 22, -26, 22, -22);
  c.stroke();

  // Antenna tips (little balls)
  c.beginPath();
  c.arc(21, -25, 1.3, 0, Math.PI * 2);
  c.fillStyle = greenDark;
  c.fill();
  c.beginPath();
  c.arc(22, -22, 1.3, 0, Math.PI * 2);
  c.fill();

  // Front legs (small, cute)
  c.strokeStyle = greenDark;
  c.lineWidth = 1.2;
  c.beginPath();
  c.moveTo(5, -5);
  c.quadraticCurveTo(8, 1, 9, 0);
  c.stroke();
  c.beginPath();
  c.moveTo(3, -5);
  c.quadraticCurveTo(3, 2, 1, 0);
  c.stroke();

  // Middle pair
  c.beginPath();
  c.moveTo(-1, -5);
  c.quadraticCurveTo(-2, 2, -4, 0);
  c.stroke();
  c.beginPath();
  c.moveTo(-3, -5);
  c.quadraticCurveTo(-5, 2, -6, 0);
  c.stroke();

  // Hind legs — scaled by |r|
  c.lineWidth = 2.2;
  c.strokeStyle = green;

  // Upper hind leg (femur)
  const femurKneeX = -10 - 5 * legS;
  const femurKneeY = -4 - 16 * legS;
  c.beginPath();
  c.moveTo(-10, -6);
  c.quadraticCurveTo(-14, femurKneeY - 4, femurKneeX, femurKneeY);
  c.stroke();

  // Lower hind leg (tibia)
  c.lineWidth = 1.6;
  c.strokeStyle = greenDark;
  const footX = femurKneeX - 4 * legS;
  c.beginPath();
  c.moveTo(femurKneeX, femurKneeY);
  c.quadraticCurveTo(femurKneeX - 2, femurKneeY / 2, footX, 0);
  c.stroke();

  // Cute little feet
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(footX, 0);
  c.lineTo(footX - 3, -0.5);
  c.stroke();

  // Leg icon: bandaid if |r|<1, lightning bolt if |r|>1 (skip step 0-1)
  const absR = Math.abs(r);
  if (absR > 0 && absR !== 1 && step > 1) {
    const midLegX = (femurKneeX + footX) / 2;
    const midLegY = femurKneeY / 2;
    const iconS = absR < 1
      ? Math.min(0.5 + step * (5.5 / 25), 6)
      : Math.min(0.5 + step * (4.5 / 25), 5);

    if (absR < 1) {
      // Bandaid — cross shape
      c.save();
      c.translate(midLegX, midLegY);
      c.rotate(-0.4);
      const bw = 4 * iconS, bh = 1 * iconS, br = 0.5 * iconS;

      // Horizontal strip
      c.fillStyle = '#f5c6a0';
      c.beginPath();
      c.roundRect(-bw / 2, -bh / 2, bw, bh, br);
      c.fill();
      c.strokeStyle = '#d4956b';
      c.lineWidth = 0.5;
      c.stroke();

      // Vertical strip
      c.fillStyle = '#f5c6a0';
      c.beginPath();
      c.roundRect(-bh / 2, -bw / 2, bh, bw, br);
      c.fill();
      c.strokeStyle = '#d4956b';
      c.stroke();

      // Center pad
      c.fillStyle = '#f0e0d0';
      c.beginPath();
      c.arc(0, 0, 1.2 * iconS, 0, Math.PI * 2);
      c.fill();

      // Dots on pad
      c.fillStyle = '#d4956b';
      const dd = 0.5 * iconS;
      c.beginPath(); c.arc(-dd, -dd, 0.3 * iconS, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.arc(dd, -dd, 0.3 * iconS, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.arc(-dd, dd, 0.3 * iconS, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.arc(dd, dd, 0.3 * iconS, 0, Math.PI * 2); c.fill();

      c.restore();
    } else {
      // Lightning bolt
      c.save();
      c.translate(midLegX, midLegY);
      const s = iconS;

      c.fillStyle = '#ffd600';
      c.strokeStyle = '#f9a825';
      c.lineWidth = 1.2;
      c.beginPath();
      c.moveTo(-1.5 * s, -4.5 * s);
      c.lineTo(1.2 * s, -1 * s);
      c.lineTo(-0.5 * s, -1 * s);
      c.lineTo(1.5 * s, 4.5 * s);
      c.lineTo(-1.2 * s, 0.7 * s);
      c.lineTo(0.5 * s, 0.7 * s);
      c.closePath();
      c.fill();
      c.stroke();

      c.restore();
    }
  }

  // Wing hint
  c.strokeStyle = isNeg ? 'rgba(206,147,216,0.35)' : 'rgba(129,199,132,0.35)';
  c.lineWidth = 0.7;
  c.beginPath();
  c.moveTo(-4, -16);
  c.quadraticCurveTo(-12, -22, -20, -14);
  c.stroke();

  // "Bob" label
  c.scale(dir, 1);
  c.fillStyle = var_gold;
  c.font = '600 10px IBM Plex Mono';
  c.textAlign = 'center';
  c.fillText('Bob', 0, -38);

  c.restore();
}

function render() {
  const rAbs = parseFloat(rSlider.value);
  const r = rNegative ? -rAbs : rAbs;
  const a = 1;
  rValueEl.textContent = r.toFixed(2);
  headerR.textContent = r.toFixed(2);

  const maxN = Math.abs(r) >= 1 ? 50 : MAX_N;
  const { terms, partials } = series(a, r, maxN);
  const shown = Math.min(visibleCount, maxN);

  termNumEl.textContent = shown > 0 ? shown : '—';
  partialSumEl.textContent = shown > 0 ? fmt(partials[shown - 1]) : '—';

  // Partial sums history
  if (shown === 0) {
    sequenceEl.innerHTML = '—';
  } else {
    let seq = '';
    for (let i = 0; i < shown; i++) {
      const isNew = i === shown - 1 ? ' class="ps-new"' : '';
      const termVal = terms[i];
      const prevSum = i === 0 ? 0 : partials[i - 1];
      const termSign = termVal >= 0 ? '+' : '−';
      const newTermCls = i === shown - 1 ? 'ps-newterm' : '';
      seq += `<div${isNew}>`
        + `<span class="ps-label">S<sub>${i + 1}</sub></span>`
        + `<span class="ps-expr">${fmt(prevSum)} ${termSign} <span class="${newTermCls}">${fmt(Math.abs(termVal))}</span></span>`
        + `<span class="ps-val">${fmt(partials[i])}</span>`
        + `</div>`;
    }
    sequenceEl.innerHTML = seq;
    sequenceEl.scrollTop = sequenceEl.scrollHeight;
  }

  drawChart(partials.slice(0, shown), maxN, a, r);
  // If a hop is in progress, defer zoom until after it finishes
  if (bobArcAnimating) {
    bobZoomPending = true;
  } else {
    updateBobZoom(terms, shown, a, r);
  }
  drawBob(terms, shown, a, r);
}

function getMaxN() {
  return Math.abs(parseFloat(rSlider.value)) >= 1 ? 50 : MAX_N;
}

function stop() {
  isPlaying = false;
  if (playTimer) { clearTimeout(playTimer); playTimer = null; }
  playBtn.textContent = '▶'; playBtn.classList.remove('active');
}

function advanceStep() {
  if (!isPlaying) return;
  if (visibleCount < getMaxN()) {
    visibleCount++;
    bobArcT = 0;
    bobArcAnimating = true;
    render();
    // Stop if the current term is extreme
    const rAbs = parseFloat(rSlider.value);
    const r = rNegative ? -rAbs : rAbs;
    const { terms } = series(1, r, visibleCount);
    const absTerm = Math.abs(terms[visibleCount - 1]);
    if (absTerm > 1e6) {
      bobDone = 'Too big!';
      stop(); render();
    } else if (absTerm < 1e-10) {
      bobDone = 'Basically converged!';
      stop(); render();
    }
  } else {
    bobDone = 'Done!';
    stop(); render();
  }
}

function play() {
  bobDone = false;
  if (visibleCount >= getMaxN()) visibleCount = 1;
  isPlaying = true;
  playBtn.textContent = '⏸';
  playBtn.classList.add('active');
  advanceStep();
}

playBtn.addEventListener('click', () => isPlaying ? stop() : play());
stepBtn.addEventListener('click', () => { stop(); if (!bobDone && visibleCount < getMaxN()) { visibleCount++; bobArcT = 0; bobArcAnimating = true; render(); checkDone(); } });
function checkDone() {
  const rAbs = parseFloat(rSlider.value);
  const r = rNegative ? -rAbs : rAbs;
  const { terms } = series(1, r, visibleCount);
  const absTerm = Math.abs(terms[visibleCount - 1]);
  if (absTerm > 1e6) { bobDone = 'Too big!'; render(); }
  else if (absTerm < 1e-10) { bobDone = 'Basically converged!'; render(); }
}
resetBtn.addEventListener('click', () => { stop(); bobDone = false; visibleCount = 1; resetBobView(); render(); });

speedBtns.forEach(btn => btn.addEventListener('click', () => {
  speedBtns.forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  speed = parseInt(btn.dataset.speed);
}));

function resetBobView() {
  bobViewMin = null; bobViewMax = null;
  bobTargetMin = null; bobTargetMax = null;
  bobZooming = false;
  bobArcT = 1; bobArcAnimating = false; bobZoomPending = false; bobPauseFrames = 0;
}

function onSlider() { stop(); bobDone = false; visibleCount = 1; resetBobView(); render(); }
rSlider.addEventListener('input', onSlider);
negToggle.addEventListener('click', () => {
  rNegative = !rNegative;
  negToggle.textContent = rNegative ? '−' : '+';
  negToggle.classList.toggle('active', rNegative);
  onSlider();
});
window.addEventListener('resize', render);

// Animation loop: hop first, then zoom
const BASE_SPEED = 550;
(function bobAnimLoop() {
  let needsRedraw = false;
  const sm = BASE_SPEED / speed; // speed multiplier (1 at 1x, 2 at 2x, 4 at 4x)

  // Phase 1: hop along arc
  if (bobArcAnimating) {
    bobArcT += 0.04 * sm;
    if (bobArcT >= 1) {
      bobArcT = 1;
      bobArcAnimating = false;
      // Hop done — schedule next step on a fixed timer, independent of zoom
      if (isPlaying) {
        playTimer = setTimeout(advanceStep, speed);
      }
      // Start pause before zoom
      if (bobZoomPending) {
        bobPauseFrames = Math.max(1, Math.round(12 / sm));
      }
    }
    needsRedraw = true;
  }

  // Pause between hop and zoom
  if (bobPauseFrames > 0) {
    bobPauseFrames--;
    if (bobPauseFrames === 0 && bobZoomPending) {
      bobZoomPending = false;
      const ra = rNegative ? -parseFloat(rSlider.value) : parseFloat(rSlider.value), aa = 1;
      const maxN = Math.abs(ra) >= 1 ? 50 : MAX_N;
      updateBobZoom(series(aa, ra, maxN).terms, Math.min(visibleCount, maxN), aa, ra);
    }
  }

  // Phase 2: smooth zoom lerp (runs after hop finishes)
  if (bobZooming && bobTargetMin !== null && bobViewMin !== null) {
    const zoomLerp = 1 - Math.pow(1 - 0.3, sm); // scale lerp with speed
    const dMin = bobTargetMin - bobViewMin;
    const dMax = bobTargetMax - bobViewMax;
    if (Math.abs(dMin) > 0.0001 || Math.abs(dMax) > 0.0001) {
      bobViewMin += dMin * zoomLerp;
      bobViewMax += dMax * zoomLerp;
      needsRedraw = true;
    } else {
      bobViewMin = bobTargetMin;
      bobViewMax = bobTargetMax;
      bobZooming = false;
      needsRedraw = true;
    }
  }

  if (needsRedraw) {
    const ra = rNegative ? -parseFloat(rSlider.value) : parseFloat(rSlider.value), aa = 1;
    const maxN = Math.abs(ra) >= 1 ? 50 : MAX_N;
    drawBob(series(aa, ra, maxN).terms, Math.min(visibleCount, maxN), aa, ra);
  }

  requestAnimationFrame(bobAnimLoop);
})();

visibleCount = 1;
render();
