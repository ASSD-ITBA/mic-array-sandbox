/* ═══════════════════════════════════════════════════════════
   board.js — la placa: Web Serial y el formato del cable

   El RP2040 manda paquetes por USB CDC (formato en el README):

     "MIC4"  uint16 seq  uint8 nframes  uint8 flags   (little-endian)
     nframes × 16 bytes de tramas del FPGA

     flags bit 0  se perdieron tramas en el RP2040 (la PC no leyó a tiempo)
     flags bit 1  el FPGA no está configurado

   y cada trama, tal como la armó el FPGA (fpga/top.v):

     uint16 decim   períodos PDM entre esta muestra y la anterior
     uint8  seq     contador de tramas
     uint8  0xA0 | flags     bit 0: el FPGA perdió una muestra
                             bit 1: los cuatro cic no diezmaron juntos
     4 × int24      canales 0..3

   La tasa sale de decim: fs = 1 MHz / decim. No se cree a la
   primera trama — la primera después de un reinicio mide desde
   el reinicio — sino cuando el mismo valor se repite STABLE
   veces seguidas. Un cambio sostenido (otro bitstream) es un
   cambio de tasa, y la app se entera.

   Los contadores de pérdidas arrancan de cero recién después de
   SETTLE paquetes. Al abrir el puerto el RP2040 descarta lo que
   acumuló con el puerto cerrado, y lo que ya estaba en camino
   por el USB llega viejo: eso se ve como un salto de secuencia y
   un desborde que no son pérdidas del flujo, sino del arranque.
   ═══════════════════════════════════════════════════════════ */

