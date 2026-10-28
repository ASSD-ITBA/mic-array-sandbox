/* ═══════════════════════════════════════════════════════════
   pyrunner.js — frente del worker de Pyodide, con perro guardián

   Un estimador puede tener un lazo que no termina, y un Pyodide
   ocupado no se interrumpe: la única cura es matar el worker y
   levantar otro.
   ═══════════════════════════════════════════════════════════ */

const PyRunner = (() => {

  /* El worker se pide por URL: lleva el mismo ?v= que esta página, así un
     navegador con la versión de ayer no la corre contra la app de hoy. */
  const V = document.currentScript ? new URL(document.currentScript.src).search : '';
  const WORKER_URL = `js/pyworker.js${V}`;

  let worker = null, ready = false, booting = false, seq = 0;
  const pending = new Map();
  let lastCompile = null;

  const hooks = { onStatus: () => {}, onOutput: () => {}, onRestart: null };

  function boot() {
    booting = true;
    ready = false;
    try {
      worker = new Worker(WORKER_URL, { type: 'module' });
    } catch (e) {
      booting = false;
      worker = null;
      hooks.onStatus('error', 'sin worker');
      hooks.onOutput('err', `No se pudo arrancar el worker de Python: ${e.message || e}`);
      return;
    }
    worker.onmessage = onMessage;
    worker.onerror = e => {
      hooks.onStatus('error', e.message || 'el worker no arrancó');
      hooks.onOutput('err', `error del worker: ${e.message || e}`);
    };
    worker.postMessage({ type: 'init' });
    hooks.onStatus('booting', 'arrancando Python…');
  }

  function onMessage(ev) {
    const m = ev.data;
    switch (m.type) {
      case 'status':
        hooks.onStatus('booting', m.text);
        return;
      case 'ready':
        ready = true;
        booting = false;
        hooks.onStatus('ready', `Python ${m.version}`);
        hooks.onOutput('sys', `Python ${m.version} listo (numpy disponible como np)`);
        if (lastCompile) compile(lastCompile.src, lastCompile.params).catch(() => {});
        if (hooks.onRestart) hooks.onRestart();
        return;
      case 'stdout': hooks.onOutput('out', m.text); return;
      case 'stderr': hooks.onOutput('err', m.text); return;
      case 'compiled':
      case 'result': {
        const p = pending.get(m.id);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(m.id);
        p.resolve(m);
        return;
      }
      case 'error': {
        if (m.phase === 'init') {
          booting = false;
          hooks.onStatus('error', 'Pyodide no cargó');
          hooks.onOutput('err', `No se pudo cargar Pyodide: ${m.message}`);
          return;
        }
        const p = pending.get(m.id);
        if (!p) { hooks.onOutput('err', m.message); return; }
        clearTimeout(p.timer);
        pending.delete(m.id);
        p.reject(new Error(m.message));
        return;
      }
    }
  }

  function restart(reason) {
    if (worker) worker.terminate();
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason || 'intérprete reiniciado'));
    }
    pending.clear();
    boot();
  }

  function request(msg, timeoutMs, transfer) {
    if (!ready) return Promise.reject(new Error('Python todavía no está listo'));
    const id = ++seq;
    msg.id = id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        restart('timeout');
        hooks.onStatus('error', 'se colgó: intérprete reiniciado');
        reject(new Error(
          `Pasaron ${(timeoutMs / 1000).toFixed(1)} s sin respuesta. Se reinició el ` +
          'intérprete: buscar un lazo que no termina.'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      worker.postMessage(msg, transfer || []);
    });
  }

  function start(opts = {}) {
    Object.assign(hooks, opts);
    if (!worker) boot();
  }

  /** @returns {Promise<string[]>} nombres de la app que el código pisó */
  function compile(src, params, timeoutMs = 15000) {
    lastCompile = { src, params };
    return request({ type: 'compile', src, params }, timeoutMs).then(m => m.taken || []);
  }

  /**
   * job.data: Float32Array de k bloques × block × 4, se transfiere.
   * @returns {Promise<{az:number[], el:number[], map:number[][]|null, mapAt:number, ms:number}>}
   */
  function run(job, timeoutMs = 10000) {
    return request({ type: 'run', fs: job.fs, block: job.block, data: job.data },
      timeoutMs, [job.data.buffer])
      .then(m => ({ az: m.az, el: m.el, map: m.map, mapAt: m.mapAt, ms: m.ms }));
  }

  return {
    start, compile, run, restart,
    isReady: () => ready,
    isBusy: () => pending.size > 0,
    isBooting: () => booting,
  };
})();
