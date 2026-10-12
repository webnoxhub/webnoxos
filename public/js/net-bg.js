// Slow "network" background: drifting dots joined by faint lines. Decorative only.
export function initNet(canvas) {
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let w = 0, h = 0, dpr = 1, nodes = [], raf = 0;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = w < 600 ? 28 : 56;
    nodes = Array.from({ length: count }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      vx: (Math.random() - .5) * .18, vy: (Math.random() - .5) * .18
    }));
    draw();
  }

  function draw() {
    ctx.clearRect(0, 0, w, h);
    const max = w < 600 ? 120 : 150;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < max) {
          ctx.strokeStyle = 'rgba(34,211,238,' + (0.16 * (1 - d / max)).toFixed(3) + ')';
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }
    }
    ctx.fillStyle = 'rgba(34,211,238,.55)';
    for (const n of nodes) { ctx.beginPath(); ctx.arc(n.x, n.y, 1.8, 0, 6.2832); ctx.fill(); }
  }

  function tick() {
    for (const n of nodes) {
      n.x += n.vx; n.y += n.vy;
      if (n.x < 0 || n.x > w) n.vx *= -1;
      if (n.y < 0 || n.y > h) n.vy *= -1;
    }
    draw();
    raf = requestAnimationFrame(tick);
  }

  function start() { if (!still && !raf) raf = requestAnimationFrame(tick); }
  function stop() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }

  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  resize();
  start();
}
