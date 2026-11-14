export function initMouseTest() {
  const canvas = document.getElementById('mouseChart'), ctx = canvas.getContext('2d');
  const start = document.getElementById('mouseStart'), stop = document.getElementById('mouseStop');
  const state = document.getElementById('mouseState'), counts = document.getElementById('mouseCounts');
  let x, y, totalX, totalY, events, trail, frame = 0, running = false, hadLock = false;
  const locked = () => document.pointerLockElement === canvas;

  function draw() {
    frame = 0;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = '#e1e1e6'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h);
    ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    ctx.strokeStyle = '#8db2e5'; ctx.lineWidth = 2; ctx.beginPath();
    trail.forEach((point, i) => { if (i) ctx.lineTo(...point); else ctx.moveTo(...point); }); ctx.stroke();
    ctx.fillStyle = '#2671d9'; ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#2671d9'; ctx.beginPath(); ctx.arc(x, y, 14, 0, Math.PI * 2); ctx.stroke();
    counts.textContent = `事件 ${events} · X ${totalX} · Y ${totalY}`;
  }
  function scheduleDraw() { if (!frame) frame = requestAnimationFrame(draw); }
  function reset() {
    x = canvas.width / 2; y = canvas.height / 2; totalX = totalY = events = 0;
    trail = [[x, y]]; scheduleDraw();
  }
  function updateLock() {
    if (locked()) hadLock = true;
    else if (hadLock) { running = false; hadLock = false; }
    start.disabled = running; stop.disabled = !running;
    state.textContent = !running ? '未开始' : locked() ? '测试中 · Esc 退出' : '测试中 · 指针未锁定';
  }
  function end() { running = false; hadLock = false; if (locked()) document.exitPointerLock(); updateLock(); }
  start.addEventListener('click', () => {
    if (running) return;
    reset(); running = true; updateLock();
    try { const result = canvas.requestPointerLock?.(); if (result?.catch) result.catch(updateLock); }
    catch { updateLock(); }
  });
  stop.addEventListener('click', end);
  document.getElementById('mouseReset').addEventListener('click', reset);
  document.addEventListener('pointerlockchange', updateLock);
  document.addEventListener('pointerlockerror', updateLock);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') end(); });
  document.addEventListener('mousemove', e => {
    // Count OS mouse events only. Gyroscope telemetry never drives this view.
    if (!running || !e.isTrusted || (!e.movementX && !e.movementY)) return;
    totalX += e.movementX; totalY += e.movementY; events++;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    x = Math.max(14, Math.min(canvas.width - 14, x + e.movementX * canvas.width / rect.width));
    y = Math.max(14, Math.min(canvas.height - 14, y + e.movementY * canvas.height / rect.height));
    trail.push([x, y]); if (trail.length > 600) trail.shift(); scheduleDraw();
  });
  window.addEventListener('blur', end);
  window.addEventListener('hashchange', end);
  document.addEventListener('visibilitychange', () => { if (document.hidden) end(); });
  reset();
}
