/* ═══════════════════════════════════════════════════════════
   pyworker.js — Pyodide vive aquí, fuera del hilo de la página

   Worker de *módulo*: Pyodide 314 no corre en un worker clásico,
   así que se carga con import() dinámico de pyodide.mjs.

   Protocolo (página -> worker):
     {type:'init'}
     {type:'compile', id, src, params}
     {type:'run', id, fs, block, data: Float32Array}   k bloques × block × 4
   Worker -> página:
     {type:'ready'|'compiled'|'result'|'error'|'stdout'|'stderr'|'status'}
   ═══════════════════════════════════════════════════════════ */

const PYODIDE_VERSION = '314.0.3';

const SOURCES = [
  { name: 'vendor', url: new URL('../vendor/pyodide/', self.location.href).href },
  { name: 'CDN', url: `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/` },
];

let pyodide = null;
let harness = null;

/* El lazo por bloque corre *dentro* de Python: cruzar la frontera JS<->Python
   una vez por bloque cuesta más que el estimador.

   El estimador guarda su estado en globales del módulo entre bloques; el
   espacio de nombres se rehace sólo al compilar (Run, o un cambio de tasa).

   `params` — FS, BLOCK, C, R_MIC, MIC_POS — se liga antes de ejecutar el
   código, para que lo que se derive de ellos a nivel de módulo use los
   valores reales, y otra vez después, para que lo que se lee sea lo de la
   app aunque el código lo haya pisado. Lo pisado vuelve como lista de nombres
   para avisar, no se deshace en silencio. */
const HARNESS_PY = `
import builtins, math, cmath
import numpy as np

_NS = None

def _same(a, b):
    if isinstance(a, np.ndarray) or isinstance(b, np.ndarray):
        try:
            return bool(np.array_equal(a, b))
        except Exception:
            return False
    try:
        return bool(a == b)
    except Exception:
        return False

def _compile(src, params):
    global _NS
    app = {}
    exec(params, {'__builtins__': builtins, 'np': np}, app)

    ns = {'__builtins__': builtins, 'math': math, 'cmath': cmath,
          'np': np, 'numpy': np}
    ns.update(app)
    exec(src, ns)

    taken = sorted(k for k, v in app.items() if k in ns and not _same(ns[k], v))
    ns.update(app)
    _NS = ns

    if 'process_block' not in ns:
        raise NameError(
            "process_block no está definida: el código tiene que definir "
            "process_block(x, fs) para que la app la llame")
    if not callable(ns['process_block']):
        raise TypeError("process_block no es una función")
    return taken

def _as_deg(v, what):
    if v is None:
        return float('nan')
    if isinstance(v, (bool, np.bool_)):
        raise TypeError("process_block devolvió un bool como %s: tiene que ser grados" % what)
    try:
        a = float(v)
    except (TypeError, ValueError):
        raise TypeError(
            "la %s que devolvió process_block es %s: tiene que ser un número, en grados"
            % (what, type(v).__name__))
    return a if math.isfinite(a) else float('nan')

def _as_map(m):
    if m is None:
        return None
    try:
        vals = np.asarray(m, dtype=float)
    except Exception:
        raise TypeError(
            "el mapa que devolvió process_block es %s: tiene que ser un arreglo "
            "(elevaciones, azimuts)" % type(m).__name__)
    if vals.ndim == 1:
        vals = vals[None, :]
    if vals.ndim != 2 or not (1 <= vals.shape[0] <= 91) or not (4 <= vals.shape[1] <= 720):
        raise ValueError(
            "el mapa tiene forma %s: tiene que ser (E, K), con E de 1 a 91 elevaciones "
            "de 0 a 90 inclusive y K de 4 a 720 azimuts de 0 a 360 sin el 360"
            % (vals.shape,))
    vals = np.where(np.isfinite(vals), vals, 0.0)
    return vals.tolist()

def _split(r):
    """None, (az, el) o (az, el, mapa)."""
    if r is None:
        return float('nan'), float('nan'), None
    if isinstance(r, (tuple, list)) and len(r) in (2, 3):
        az, el = _as_deg(r[0], 'azimut'), _as_deg(r[1], 'elevación')
        if math.isnan(az) or math.isnan(el):
            az = el = float('nan')
        return az, el, _as_map(r[2]) if len(r) == 3 else None
    if isinstance(r, (tuple, list)):
        raise ValueError(
            "process_block devolvió %d cosas: (az, el), (az, el, mapa) o None" % len(r))
    raise TypeError(
        "process_block devolvió un %s: tiene que devolver la dirección como "
        "(az, el) en grados, o None" % type(r).__name__)

def _run(data, fs, block):
    if _NS is None:
        raise NameError("todavía no se compiló nada")
    f = _NS['process_block']
    try:
        raw = data.to_py()
    except AttributeError:
        raw = data
    arr = np.array(raw, dtype=np.float64).reshape(-1, int(block), 4)
    azs, els, mapa, at = [], [], None, -1
    for i in range(arr.shape[0]):
        a, e, m = _split(f(arr[i].copy(), fs))
        azs.append(a)
        els.append(e)
        if m is not None:
            mapa, at = m, i
    return azs, els, mapa, at
`;

