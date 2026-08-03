/**
 * Whiteboard — pointer-driven (mouse/touch/pen) drawing canvas.
 * Keeps a stroke history so it can redraw cleanly after resize/undo/clear.
 */
const Whiteboard = (() => {
  let canvas, ctx, wrap;
  let dpr = window.devicePixelRatio || 1;

  let tool = 'pen';           // 'pen' | 'eraser'
  let color = '#1a1a1a';
  const PEN_WIDTH = 2.6;
  const ERASER_WIDTH = 26;

  let strokes = [];           // committed strokes: { tool, color, width, points: [{x,y}] }
  let currentStroke = null;
  let drawing = false;

  function init(canvasId, wrapId) {
    canvas = document.getElementById(canvasId);
    wrap = document.getElementById(wrapId);
    ctx = canvas.getContext('2d');

    canvas.style.touchAction = 'none';

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerUp);

    window.addEventListener('resize', debounce(resize, 150));
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
    redrawAll();
  }

  function getPos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function paintBackground() {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  function drawStroke(stroke) {
    if (stroke.points.length === 0) return;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = stroke.tool === 'eraser' ? '#ffffff' : stroke.color;
    ctx.lineWidth = stroke.width;

    if (stroke.points.length === 1) {
      const p = stroke.points[0];
      ctx.beginPath();
      ctx.arc(p.x, p.y, stroke.width / 2, 0, Math.PI * 2);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();
      return;
    }

    ctx.beginPath();
    ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
    for (let i = 1; i < stroke.points.length; i++) {
      ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
    }
    ctx.stroke();
  }

  function redrawAll() {
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paintBackground();
    strokes.forEach(drawStroke);
    ctx.restore();
  }

  function onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    drawing = true;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* best-effort only */ }
    const width = tool === 'eraser' ? ERASER_WIDTH : PEN_WIDTH;
    currentStroke = { tool, color, width, points: [getPos(e)] };
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawStroke(currentStroke);
  }

  function onPointerMove(e) {
    if (!drawing || !currentStroke) return;
    currentStroke.points.push(getPos(e));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // draw just the newest segment for performance
    const pts = currentStroke.points;
    const seg = { ...currentStroke, points: pts.slice(-2) };
    drawStroke(seg);
  }

  function onPointerUp(e) {
    if (!drawing) return;
    drawing = false;
    if (currentStroke && currentStroke.points.length > 0) {
      strokes.push(currentStroke);
    }
    currentStroke = null;
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
