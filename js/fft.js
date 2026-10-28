/* ═══════════════════════════════════════════════════════════
   fft.js — el espectro, para mirar

   Radix-2 en el lugar, con ventana de Hann y tablas por tamaño.
   Sólo lo usa el panel de espectro: lo que hace Python con las
   muestras es asunto del estimador.
   ═══════════════════════════════════════════════════════════ */

const FFT = (() => {

  const cache = new Map();

  function tables(n) {
    const hit = cache.get(n);
    if (hit) return hit;
    const levels = Math.log2(n);
    if (!Number.isInteger(levels)) throw new Error(`la FFT pide potencia de dos, no ${n}`);

    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos(2 * Math.PI * i / n);
      sin[i] = Math.sin(2 * Math.PI * i / n);
    }
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let x = i, r = 0;
      for (let b = 0; b < levels; b++) { r = (r << 1) | (x & 1); x >>>= 1; }
      rev[i] = r;
    }
    // Hann; `gain` es la media de la ventana, para devolverle la amplitud
    const win = new Float64Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) { win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n); sum += win[i]; }

    const t = { n, cos, sin, rev, win, gain: sum / n };
    cache.set(n, t);
    return t;
  }

  /**
   * Espectro de magnitud en dBFS: un seno de plena escala da 0 dB.
   * @param {Float32Array} x  potencia de dos muestras (se le quita la media)
   * @returns {Float32Array}  n/2 + 1 bins, DC primero
   */
  function magnitudesDb(x, floorDb = -160) {
    const n = x.length, t = tables(n);
    let mean = 0;
    for (let i = 0; i < n; i++) mean += x[i];
    mean /= n;

    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[t.rev[i]] = (x[i] - mean) * t.win[i];

    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tre = re[l] * t.cos[k] + im[l] * t.sin[k];
          const tim = -re[l] * t.sin[k] + im[l] * t.cos[k];
          re[l] = re[j] - tre; im[l] = im[j] - tim;
          re[j] += tre; im[j] += tim;
        }
      }
    }

    const bins = n / 2 + 1, out = new Float32Array(bins);
    for (let k = 0; k < bins; k++) {
      const twoSided = (k === 0 || k === n / 2) ? 1 : 2;
      const m = Math.hypot(re[k], im[k]) * twoSided / (n * t.gain);
      out[k] = m > 0 ? Math.max(floorDb, 20 * Math.log10(m)) : floorDb;
    }
    return out;
  }

  return { magnitudesDb };
})();
