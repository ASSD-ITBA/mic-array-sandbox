/* ═══════════════════════════════════════════════════════════
   polar.js — hacia dónde: azimut y elevación

   El ángulo alrededor del dial es el azimut: 0° es +x
   (micrófono 0) y crece antihorario, como la cruz dibujada en
   el medio. El radio es la elevación: el centro es el cenit
   (90°, perpendicular a la placa) y el borde el horizonte (0°,
   en el plano de la cruz). Es la vista desde arriba del
   hemisferio en el que puede estar la fuente: un arreglo plano
   no distingue +el de −el.

   La dirección que devuelve process_block es un punto; las
   últimas, un rastro que se apaga. Si además devuelve un mapa
   (un valor por elevación y azimut) se pinta debajo, en un solo
   tono, en dB entre su mínimo y su máximo (30 dB como mucho):
   una cruz de 4 cm es chica frente a la longitud de onda y su
   mapa varía pocos dB, que con una escala fija no se verían. Con
   la fuente sintética, la cruz punteada es la dirección de
   verdad.

   Ésa es la vista de los levels 3 y 4 (modo 'hemi'). Los levels
   1 y 2 usan sólo el par 0-2 y tienen la suya (modo 'pair', más
   abajo).
   ═══════════════════════════════════════════════════════════ */

