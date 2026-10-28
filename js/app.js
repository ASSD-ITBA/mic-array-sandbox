/* ═══════════════════════════════════════════════════════════
   app.js — el motor

        placa (Web Serial) ─┐
                            ├─ muestras ─┬─ historia ─ osciloscopio / espectro
        sintética ──────────┘            ├─ grabación ─ WAV
                                         └─ bloques ─ process_block ─ polar

   Las dos fuentes son excluyentes y entregan lo mismo: enteros
   de 24 bits, cuatro por instante. La tasa no es de la app: en
   la placa la fija el CIC del FPGA (llega en cada trama como
   decim, fs = 1 MHz / decim); en la sintética, el R elegido.
   Cuando cambia, cambian FS y BLOCK, y si Python está corriendo
   se recompila con los valores nuevos.

   Cuatro niveles, uno por pestaña, cada uno con su código: el
   motor corre el del nivel abierto. Los levels 1 y 2 usan el par
   0-2 y se dibujan como par; los 3 y 4, como hemisferio.
   ═══════════════════════════════════════════════════════════ */

(() => {

  const $ = id => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  const FULL = 8388608;                  // 2^23: plena escala de 24 bits
  const HIST = 1 << 16;                  // muestras de historia por canal
  const HMASK = HIST - 1;
  const BLOCK_MS = 33;                   // duración buscada de un bloque
  const MAX_QUEUE_S = 1.0;               // atraso máximo frente a Python
  const MAX_BATCH = 32;                  // bloques por cruce a Python
  const REC_MAX_S = 60;

  const S = {
    source: 'synth',
    fs: 0, decim: 0, block: 1024,
    running: false, compiling: false,
    pyBuf: null, pyFill: 0,
    queue: [], dropped: 0, warnedDrop: false,
    lastMs: 0, lastN: 0,
    rec: null,
    synthAz: 30, synthEl: 20, synthT: 0, synthDone: 0,
    lastFrames: 0, lastStatT: 0,
    connecting: false,
    level: 1, warnedMap: false,
  };

  const PAIR_LEVELS = [1, 2];
  const isPair = () => PAIR_LEVELS.includes(S.level);

  const hist = [0, 1, 2, 3].map(() => new Float32Array(HIST));
  let hw = 0;                            // muestras escritas, por canal

  /* ═══════════ consola ═══════════ */

  function log(kind, text) {
    const out = $('console-out');
    const el = document.createElement('div');
    el.className = `l-${kind}`;
    el.textContent = text;
    out.appendChild(el);
    while (out.childNodes.length > 200) out.removeChild(out.firstChild);
    out.scrollTop = out.scrollHeight;
  }

  /* ═══════════ tasa ═══════════ */

  function blockFor(fs) {
    return clamp(1 << Math.round(Math.log2(fs * BLOCK_MS / 1000)), 256, 4096);
  }

  function params() {
    const r = Geo.R_MIC;
    return [
      `FS = ${S.fs.toFixed(3)}`,
      `BLOCK = ${S.block}`,
      `C = ${Geo.C.toFixed(1)}`,
      `R_MIC = ${r}`,
      `MIC_POS = np.array([[${r}, 0.0], [0.0, ${r}], [${-r}, 0.0], [0.0, ${-r}]])`,
    ].join('\n');
  }

  function showParams() {
    const ms = S.block / S.fs * 1000;
    $('params-strip').textContent = S.fs
      ? `FS = ${+S.fs.toFixed(2)} Hz (1 MHz / ${S.decim})  ·  BLOCK = ${S.block} (${ms.toFixed(1)} ms)  ·  ` +
        `C = ${Geo.C} m/s  ·  R_MIC = ${+(Geo.R_MIC * 1000).toFixed(3)} mm  ·  c/4r = ${Geo.F_ALIAS.toFixed(0)} Hz`
      : 'esperando muestras para saber la tasa…';
  }

  /** La fuente cambió de tasa (o es la primera vez que se sabe). */
  function setRate(decim) {
    if (decim === S.decim) return;
    const was = S.decim;
    S.decim = decim;
    S.fs = Geo.F_PDM / decim;
    S.block = blockFor(S.fs);
    hw = 0;
    hist.forEach(h => h.fill(0));
    S.pyBuf = new Float32Array(S.block * 4);
    S.pyFill = 0;
    S.queue = [];
    showParams();
    if (was) log('sys', `tasa nueva: decim ${was} → ${decim}, fs = ${+S.fs.toFixed(2)} Hz, BLOCK = ${S.block}`);
    if (S.rec) stopRecording('la tasa cambió');
    if (S.running) recompile();
  }

  /* ═══════════ muestras ═══════════ */

  function ingest(s) {
    const n = s.length / 4;
    if (!n) return;
    for (let i = 0; i < n; i++) {
      const j = (hw + i) & HMASK;
      hist[0][j] = s[4 * i] / FULL;
      hist[1][j] = s[4 * i + 1] / FULL;
      hist[2][j] = s[4 * i + 2] / FULL;
      hist[3][j] = s[4 * i + 3] / FULL;
    }
    hw += n;

    if (S.rec) {
      S.rec.chunks.push(s.slice());
      S.rec.n += n;
      if (S.rec.n >= REC_MAX_S * S.fs) stopRecording(`${REC_MAX_S} s, el máximo`);
    }

    if (S.running && !S.compiling) feed(s);
  }

  /** Corta bloques enteros para Python. */
  function feed(s) {
    const per = S.block * 4;
    let k = 0;
    while (k < s.length) {
      const take = Math.min(per - S.pyFill, s.length - k);
      for (let i = 0; i < take; i++) S.pyBuf[S.pyFill + i] = s[k + i] / FULL;
      S.pyFill += take;
      k += take;
      if (S.pyFill === per) {
        S.queue.push(S.pyBuf);
        S.pyBuf = new Float32Array(per);
        S.pyFill = 0;
      }
    }
    const maxBlocks = Math.max(2, Math.ceil(MAX_QUEUE_S * S.fs / S.block));
    if (S.queue.length > maxBlocks) {
      const drop = S.queue.length - maxBlocks;
      S.queue.splice(0, drop);
      S.dropped += drop;
      if (!S.warnedDrop) {
        S.warnedDrop = true;
        log('err', 'process_block tarda más que el bloque que procesa: se descartan bloques ' +
          'para no atrasarse (el costo por bloque está abajo a la derecha).');
      }
    }
    pump();
  }

  function pump() {
    if (!S.running || S.compiling || !PyRunner.isReady() || PyRunner.isBusy() || !S.queue.length) return;
    const blocks = S.queue.splice(0, MAX_BATCH);
    const per = S.block * 4;
    const data = new Float32Array(blocks.length * per);
    blocks.forEach((b, i) => data.set(b, i * per));
    const block = S.block;
    PyRunner.run({ fs: S.fs, block, data })
      .then(r => {
        if (!S.running || block !== S.block) return;
        r.az.forEach((a, i) => Polar.push(a, r.el[i]));
        if (r.map) {
          if (isPair() && r.map.length > 1 && !S.warnedMap) {
            S.warnedMap = true;
            log('sys', `level ${S.level}: el patrón tiene ${r.map.length} filas; se dibuja la primera ` +
              '(acá va un solo vector, P para cada theta_s).');
          }
          Polar.setMap(r.map);
        }
        S.lastMs = r.ms; S.lastN = r.az.length;
        updateCost();
        pump();
      })
      .catch(e => {
        log('err', e.message || String(e));
        stop();
      });
  }

  function updateCost() {
    const per = S.lastN ? S.lastMs / S.lastN : 0;
    const budget = S.block / S.fs * 1000;
    const el = $('stat-run');
    el.textContent = `${per.toFixed(2)} ms / bloque de ${budget.toFixed(1)} ms` +
      (S.dropped ? ` · ${S.dropped} descartados` : '');
    el.classList.toggle('hot', per > budget);
  }

  /* ═══════════ correr ═══════════ */

  async function recompile() {
    S.compiling = true;
    S.queue = [];
    S.pyFill = 0;
    try {
      const taken = await PyRunner.compile(Editor.getSource(), params());
      if (taken.length) {
        log('sys', `${taken.join(', ')} ${taken.length > 1 ? 'son' : 'es'} de la app: ` +
          'se volvió a poner el valor de la app.');
      }
      return true;
    } catch (e) {
      log('err', e.message || String(e));
      stop();
      return false;
    } finally {
      S.compiling = false;
    }
  }

  async function run() {
    if (S.running) return;
    if (!PyRunner.isReady()) { log('err', 'Python todavía no está listo.'); return; }
    if (!S.fs) { log('err', 'Todavía no hay muestras: conectar la placa o elegir la fuente sintética.'); return; }
    S.running = true;
    S.dropped = 0; S.warnedDrop = false;
    Polar.clear();
    Editor.setReadOnly(true);
    $('btn-run').hidden = true;
    $('btn-stop').hidden = false;
    $('run-state').textContent = 'corriendo';
    $('run-state').classList.add('on');
    if (await recompile()) {
      log('ok', `corriendo level ${S.level}: process_block cada ${S.block} muestras ` +
        `(${(S.block / S.fs * 1000).toFixed(1)} ms)`);
    }
  }

  function stop() {
    if (!S.running) return;
    S.running = false;
    S.queue = [];
    S.pyFill = 0;
    Editor.setReadOnly(false);
    $('btn-run').hidden = false;
    $('btn-stop').hidden = true;
    $('run-state').textContent = 'detenido';
    $('run-state').classList.remove('on');
  }

  /* ═══════════ niveles ═══════════ */

  function setLevel(n) {
    if (S.running) stop();
    S.level = n;
    S.warnedMap = false;
    Editor.setLevel(n);
    document.querySelectorAll('.tab').forEach(t => {
      const on = +t.dataset.level === n;
      t.classList.toggle('on', on);
      t.setAttribute('aria-selected', on);
    });
    Polar.setMode(isPair() ? 'pair' : 'hemi');
    Polar.setTruth(S.source === 'synth' ? { az: S.synthAz, el: S.synthEl } : null);
    const mb = $('btn-map');
    mb.hidden = n === 1;
    mb.textContent = isPair() ? 'Patrón' : 'Mapa';
    $('polar-name').textContent = isPair() ? 'Par 0–2' : 'Dirección';
  }

  function saveAll() {
    const blob = new Blob([Editor.pack()], { type: 'text/x-python' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'mic_array_sandbox.py';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    log('ok', 'guardado mic_array_sandbox.py, con los cuatro niveles');
  }

  async function openFile(file) {
    if (!file) return;
    if (S.running) stop();
    let text;
    try { text = await file.text(); } catch (e) { log('err', `no se pudo leer ${file.name}: ${e.message || e}`); return; }
    const r = Editor.unpack(text);
    log('ok', r.single
      ? `${file.name}: sin marcas de nivel, cargado en el level ${S.level}`
      : `${file.name}: cargados los niveles ${r.levels.join(', ')}`);
  }

  /* ═══════════ fuentes ═══════════ */

  const synthOpts = () => ({
    freq: logFreq(+$('freq').value),
    azDeg: S.synthAz,
    elDeg: S.synthEl,
    level: 0.25,
    noise: +$('noise').value,
  });

  // el control de frecuencia es logarítmico: 0..1000 -> 100 Hz..8 kHz
  const logFreq = v => 100 * Math.pow(80, v / 1000);

  function synthTick() {
    if (S.source !== 'synth') return;
    const now = performance.now();
    const dt = (now - S.synthT) / 1000;
    S.synthT = now;
    if ($('spin').checked) {
      S.synthAz = (S.synthAz + 30 * dt) % 360;
      $('az').value = Math.round(S.synthAz);
      $('az-value').textContent = `${Math.round(S.synthAz)}°`;
    }
    Polar.setTruth({ az: S.synthAz, el: S.synthEl });
    let n = Math.floor(S.fs * dt + S.synthDone);
    S.synthDone = S.fs * dt + S.synthDone - n;
    n = Math.min(n, Math.round(S.fs * 0.2));     // pestaña dormida: no recuperar
    if (n > 0) ingest(Synth.frames(n, S.fs, synthOpts()));
  }

  function setSynthRate() {
    setRate(+$('synth-r').value);
  }

  async function setSource(src) {
    if (src === S.source) return;
    if (S.rec) stopRecording('cambió la fuente');
    S.source = src;
    $('src-board').classList.toggle('on', src === 'board');
    $('src-synth').classList.toggle('on', src === 'synth');
    $('src-board').setAttribute('aria-pressed', src === 'board');
    $('src-synth').setAttribute('aria-pressed', src === 'synth');
    $('board-strip').hidden = src !== 'board';
    document.querySelectorAll('.synth-only').forEach(el => el.classList.toggle('off', src !== 'synth'));
    document.querySelectorAll('.synth-only input, .synth-only select').forEach(el => { el.disabled = src !== 'synth'; });
    Polar.clear();
    if (src === 'synth') {
      Polar.setTruth({ az: S.synthAz, el: S.synthEl });
      if (Board.isOn()) await disconnectBoard();
      S.decim = 0;
      setSynthRate();
      S.synthT = performance.now();
    } else {
      Polar.setTruth(null);
      S.decim = 0; S.fs = 0;
      showParams();
      hw = 0;
      hist.forEach(h => h.fill(0));
      boardNote('sin conectar');
    }
  }

  /* ═══════════ placa ═══════════ */

  function boardNote(text, cls) {
    const el = $('board-note');
    el.textContent = text;
    el.className = `note ${cls || ''}`;
  }

  async function connectBoard() {
    if (S.connecting) return;
    if (Board.isOn()) { await disconnectBoard(); return; }
    S.connecting = true;
    try {
      await Board.connect({
        onFrames: (s, decim) => {
          if (S.source !== 'board') return;
          setRate(decim);
          ingest(s);
        },
        onEvent: ev => {
          if (ev.type === 'rate' && !ev.was) log('sys', `la placa manda decim = ${ev.decim}: fs = ${+(Geo.F_PDM / ev.decim).toFixed(2)} Hz`);
        },
        onLost: e => {
          log('err', `placa: ${e.message || e}`);
          $('btn-connect').textContent = 'Conectar';
          boardNote('desconectada', 'bad');
        },
      });
      $('btn-connect').textContent = 'Desconectar';
      S.lastFrames = 0; S.lastStatT = performance.now();
      log('sys', 'placa conectada');
      boardNote('conectada, esperando tramas…');
    } catch (e) {
      if (e && e.name === 'NotFoundError') log('sys', 'no se eligió ningún puerto');
      else log('err', `no se pudo abrir la placa: ${e.message || e}`);
    } finally {
      S.connecting = false;
    }
  }

  async function disconnectBoard() {
    await Board.disconnect();
    $('btn-connect').textContent = 'Conectar';
    boardNote('sin conectar');
  }

  function boardStatus() {
    if (S.source !== 'board' || !Board.isOn()) return;
    const st = Board.stats();
    if (!st) return;
    const now = performance.now();
    const rate = (st.frames - S.lastFrames) / ((now - S.lastStatT) / 1000);
    S.lastFrames = st.frames; S.lastStatT = now;
    const lost = st.lostFrames + st.lostPackets;
    if (st.noFpga) { boardNote('el RP2040 responde, pero el FPGA no está configurado (CDONE bajo)', 'bad'); return; }
    if (st.idle && rate < 1) { boardNote('el RP2040 responde, pero el FPGA no manda tramas: ¿sample_valid nunca pulsa?', 'bad'); return; }
    const parts = [
      S.decim ? `decim ${S.decim}` : 'decim ?',
      `${Math.round(rate)} tramas/s`,
      `perdidas ${lost}`,
    ];
    if (st.overruns) parts.push(`desbordes ${st.overruns}`);
    if (st.fpgaLost) parts.push(`FPGA perdió ${st.fpgaLost}`);
    if (st.desync) parts.push(`canales desincronizados ${st.desync}`);
    if (st.badFrames) parts.push(`malas ${st.badFrames}`);
    boardNote(parts.join(' · '), lost || st.overruns || st.badFrames || st.desync ? 'warn' : 'good');
  }

  /* ═══════════ grabar ═══════════ */

  function toggleRecording() {
    if (S.rec) { stopRecording(); return; }
    if (!S.fs) { log('err', 'no hay muestras para grabar'); return; }
    S.rec = { chunks: [], n: 0, fs: S.fs };
    $('btn-rec').classList.add('rec');
    log('sys', `grabando a ${+S.fs.toFixed(2)} Hz…`);
  }

  function stopRecording(why) {
    const r = S.rec;
    S.rec = null;
    $('btn-rec').classList.remove('rec');
    $('btn-rec').textContent = '● Grabar';
    if (!r || !r.n) return;
    const blob = wav(r.chunks, r.n, r.fs);
    const d = new Date(), p = v => String(v).padStart(2, '0');
    const name = `mic4_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_` +
      `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_${Math.round(r.fs)}Hz.wav`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    log('ok', `${name}: ${(r.n / r.fs).toFixed(2)} s, 4 canales` + (why ? ` (cortado: ${why})` : ''));
  }

  /** WAV PCM de 32 bits, 4 canales: cada muestra de 24 bits corrida 8 a la izquierda. */
  function wav(chunks, n, fs) {
    const bytes = n * 16;
    const buf = new ArrayBuffer(44 + bytes);
    const v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    const rate = Math.round(fs);
    str(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 4, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 16, true); v.setUint16(32, 16, true); v.setUint16(34, 32, true);
    str(36, 'data'); v.setUint32(40, bytes, true);
    let o = 44;
    for (const c of chunks) for (let i = 0; i < c.length; i++, o += 4) v.setInt32(o, c[i] * 256, true);
    return new Blob([buf], { type: 'audio/wav' });
  }

  /* ═══════════ pantalla ═══════════ */

  function latest(c, n, end) {
    const out = new Float32Array(n);
    const start = end - n;
    for (let i = 0; i < n; i++) out[i] = hist[c][(start + i) & HMASK];
    return out;
  }

  /** Último cruce ascendente del canal 0 que deje una ventana entera detrás. */
  function trigger(win) {
    const avail = Math.min(hw, HIST);
    const search = Math.min(avail - win, Math.round(S.fs * 0.05));
    if (search < 2) return hw;
    const lo = hw - win - search, x0 = latest(0, search + win, hw);
    let mean = 0;
    for (let i = 0; i < x0.length; i++) mean += x0[i];
    mean /= x0.length;
    for (let i = search - 1; i >= 1; i--) {
      if (x0[i - 1] - mean < 0 && x0[i] - mean >= 0) return lo + i + win;
    }
    return hw;
  }

  function levels() {
    const n = Math.min(S.block, hw, HIST);
    return [0, 1, 2, 3].map(c => {
      if (n < 2) return -Infinity;
      const x = latest(c, n, hw);
      let m = 0, e = 0;
      for (let i = 0; i < n; i++) m += x[i];
      m /= n;
      for (let i = 0; i < n; i++) e += (x[i] - m) ** 2;
      return Scope.dbfs(Math.sqrt(e / n));
    });
  }

  let showSpectrum = false;

  function render() {
    requestAnimationFrame(render);
    if (S.fs) {
      if (showSpectrum) {
        const n = clamp(1 << Math.floor(Math.log2(Math.max(64, Math.min(hw, 8192)))), 64, 8192);
        const note = Scope.drawSpectrum($('scope-canvas'), [0, 1, 2, 3].map(c => latest(c, n, hw)), S.fs);
        $('scope-note').textContent = note || `${n} muestras · Hann · ${(S.fs / n).toFixed(1)} Hz por bin`;
      } else {
        const win = Math.max(8, Math.round(S.fs * +$('win').value / 1000));
        const end = $('trig').checked ? trigger(win) : hw;
        const zoom = Math.pow(2, +$('zoom').value);
        Scope.drawScope($('scope-canvas'), [0, 1, 2, 3].map(c => latest(c, win, end)),
          { zoom, levels: levels() });
        $('scope-note').textContent = `${$('win').value} ms · ×${zoom} · ` +
          ($('trig').checked ? 'disparo en el canal 0' : 'libre');
      }
    } else {
      Scope.drawScope($('scope-canvas'), [null, null, null, null], { zoom: 1, levels: null });
    }
    Polar.draw($('polar-canvas'));

    const cur = Polar.current();
    const sg = v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
    let txt;
    if (!S.running) {
      txt = 'sin estimador corriendo';
    } else if (isPair()) {
      // el par sólo ve cos θ = cos az · cos el: se compara contra eso
      txt = cur === null ? 'θ —' : `θ ${cur.az.toFixed(1)}°`;
      if (S.source === 'synth' && cur !== null) {
        const th = Polar.pairAngle(S.synthAz, S.synthEl);
        txt += `  ·  el par ve ${th.toFixed(1)}°  ·  error ${sg(cur.az - th)}°`;
      }
    } else {
      txt = cur === null ? 'az —  el —' : `az ${cur.az.toFixed(1)}°  el ${cur.el.toFixed(1)}°`;
      if (S.source === 'synth' && cur !== null) {
        const eaz = ((cur.az - S.synthAz + 540) % 360) - 180;
        txt += `  ·  verdad ${S.synthAz.toFixed(0)}° ${S.synthEl.toFixed(0)}°` +
          `  ·  error ${sg(eaz)}° ${sg(cur.el - S.synthEl)}°`;
      }
    }
    $('az-readout').textContent = txt;
    if (S.rec) $('btn-rec').textContent = `■ Detener (${(S.rec.n / S.rec.fs).toFixed(1)} s)`;
  }

  /* ═══════════ arranque ═══════════ */

  function bindSlider(id, fmt, onChange) {
    const el = $(id), out = $(`${id}-value`);
    const upd = () => { out.textContent = fmt(+el.value); if (onChange) onChange(+el.value); };
    el.addEventListener('input', upd);
    upd();
  }

  async function init() {
    if (location.protocol === 'file:') {
      const b = $('app-banner');
      b.hidden = false;
      b.innerHTML = '<strong>Abrir con start.cmd, no con doble clic en index.html.</strong> ' +
        'Los navegadores no dejan correr Web Workers ni WebAssembly desde <code>file://</code>, ' +
        'así que Python no arrancaría.';
    }

    const note = await Editor.init({ onRun: () => (S.running ? null : run()) });
    if (note) log('sys', note);

    PyRunner.start({
      onStatus: (kind, text) => {
        const b = $('py-badge');
        b.textContent = text;
        b.className = `py-badge ${kind === 'ready' ? 'ready' : kind === 'error' ? 'err' : 'busy'}`;
      },
      onOutput: (kind, text) => log(kind, text),
      onRestart: () => { if (S.running) stop(); },
    });

    $('btn-run').addEventListener('click', run);
    $('btn-stop').addEventListener('click', stop);
    $('btn-reset-code').addEventListener('click', () => {
      if (S.running) return;
      if (confirm(`¿Volver a poner el código inicial del level ${S.level}? Se pierde el actual.`)) Editor.reset();
    });
    $('btn-save').addEventListener('click', saveAll);
    $('btn-open').addEventListener('click', () => $('file-open').click());
    $('file-open').addEventListener('change', e => {
      openFile(e.target.files[0]);
      e.target.value = '';
    });
    document.querySelectorAll('.tab').forEach(t =>
      t.addEventListener('click', () => setLevel(+t.dataset.level)));
    $('btn-map').addEventListener('click', () => {
      const on = !$('btn-map').classList.contains('on');
      $('btn-map').classList.toggle('on', on);
      $('btn-map').setAttribute('aria-pressed', on);
      Polar.setShowMap(on);
    });
    $('btn-clear-console').addEventListener('click', () => { $('console-out').textContent = ''; });

    $('src-board').addEventListener('click', () => setSource('board'));
    $('src-synth').addEventListener('click', () => setSource('synth'));
    $('btn-connect').addEventListener('click', connectBoard);
    $('btn-rec').addEventListener('click', toggleRecording);

    if (!Board.supported()) {
      $('src-board').disabled = true;
      $('src-board').title = 'Este navegador no tiene Web Serial: usar Chrome o Edge';
      log('sys', 'Sin Web Serial en este navegador: sólo la fuente sintética. La placa necesita Chrome o Edge.');
    }

    $('btn-spectrum').addEventListener('click', () => {
      showSpectrum = !showSpectrum;
      $('btn-spectrum').classList.toggle('on', showSpectrum);
      $('btn-spectrum').setAttribute('aria-pressed', showSpectrum);
      $('scope-name').textContent = showSpectrum ? 'Espectro' : 'Osciloscopio';
      document.querySelectorAll('.scope-only').forEach(el => el.classList.toggle('off', showSpectrum));
    });

    const sc = $('scope-canvas');
    sc.addEventListener('mousemove', e => { if (showSpectrum) Scope.hoverSpectrum(e.offsetX); });
    sc.addEventListener('mouseleave', () => Scope.hoverSpectrum(null));
    const pc = $('polar-canvas');
    pc.addEventListener('mousemove', e => Polar.hover([e.offsetX, e.offsetY]));
    pc.addEventListener('mouseleave', () => Polar.hover(null));

    bindSlider('freq', v => {
      const f = logFreq(v);
      return f >= 1000 ? `${(f / 1000).toFixed(2)} kHz` : `${Math.round(f)} Hz`;
    });
    bindSlider('az', v => `${v}°`, v => { if (!$('spin').checked) S.synthAz = v; });
    bindSlider('el', v => `${v}°`, v => { S.synthEl = v; });
    bindSlider('noise', v => v.toFixed(3));
    bindSlider('zoom', v => `×${1 << v}`);
    $('synth-r').addEventListener('change', setSynthRate);

    S.source = 'board';                  // para que setSource haga todo el trabajo
    await setSource('synth');
    S.level = 0;
    setLevel(Editor.level());
    setInterval(synthTick, 16);
    setInterval(boardStatus, 500);
    requestAnimationFrame(render);
  }

  init();
})();
