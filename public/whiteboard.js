/**
 * Whiteboard — pointer-driven (mouse/touch/pen) drawing canvas.
 * Optimized for smooth, low-lag drawing with requestAnimationFrame batching.
 */
const Whiteboard = (() => {
  let canvas, ctx, wrap;
  let dpr = window.devicePixelRatio || 1;

  let tool = 'pen';
  let color = '#1a1a1a';
  const PEN_WIDTH = 2.6;
  const ERASER_WIDTH = 26;
  const MIN_POINT_DISTANCE = 2; // Skip points closer than this to reduce stored points

  let strokes = [];
  let currentStroke = null;
  let drawing = false;
  let pendingDraw = false;
  let cachedRect = null;
  let lastPos = null;

  function init(canvasId, wrapId) {
    canvas = document.getElementById(canvasId);
    wrap = document.getElementById(wrapId);
    ctx = canvas.getContext('2d', { alpha: false }); // Disable alpha for better perf

    canvas.style.touchAction = 'none';

    canvas.addEventListener('pointerdown', onPointerDown, { passive: true });
    canvas.addEventListener('pointermove', onPointerMove, { passive: true });
    canvas.addEventListener('pointerup', onPointerUp, { passive: true });
    canvas.addEventListener('pointercancel', onPointerUp, { passive: true });
    canvas.addEventListener('pointerleave', onPointerUp, { passive: true });

    const debouncedResize = debounce(resize, 150);
    window.addEventListener('resize', debouncedResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', debouncedResize);
    window.addEventListener('orientationchange', debouncedResize);
    resize();
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  function resize() {
    if (!canvas || !wrap) return;
    dpr = window.devicePixelRatio || 1;
    const rect = wrap.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    cachedRect = null;
    redrawAll();
  }

  function getPos(e) {
    if (!cachedRect) cachedRect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - cachedRect.left) * dpr,
      y: (e.clientY - cachedRect.top) * dpr
    };
  }

  function distance(p1, p2) {
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function paintBackground() {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function drawStroke(stroke, fromIndex = 0) {
    if (stroke.points.length <= fromIndex) return;

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = stroke.tool === 'eraser' ? '#ffffff' : stroke.color;
    ctx.lineWidth = stroke.width * dpr;

    const pts = stroke.points;
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, (stroke.width / 2) * dpr, 0, Math.PI * 2);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();
      return;
    }

    // Draw using quadratic curves for smoother lines with fewer points
    ctx.beginPath();
    ctx.moveTo(pts[fromIndex].x, pts[fromIndex].y);

    for (let i = fromIndex + 1; i < pts.length; i++) {
      if (i === fromIndex + 1) {
        ctx.lineTo(pts[i].x, pts[i].y);
      } else {
        const p1 = pts[i - 1];
        const p2 = pts[i];
        const xc = (p1.x + p2.x) / 2;
        const yc = (p1.y + p2.y) / 2;
        ctx.quadraticCurveTo(p1.x, p1.y, xc, yc);
      }
    }
    ctx.stroke();
  }

  function redrawAll() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    paintBackground();
    for (const stroke of strokes) {
      drawStroke(stroke);
    }
  }

  function scheduleRedraw() {
    if (pendingDraw) return;
    pendingDraw = true;
    requestAnimationFrame(() => {
      if (drawing && currentStroke) {
        redrawAll();
        if (currentStroke.points.length > 0) {
          drawStroke(currentStroke);
        }
      }
      pendingDraw = false;
    });
  }

  function onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    drawing = true;
    cachedRect = null;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}

    const width = tool === 'eraser' ? ERASER_WIDTH : PEN_WIDTH;
    const pos = getPos(e);
    currentStroke = { tool, color, width, points: [pos] };
    lastPos = pos;

    scheduleRedraw();
  }

  function onPointerMove(e) {
    if (!drawing || !currentStroke) return;

    const pos = getPos(e);

    // Only add point if it's far enough from last point (reduces stored points)
    if (lastPos && distance(pos, lastPos) < MIN_POINT_DISTANCE) {
      return;
    }

    currentStroke.points.push(pos);
    lastPos = pos;
    scheduleRedraw();
  }

  function onPointerUp(e) {
    if (!drawing) return;
    drawing = false;
    cachedRect = null;

    if (currentStroke && currentStroke.points.length > 0) {
      strokes.push(currentStroke);
    }
    currentStroke = null;
    lastPos = null;
  }

  function setTool(t) {
    tool = t;
    document.getElementById('wb-tool-pen')?.classList.toggle('active', t === 'pen');
    document.getElementById('wb-tool-eraser')?.classList.toggle('active', t === 'eraser');
  }

  function setColor(c, btnEl) {
    color = c;
    document.querySelectorAll('.wb-color-btn').forEach(b => b.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');
  }

  function undo() {
    strokes.pop();
    redrawAll();
  }

  function clear() {
    strokes = [];
    redrawAll();
  }

  function hasContent() {
    return strokes.length > 0;
  }

  function exportPNG() {
    return canvas.toDataURL('image/png');
  }

  return { init, setTool, setColor, undo, clear, hasContent, exportPNG, resize };
})();