function post(msg, transfer) { self.postMessage(msg, transfer || []); }

async function bootPyodide() {
  const errors = [];
  for (const src of SOURCES) {
    try {
      post({ type: 'status', text: `python · ${src.name}` });
      const { loadPyodide } = await import(`${src.url}pyodide.mjs`);
      const py = await loadPyodide({
        indexURL: src.url,
        stdout: text => post({ type: 'stdout', text }),
        stderr: text => post({ type: 'stderr', text }),
      });
      post({ type: 'status', text: `numpy · ${src.name}` });
      await py.loadPackage('numpy');
      return { py, source: src.name };
    } catch (e) {
      errors.push(`${src.name}: ${(e && e.message) || e}`);
    }
  }
  throw new Error(errors.join('\n'));
}

async function init() {
  try {
    const { py, source } = await bootPyodide();
    pyodide = py;
    if (source !== 'vendor') {
      post({ type: 'stderr', text: 'vendor/pyodide/ no disponible: se cargó desde el CDN de jsDelivr.' });
    }
    pyodide.runPython(HARNESS_PY);
    harness = {
      compile: pyodide.globals.get('_compile'),
      run: pyodide.globals.get('_run'),
    };
    const version = pyodide.runPython('import sys; ".".join(map(str, sys.version_info[:3]))');
    post({ type: 'ready', version });
  } catch (e) {
    post({ type: 'error', phase: 'init', message: String((e && e.message) || e) });
  }
}

function compile(id, src, params) {
  try {
    const res = harness.compile(src, params || '');
    const taken = res.toJs ? res.toJs() : res;
    if (res.destroy) res.destroy();
    post({ type: 'compiled', id, taken });
  } catch (e) {
    post({ type: 'error', id, phase: 'compile', message: cleanTrace(e) });
  }
}

function run(msg) {
  const { id, fs, block, data } = msg;
  const t = performance.now();
  let res = null;
  try {
    res = harness.run(data, fs, block);
    const got = res.toJs({ create_pyproxies: false });
    post({
      type: 'result', id,
      az: got[0],
      el: got[1],
      map: got[2] || null,
      mapAt: typeof got[3] === 'number' ? got[3] : -1,
      ms: performance.now() - t,
    });
  } catch (e) {
    post({ type: 'error', id, phase: 'run', message: cleanTrace(e) });
  } finally {
    if (res && res.destroy) res.destroy();
  }
}

/** Saca los cuadros del arnés: que se vea la traza del código propio. */
function cleanTrace(e) {
  const m = String((e && e.message) || e);
  const lines = m.split('\n').filter(l =>
    !l.includes('/lib/python') &&
    !l.includes('pyodide/_') &&
    !l.includes('File "<exec>"'));
  return lines.join('\n').trim() || m;
}

self.onmessage = ev => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init': init(); break;
    case 'compile': compile(msg.id, msg.src, msg.params); break;
    case 'run': run(msg); break;
  }
};