const Board = (() => {

  const VID = 0x1209, PID = 0xb1c0;          // pico-ice
  const MAGIC = [0x4D, 0x49, 0x43, 0x34];    // "MIC4"
  const HDR = 8, FRAME = 16, MAX_FRAMES = 64;
  const STABLE = 4;
  const SETTLE = 64;                         // ~0.13 s a 31 kHz

  class Parser {
    /**
     * @param {(samples: Int32Array, decim: number) => void} onFrames
     *        muestras intercaladas (4 por trama) a una misma tasa
     * @param {(ev: object) => void} onEvent  {type: 'rate'|'packet', ...}
     */
    constructor(onFrames, onEvent) {
      this.onFrames = onFrames;
      this.onEvent = onEvent || (() => {});
      this.buf = new Uint8Array(1 << 16);
      this.len = 0;
      this.reset();
    }

    reset() {
      this.len = 0;
      this.decim = 0;                // tasa aceptada (0: todavía ninguna)
      this.cand = 0; this.candN = 0;
      this.lastPkt = -1; this.lastFrame = -1;
      this.stats = {
        bytes: 0, packets: 0, frames: 0,
        lostPackets: 0, lostFrames: 0, overruns: 0, fpgaLost: 0, desync: 0,
        badFrames: 0, junk: 0, noFpga: false, idle: false,
      };
    }

    push(chunk) {
      this.stats.bytes += chunk.length;
      if (this.len + chunk.length > this.buf.length) {
        const nb = new Uint8Array(Math.max(this.buf.length * 2, this.len + chunk.length));
        nb.set(this.buf.subarray(0, this.len));
        this.buf = nb;
      }
      this.buf.set(chunk, this.len);
      this.len += chunk.length;
      this.parse();
    }

    findMagic(from) {
      const b = this.buf;
      for (let i = from; i + 3 < this.len; i++) {
        if (b[i] === MAGIC[0] && b[i + 1] === MAGIC[1] && b[i + 2] === MAGIC[2] && b[i + 3] === MAGIC[3]) return i;
      }
      return -1;
    }

    parse() {
      const b = this.buf;
      let p = 0;
      while (this.len - p >= HDR) {
        const at = this.findMagic(p);
        if (at < 0) {                          // sin encabezado: guardar la cola
          const keep = Math.min(3, this.len - p);
          this.stats.junk += this.len - p - keep;
          p = this.len - keep;
          break;
        }
        if (at > p) { this.stats.junk += at - p; p = at; }
        if (this.len - p < HDR) break;

        const n = b[p + 6];
        if (n > MAX_FRAMES) { this.stats.junk += 1; p += 1; continue; }
        const need = HDR + n * FRAME;
        if (this.len - p < need) break;

        this.packet(p, n);
        p += need;
      }
      if (p > 0) {
        this.buf.copyWithin(0, p, this.len);
        this.len -= p;
      }
    }

    packet(p, n) {
      const b = this.buf, s = this.stats;
      const seq = b[p + 4] | (b[p + 5] << 8);
      const flags = b[p + 7];
      if (this.lastPkt >= 0) s.lostPackets += (seq - this.lastPkt - 1) & 0xFFFF;
      this.lastPkt = seq;
      s.packets++;
      if (s.packets === SETTLE) {
        s.lostPackets = s.lostFrames = s.overruns = s.fpgaLost = s.desync = s.badFrames = s.junk = 0;
      }
      if (flags & 1) s.overruns++;
      s.noFpga = !!(flags & 2);
      s.idle = n === 0;

      const out = new Int32Array(n * 4);
      let m = 0;
      for (let f = 0; f < n; f++) {
        const q = p + HDR + f * FRAME;
        if ((b[q + 3] & 0xF0) !== 0xA0) { s.badFrames++; continue; }
        const decim = b[q] | (b[q + 1] << 8);
        const fseq = b[q + 2];
        if (b[q + 3] & 1) s.fpgaLost++;
        if (b[q + 3] & 2) s.desync++;
        if (this.lastFrame >= 0) s.lostFrames += (fseq - this.lastFrame - 1) & 0xFF;
        this.lastFrame = fseq;
        s.frames++;

        if (decim !== this.decim) {
          // ¿una trama suelta, o una tasa nueva?
          if (decim === this.cand) this.candN++;
          else { this.cand = decim; this.candN = 1; }
          if (this.candN < STABLE || decim === 0) continue;
          if (m > 0) { this.onFrames(out.slice(0, m * 4), this.decim); m = 0; }
          const was = this.decim;
          this.decim = decim;
          this.onEvent({ type: 'rate', decim, was });
          continue;
        }
        this.candN = 0;

        for (let c = 0; c < 4; c++) {
          const k = q + 4 + 3 * c;
          out[m * 4 + c] = ((b[k] | (b[k + 1] << 8) | (b[k + 2] << 16)) << 8) >> 8;
        }
        m++;
      }
      if (m > 0 && this.decim > 0) this.onFrames(m === n ? out : out.slice(0, m * 4), this.decim);
      this.onEvent({ type: 'packet', n, flags });
    }
  }

  /* ─────────── el puerto ─────────── */

  let port = null, reader = null, parser = null, reading = false;
  let hooks = {};

  const supported = () => typeof navigator !== 'undefined' && !!navigator.serial;

  async function connect(opts) {
    hooks = opts || {};
    if (!supported()) throw new Error('este navegador no tiene Web Serial: usar Chrome o Edge');
    // un puerto ya autorizado se reabre sin preguntar
    const known = (await navigator.serial.getPorts()).filter(pt => {
      const i = pt.getInfo();
      return i.usbVendorId === VID && i.usbProductId === PID;
    });
    port = known.length === 1 ? known[0]
      : await navigator.serial.requestPort({ filters: [{ usbVendorId: VID, usbProductId: PID }] });
    await port.open({ baudRate: 115200, bufferSize: 1 << 20 });

    parser = new Parser(hooks.onFrames, hooks.onEvent);
    reading = true;
    readLoop();
    return parser;
  }

  async function readLoop() {
    try {
      while (reading && port && port.readable) {
        reader = port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) parser.push(value);
          }
        } finally {
          reader.releaseLock();
          reader = null;
        }
      }
    } catch (e) {
      if (reading && hooks.onLost) hooks.onLost(e);
    }
    if (reading) {                            // el puerto se fue solo
      reading = false;
      try { await port.close(); } catch { /* ya cerrado */ }
      port = null;
      if (hooks.onLost) hooks.onLost(new Error('se desconectó la placa'));
    }
  }

  async function disconnect() {
    reading = false;
    try { if (reader) await reader.cancel(); } catch { /* nada */ }
    try { if (port) await port.close(); } catch { /* nada */ }
    port = null;
  }

  return {
    supported, connect, disconnect, Parser,
    isOn: () => !!port && reading,
    stats: () => (parser ? parser.stats : null),
  };
})();
