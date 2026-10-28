/* ═══════════════════════════════════════════════════════════
   synth.js — cuatro canales sintéticos

   Una onda plana desde el azimut y la elevación elegidos: el
   micrófono c la recibe adelantada Geo.lead(c, az, el)
   segundos. Un tono es la única señal para la que ese retardo
   fraccionario es exacto sin interpolar, y es lo que pide el
   ejercicio 7.

   Sale en el mismo formato que la placa — enteros de 24 bits,
   con un offset de DC distinto por micrófono, como los PDM
   reales — así que el estimador no distingue una fuente de la
   otra salvo por lo que de verdad cambia: la sala.
   ═══════════════════════════════════════════════════════════ */

const Synth = (() => {

  const FULL = 8388608;                       // 2^23
  const DC = [0.004, -0.003, 0.002, -0.005];  // offsets, fracción de plena escala

  let phase = 0;
  let spare = null;                           // Box-Muller da de a dos

  function gauss() {
    if (spare !== null) { const g = spare; spare = null; return g; }
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    v = Math.random();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }

  /**
   * @param {number} n   muestras por canal
   * @param {number} fs  Hz
   * @param {{freq:number, azDeg:number, elDeg:number, level:number, noise:number}} o
   *        level: amplitud del tono, noise: desvío del ruido blanco,
   *        ambos como fracción de plena escala
   * @returns {Int32Array} n × 4 intercaladas, en cuentas de 24 bits
   */
  function frames(n, fs, o) {
    const out = new Int32Array(n * 4);
    const az = o.azDeg * Math.PI / 180, el = o.elDeg * Math.PI / 180;
    const w = 2 * Math.PI * o.freq;
    const off = [0, 1, 2, 3].map(c => w * Geo.lead(c, az, el));
    const dph = w / fs;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 4; c++) {
        let v = o.level * Math.sin(phase + off[c]) + DC[c];
        if (o.noise > 0) v += o.noise * gauss();
        v = Math.round(v * FULL);
        out[i * 4 + c] = v > FULL - 1 ? FULL - 1 : (v < -FULL ? -FULL : v);
      }
      phase += dph;
      if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
    }
    return out;
  }

  return { frames };
})();