const Polar = (() => {

  const ACCENT = '#4fc3f7', INK = '#dbe4f2', DIM = '#7e8ca6', FAINT = '#55627a';
  const GRID = '#1a2436', AXIS = '#2b3a55', BG = '#080d16';
  const MAP_DB = 30;
  const TRAIL = 24;

  const st = { cur: null, trail: [], map: null, truth: null, hover: null,
               mode: 'hemi', showMap: true };

  function fit(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w: canvas.clientWidth, h: canvas.clientHeight };
  }

  const wrap = a => ((a % 360) + 360) % 360;
  const clampEl = e => Math.min(90, Math.max(0, e));

  /** Un resultado por bloque, en grados; NaN si el bloque devolvió None. */
  function push(az, el) {
    if (!isFinite(az) || !isFinite(el)) { st.cur = null; return; }
    st.cur = { az: wrap(az), el };
    st.trail.push(st.cur);
    if (st.trail.length > TRAIL) st.trail.shift();
  }

  /** mapa: filas = elevaciones equiespaciadas de 0 a 90 (inclusive),
      columnas = azimuts equiespaciados de 0 a 360 (sin el 360). */
  function setMap(m) { st.map = m && m.length && m[0].length ? m : null; }
  function setTruth(t) { st.truth = t; }
  function clear() { st.cur = null; st.trail = []; st.map = null; }

  function drawHemi(canvas) {
    const { ctx, w, h } = fit(canvas);
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 26;
    const rad = el => (90 - clampEl(el)) / 90 * R;
    const P = (az, el) => {
      const a = az * Math.PI / 180, r = rad(el);
      return [cx + r * Math.cos(a), cy - r * Math.sin(a)];
    };

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);

    // mapa: sectores anulares, un tono, la opacidad sigue al nivel
    if (st.map && st.showMap) {
      const m = st.map, E = m.length, K = m[0].length;
      let mx = -Infinity, mn = Infinity;
      for (const row of m) for (const v of row) { if (v > mx) mx = v; if (v > 0 && v < mn) mn = v; }
      const span = Math.min(MAP_DB, Math.max(0.5, 10 * Math.log10(mx / mn)));
      if (mx > 0) {
        const elC = i => (E === 1 ? 45 : i * 90 / (E - 1));
        const elLo = i => (i === 0 ? 0 : (elC(i - 1) + elC(i)) / 2);
        const elHi = i => (i === E - 1 ? 90 : (elC(i) + elC(i + 1)) / 2);
        const half = Math.PI / K * 1.04;          // un poco de solape: sin costuras
        for (let i = 0; i < E; i++) {
          const r0 = rad(elHi(i)), r1 = rad(elLo(i));
          for (let j = 0; j < K; j++) {
            const v = m[i][j];
            const db = v > 0 ? 10 * Math.log10(v / mx) : -span;
            const a = Math.max(0, 1 + db / span);
            if (a <= 0.02) continue;
            const c = -(j * 2 * Math.PI / K);         // canvas: y hacia abajo
            ctx.beginPath();
            ctx.arc(cx, cy, r1, c - half, c + half);
            ctx.arc(cx, cy, r0, c + half, c - half, true);
            ctx.closePath();
            ctx.fillStyle = `rgba(79, 195, 247, ${(0.5 * a * a).toFixed(3)})`;
            ctx.fill();
          }
        }
      }
    }

    // grilla: elevación 0 (borde), 30 y 60; azimut cada 30°
    ctx.lineWidth = 1;
    for (const el of [0, 30, 60]) {
      ctx.strokeStyle = el === 0 ? AXIS : GRID;
      ctx.beginPath(); ctx.arc(cx, cy, rad(el), 0, 2 * Math.PI); ctx.stroke();
    }
    ctx.font = '10px "JetBrains Mono", Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let d = 0; d < 360; d += 30) {
      const [x1, y1] = P(d, 90 - 0.16 * 90), [x2, y2] = P(d, 0);
      ctx.strokeStyle = GRID;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      const a = d * Math.PI / 180;
      ctx.fillStyle = d % 90 === 0 ? DIM : FAINT;
      ctx.fillText(`${d}°`, cx + (R + 14) * Math.cos(a), cy - (R + 14) * Math.sin(a));
    }
    // rótulos de elevación sobre el radio de 105°, entre dos marcas de azimut
    ctx.fillStyle = FAINT;
    for (const el of [30, 60]) {
      const [x, y] = P(105, el);
      ctx.fillText(`el ${el}°`, x, y);
    }

    // la cruz
    const g = 0.11 * R;
    ctx.strokeStyle = AXIS;
    ctx.beginPath();
    ctx.moveTo(cx - g, cy); ctx.lineTo(cx + g, cy);
    ctx.moveTo(cx, cy - g); ctx.lineTo(cx, cy + g);
    ctx.stroke();
    for (let c = 0; c < 4; c++) {
      const a = c * Math.PI / 2;
      const x = cx + g * Math.cos(a), y = cy - g * Math.sin(a);
      ctx.beginPath(); ctx.arc(x, y, 4.5, 0, 2 * Math.PI);
      ctx.fillStyle = Scope.COLORS[c]; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = BG; ctx.stroke();
      ctx.lineWidth = 1;
      ctx.fillStyle = INK;
      ctx.fillText(`${c}`, cx + (g + 9) * Math.cos(a), cy - (g + 9) * Math.sin(a));
    }

    // la verdad (sintética): cruz punteada
    if (st.truth) {
      const [x, y] = P(st.truth.az, st.truth.el);
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, 10, 0, 2 * Math.PI); ctx.stroke();
      ctx.restore();
      ctx.strokeStyle = DIM;
      ctx.beginPath();
      ctx.moveTo(x - 15, y); ctx.lineTo(x - 11, y); ctx.moveTo(x + 11, y); ctx.lineTo(x + 15, y);
      ctx.moveTo(x, y - 15); ctx.lineTo(x, y - 11); ctx.moveTo(x, y + 11); ctx.lineTo(x, y + 15);
      ctx.stroke();
    }

    // rastro
    st.trail.forEach((d, i) => {
      const alpha = 0.1 + 0.5 * (i + 1) / st.trail.length;
      const [x, y] = P(d.az, d.el);
      ctx.beginPath(); ctx.arc(x, y, 3.5, 0, 2 * Math.PI);
      ctx.fillStyle = `rgba(79, 195, 247, ${alpha.toFixed(3)})`;
      ctx.fill();
    });

    // la estimación: punto con aro, y una línea tenue desde el centro
    if (st.cur) {
      const [x, y] = P(st.cur.az, st.cur.el);
      ctx.strokeStyle = 'rgba(79, 195, 247, 0.45)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, 6.5, 0, 2 * Math.PI);
      ctx.fillStyle = ACCENT; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = BG; ctx.stroke();
    }

    // cursor: dirección bajo el puntero
    if (st.hover) {
      const [hx, hy] = st.hover;
      const d = Math.hypot(hx - cx, hy - cy);
      if (d <= R) {
        const az = wrap(Math.atan2(-(hy - cy), hx - cx) * 180 / Math.PI);
        const el = 90 - d / R * 90;
        ctx.fillStyle = DIM;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(`az ${az.toFixed(0)}°  el ${el.toFixed(0)}°`, 6, 6);
      }
    }
  }

  /* ─────────── el par 0-2 (levels 1 y 2) ───────────

     El plano de la placa visto desde arriba, con el eje del par en
     horizontal: micrófono 0 a la derecha (+x), 2 a la izquierda. La
     estimación es una onda que llega desde theta (flecha y frentes de
     onda); su imagen especular, -theta, va punteada: para un par lineal
     las dos dan el mismo retardo. El patrón P(theta_s), si se devolvió,
     se dibuja normalizado a su máximo y en lineal, como la expresión
     cos² de la consigna, también reflejado. */

  function drawPair(canvas) {
    const { ctx, w, h } = fit(canvas);
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 26;
    const P = (deg, r) => {
      const a = deg * Math.PI / 180;
      return [cx + r * R * Math.cos(a), cy - r * R * Math.sin(a)];
    };

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);

    // patrón, en las dos mitades
    if (st.map && st.showMap) {
      const p = st.map[0], K = p.length;
      let mx = 0;
      for (const v of p) if (v > mx) mx = v;
      if (mx > 0) {
        for (const sgn of [1, -1]) {
          ctx.beginPath();
          for (let i = 0; i <= K; i++) {
            const th = i * 180 / K;
            const r = Math.max(0, (p[Math.min(i, K - 1)] || 0) / mx);
            const [x, y] = P(sgn * th, r);
            if (i === 0) ctx.moveTo(cx, cy), ctx.lineTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.lineTo(cx, cy);
          ctx.closePath();
          ctx.fillStyle = sgn > 0 ? 'rgba(79, 195, 247, 0.16)' : 'rgba(79, 195, 247, 0.06)';
          ctx.fill();
          ctx.strokeStyle = sgn > 0 ? 'rgba(79, 195, 247, 0.6)' : 'rgba(79, 195, 247, 0.25)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
    }

    // grilla: semicírculo de arriba marcado, el de abajo tenue
    ctx.lineWidth = 1;
    for (const r of [1, 0.5]) {
      ctx.strokeStyle = r === 1 ? AXIS : GRID;
      ctx.beginPath(); ctx.arc(cx, cy, r * R, 0, 2 * Math.PI); ctx.stroke();
    }
    ctx.font = '10px "JetBrains Mono", Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let d = 0; d < 360; d += 30) {
      const upper = d <= 180;
      const [x1, y1] = P(d, 0.16), [x2, y2] = P(d, 1);
      ctx.strokeStyle = GRID;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      const [tx, ty] = P(d, 1 + 14 / R);
      ctx.fillStyle = upper ? (d % 90 === 0 ? DIM : FAINT) : '#33405a';
      ctx.fillText(`${upper ? d : d - 360}°`, tx, ty);
    }
    // el eje del par
    ctx.strokeStyle = AXIS;
    ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.stroke();

    // los micrófonos: 0 y 2 llenos, 1 y 3 huecos (no se usan en este nivel)
    const g = 0.11 * R;
    for (let c = 0; c < 4; c++) {
      const a = c * Math.PI / 2;
      const x = cx + g * Math.cos(a), y = cy - g * Math.sin(a);
      ctx.beginPath(); ctx.arc(x, y, c % 2 ? 3.5 : 5, 0, 2 * Math.PI);
      if (c % 2) {
        ctx.strokeStyle = FAINT; ctx.lineWidth = 1; ctx.stroke();
      } else {
        ctx.fillStyle = Scope.COLORS[c]; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = BG; ctx.stroke();
        ctx.fillStyle = INK;
        ctx.fillText(`${c}`, cx + (g + 10) * Math.cos(a), cy - (g + 10) * Math.sin(a) - 9);
      }
    }
    ctx.fillStyle = FAINT;
    ctx.fillText('d', cx, cy + 10);

    /* una onda que llega desde deg: flecha hacia el par y tres frentes de
       onda perpendiculares; `dash` para la imagen especular */
    const wave = (deg, color, alpha, dash) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 2;
      if (dash) ctx.setLineDash([5, 4]);
      const a = deg * Math.PI / 180;
      const [x0, y0] = P(deg, 0.95), [x1, y1] = P(deg, 0.24);
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      ctx.setLineDash([]);
      // punta, hacia el centro
      const ux = Math.cos(a), uy = -Math.sin(a);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 + 11 * ux - 5 * uy, y1 + 11 * uy + 5 * ux);
      ctx.lineTo(x1 + 11 * ux + 5 * uy, y1 + 11 * uy - 5 * ux);
      ctx.closePath();
      ctx.fill();
      // frentes de onda
      ctx.lineWidth = 1.5;
      if (dash) ctx.setLineDash([3, 3]);
      for (const r of [0.86, 0.74, 0.62]) {
        const [mx, my] = P(deg, r), L = 0.13 * R;
        ctx.beginPath();
        ctx.moveTo(mx - L * uy, my + L * ux);
        ctx.lineTo(mx + L * uy, my - L * ux);
        ctx.stroke();
      }
      ctx.restore();
    };

    // verdad (sintética): el ángulo que ve el par, en las dos mitades
    if (st.truth) {
      const th = pairAngle(st.truth.az, st.truth.el);
      ctx.save();
      ctx.setLineDash([2, 4]);
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.5;
      for (const sgn of [1, -1]) {
        const [x0, y0] = P(sgn * th, 0.2), [x1, y1] = P(sgn * th, 1);
        ctx.globalAlpha = sgn > 0 ? 0.8 : 0.3;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      }
      ctx.restore();
    }

    // rastro, en el borde
    st.trail.forEach((d, i) => {
      const alpha = 0.1 + 0.5 * (i + 1) / st.trail.length;
      const [x, y] = P(d.az, 1);
      ctx.beginPath(); ctx.arc(x, y, 3.5, 0, 2 * Math.PI);
      ctx.fillStyle = `rgba(79, 195, 247, ${alpha.toFixed(3)})`;
      ctx.fill();
    });

    if (st.cur) {
      wave(-st.cur.az, ACCENT, 0.35, true);
      wave(st.cur.az, ACCENT, 1, false);
      ctx.fillStyle = DIM;
      ctx.textAlign = 'center';
      const [lx, ly] = P(-st.cur.az, 0.5);
      ctx.fillText('imagen', lx, ly + 12);
    }

    if (st.hover) {
      const [hx, hy] = st.hover;
      const d = Math.hypot(hx - cx, hy - cy);
      if (d > 0.2 * R && d < R + 20) {
        const deg = Math.atan2(-(hy - cy), hx - cx) * 180 / Math.PI;
        ctx.fillStyle = DIM;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(`θ ${Math.abs(deg).toFixed(0)}°`, 6, 6);
      }
    }
  }

  /** El ángulo que ve el par 0-2 de una fuente en (az, el): cos θ = cos az · cos el. */
  function pairAngle(az, el) {
    const c = Math.cos(az * Math.PI / 180) * Math.cos(el * Math.PI / 180);
    return Math.acos(Math.max(-1, Math.min(1, c))) * 180 / Math.PI;
  }

  function setMode(m) { st.mode = m; clear(); }
  function setShowMap(on) { st.showMap = on; }

  function draw(canvas) {
    if (st.mode === 'pair') drawPair(canvas); else drawHemi(canvas);
  }

  function hover(xy) { st.hover = xy; }

  return {
    push, setMap, setTruth, clear, draw, hover, setMode, setShowMap, pairAngle,
    current: () => st.cur,
  };
})();
