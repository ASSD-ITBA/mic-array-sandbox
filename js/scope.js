/* ═══════════════════════════════════════════════════════════
   scope.js — los cuatro canales: en el tiempo y en frecuencia

   Osciloscopio: una franja por micrófono, acoplada en alterna
   (se le resta la media de lo que se ve, como la entrada AC de
   un osciloscopio: el offset de DC de cada PDM no la saca de
   pantalla). Con disparo, en el cruce por cero ascendente del
   canal 0: un tono queda quieto y lo que se ve moverse entre
   franjas es el retardo entre micrófonos, que es el ejercicio.

   Espectro: los cuatro superpuestos, en dBFS, de 0 a fs/2. Las
   escalas son fijas a propósito: una que se reacomoda a lo que
   hay muestra siempre "algo" aunque no haya nada. La línea
   punteada es c/(4r): por encima, la fase entre micrófonos
   opuestos da la vuelta.

   Colores por canal en orden fijo (paleta categórica validada
   para fondo oscuro); cada traza lleva además su rótulo, así
   que el color nunca es lo único que identifica un canal.
   ═══════════════════════════════════════════════════════════ */

const Scope = (() => {

  const COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500'];
  const INK = '#dbe4f2', DIM = '#7e8ca6', FAINT = '#55627a';
  const GRID = '#1a2436', AXIS = '#2b3a55', BG = '#080d16';
  const DB_TOP = 0, DB_BOT = -160;

  function fit(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w: canvas.clientWidth, h: canvas.clientHeight };
  }

  const dbfs = rms => (rms > 0 ? 20 * Math.log10(rms) : -Infinity);
  const fmtDb = d => (isFinite(d) ? `${d >= 0 ? '+' : ''}${d.toFixed(1)} dBFS` : '— dBFS');

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Float32Array[]} seg  un tramo por canal, ya alineado (largo = ventana)
   * @param {{zoom:number, trig:boolean, levels:number[]}} o
   */
  function drawScope(canvas, seg, o) {
    const { ctx, w, h } = fit(canvas);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);
    const gap = 6, sh = (h - gap * 3) / 4;
    ctx.font = '10px "JetBrains Mono", Consolas, monospace';
    ctx.textBaseline = 'top';

    for (let c = 0; c < 4; c++) {
      const y0 = c * (sh + gap), mid = y0 + sh / 2;
      ctx.strokeStyle = GRID;
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, y0 + 0.5, w - 1, sh - 1);
      ctx.beginPath(); ctx.moveTo(0, mid + 0.5); ctx.lineTo(w, mid + 0.5);
      ctx.strokeStyle = AXIS; ctx.stroke();

      const x = seg[c];
      if (x && x.length > 1) {
        let mean = 0;
        for (let i = 0; i < x.length; i++) mean += x[i];
        mean /= x.length;
        const k = (sh / 2 - 2) * o.zoom;
        ctx.save();
        ctx.beginPath(); ctx.rect(0, y0, w, sh); ctx.clip();
        ctx.beginPath();
        const step = (w - 1) / (x.length - 1);
        // más muestras que píxeles: mínimo y máximo por columna, sin perder picos
        if (x.length > 2 * w) {
          const per = x.length / w;
          for (let px = 0; px < w; px++) {
            const a = Math.floor(px * per), b = Math.min(x.length, Math.floor((px + 1) * per));
            let lo = Infinity, hi = -Infinity;
            for (let i = a; i < b; i++) { const v = x[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
            ctx.moveTo(px + 0.5, mid - (hi - mean) * k);
            ctx.lineTo(px + 0.5, mid - (lo - mean) * k + 0.5);
          }
        } else {
          for (let i = 0; i < x.length; i++) {
            const px = i * step, py = mid - (x[i] - mean) * k;
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
        }
        ctx.strokeStyle = COLORS[c];
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();
      }

      // rótulo: muestra de color + nombre, y nivel; texto en tinta, no en el color
      ctx.fillStyle = COLORS[c];
      ctx.fillRect(6, y0 + 6, 8, 8);
      ctx.fillStyle = INK;
      ctx.textAlign = 'left';
      ctx.fillText(`${c} · ${Geo.NAMES[c]}`, 18, y0 + 4);
      ctx.fillStyle = DIM;
      ctx.textAlign = 'right';
      ctx.fillText(fmtDb(o.levels ? o.levels[c] : -Infinity), w - 6, y0 + 4);
    }
  }

  /* ─────────── espectro ─────────── */

  const spec = { last: null, fs: 0, hoverX: null };

  function niceStep(span, target) {
    const raw = span / target, p = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
    return 10 * p;
  }

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Float32Array[]} seg  un tramo por canal, potencia de dos muestras
   * @param {number} fs
   * @returns {string} lectura bajo el cursor, si lo hay
   */
  function drawSpectrum(canvas, seg, fs) {
    const { ctx, w, h } = fit(canvas);
    const L = 44, Rm = 8, T = 22, B = 20;
    const pw = w - L - Rm, ph = h - T - B;
    const nyq = fs / 2;
    const X = f => L + (f / nyq) * pw;
    const Y = d => T + (DB_TOP - d) / (DB_TOP - DB_BOT) * ph;

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);
    ctx.font = '10px "JetBrains Mono", Consolas, monospace';

    // grilla y ejes
    ctx.lineWidth = 1;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (let d = DB_TOP; d >= DB_BOT; d -= 20) {
      ctx.strokeStyle = GRID;
      ctx.beginPath(); ctx.moveTo(L, Math.round(Y(d)) + 0.5); ctx.lineTo(L + pw, Math.round(Y(d)) + 0.5); ctx.stroke();
      ctx.fillStyle = FAINT;
      ctx.fillText(`${d}`, L - 6, Y(d));
    }
    const fstep = niceStep(nyq, 6);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let f = 0; f <= nyq + 1e-6; f += fstep) {
      ctx.strokeStyle = GRID;
      ctx.beginPath(); ctx.moveTo(Math.round(X(f)) + 0.5, T); ctx.lineTo(Math.round(X(f)) + 0.5, T + ph); ctx.stroke();
      ctx.fillStyle = FAINT;
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, X(f), T + ph + 5);
    }
    ctx.strokeStyle = AXIS;
    ctx.strokeRect(L + 0.5, T + 0.5, pw, ph);

    // límite de ambigüedad de fase de los pares opuestos
    if (Geo.F_ALIAS < nyq) {
      ctx.save();
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = DIM;
      ctx.beginPath(); ctx.moveTo(Math.round(X(Geo.F_ALIAS)) + 0.5, T); ctx.lineTo(Math.round(X(Geo.F_ALIAS)) + 0.5, T + ph); ctx.stroke();
      ctx.restore();
      ctx.fillStyle = DIM;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText('c/4r', X(Geo.F_ALIAS) + 4, T + 4);
    }

    // las cuatro curvas
    const mags = seg.map(x => (x && x.length >= 64 ? FFT.magnitudesDb(x) : null));
    for (let c = 0; c < 4; c++) {
      const m = mags[c];
      if (!m) continue;
      const bins = m.length;
      ctx.beginPath();
      if (bins > 2 * pw) {
        const per = bins / pw;
        for (let px = 0; px < pw; px++) {
          const a = Math.floor(px * per), b = Math.min(bins, Math.floor((px + 1) * per));
          let hi = -Infinity;
          for (let i = a; i < b; i++) if (m[i] > hi) hi = m[i];
          const y = Y(Math.max(DB_BOT, hi));
          if (px === 0) ctx.moveTo(L + px, y); else ctx.lineTo(L + px, y);
        }
      } else {
        for (let k = 0; k < bins; k++) {
          const x = L + k / (bins - 1) * pw, y = Y(Math.max(DB_BOT, m[k]));
          if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
      }
      ctx.strokeStyle = COLORS[c];
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // leyenda en una fila, arriba
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    let lx = L;
    for (let c = 0; c < 4; c++) {
      ctx.fillStyle = COLORS[c];
      ctx.fillRect(lx, 7, 10, 3);
      ctx.fillStyle = INK;
      const t = `${c} ${Geo.NAMES[c]}`;
      ctx.fillText(t, lx + 14, 9);
      lx += 14 + ctx.measureText(t).width + 14;
    }
    ctx.fillStyle = FAINT;
    ctx.textAlign = 'right';
    ctx.fillText('dBFS', w - Rm, 9);

    spec.last = mags; spec.fs = fs; spec.L = L; spec.pw = pw;

    // cursor
    let note = '';
    if (spec.hoverX !== null && spec.hoverX >= L && spec.hoverX <= L + pw && mags[0]) {
      const f = (spec.hoverX - L) / pw * nyq;
      const k = Math.round(f / nyq * (mags[0].length - 1));
      ctx.strokeStyle = DIM;
      ctx.beginPath(); ctx.moveTo(Math.round(spec.hoverX) + 0.5, T); ctx.lineTo(Math.round(spec.hoverX) + 0.5, T + ph); ctx.stroke();
      note = `${Math.round(f)} Hz · ` + mags.map((m, c) => (m ? `${c}: ${m[k].toFixed(0)}` : '')).join('  ') + ' dB';
    }
    return note;
  }

  function hoverSpectrum(x) { spec.hoverX = x; }

  return { drawScope, drawSpectrum, hoverSpectrum, COLORS, dbfs };
})();
