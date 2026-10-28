/* ═══════════════════════════════════════════════════════════
   editor.js — un módulo por nivel

   Cuatro pestañas, cuatro módulos Python: lo que se ve en cada
   una es el módulo entero, ejecutado tal cual al apretar Run. La
   app busca un solo nombre: process_block.

   STARTERS son el contrato de cada nivel y nada más: los
   estimadores son el ejercicio. Reset vuelve a poner el del nivel
   abierto. Con ?solution=1, si junto a la página hay una carpeta
   solution/ con nivel1.py … nivel4.py (no viene con la consigna),
   abre con esos en lugar de los vacíos.

   Guardar y Abrir usan un solo archivo con los cuatro códigos,
   separados por una línea de marca por nivel (ver pack/unpack).
   ═══════════════════════════════════════════════════════════ */

const Editor = (() => {

  const LEVELS = [1, 2, 3, 4];

  const HEADER = [
    '# ── Lo que pone la app ─────────────────────────────────────────────',
    '#',
    '# Estos nombres son de la app: los liga antes de ejecutar este código y',
    '# otra vez después, así que cambiarlos acá no cambia nada.',
    '#',
    '# FS      Hz. No es fijo: lo mide la app en cada trama, 1 MHz / R del CIC',
    '#         que esté cargado en el FPGA (o el R elegido en la sintética).',
    '# BLOCK   muestras por canal en cada llamada: la potencia de dos que hace',
    '#         que un bloque dure unos 33 ms a esa FS.',
    '#',
    '# Los valores de ahora están en la franja de arriba.',
    '',
    'import numpy as np',
    '',
    'C = 343.0                     # m/s',
    'R_MIC = 0.02058               # m, radio de la cruz',
    'MIC_POS = np.array([[R_MIC, 0.0],    # 0: +x',
    '                    [0.0, R_MIC],    # 1: +y',
    '                    [-R_MIC, 0.0],   # 2: -x',
    '                    [0.0, -R_MIC]])  # 3: -y',
    '',
    '',
  ];

  const X_DOC = [
    '    x   arreglo (BLOCK, 4): columna c = micrófono c, en MIC_POS[c].',
    '        Plena escala ±1 (las muestras de 24 bits divididas por 2^23),',
    '        con el offset de DC de cada micrófono todavía puesto.',
    '    fs  frecuencia de muestreo, Hz.',
    '',
  ];

  const STARTERS = {
    1: [
      ...HEADER,
      '# ── level 1: par lineal y desfasaje ───────────────────────────────',
      '',
      'def process_block(x, fs):',
      '    """El ángulo de incidencia sobre el par 0-2, por diferencia de fase.',
      '',
      ...X_DOC,
      '    En este nivel se usan sólo las columnas 0 (+x) y 2 (-x), separadas',
      '    d = 2·R_MIC. Sin beamforming: X_0 y X_2 por Goertzel a la frecuencia',
      '    del tono, su diferencia de fase, el retardo y de ahí el ángulo.',
      '',
      '    Devolver (theta, 0.0), con theta en grados de 0 a 180 medido desde',
      '    +x (el micrófono 0), o None si no hay tono. Un par lineal no',
      '    distingue theta de -theta: la herramienta dibuja las dos.',
      '    """',
      '',
      '    return None',
      '',
    ],
    2: [
      ...HEADER,
      '# ── level 2: beamforming con dos micrófonos ───────────────────────',
      '',
      'def process_block(x, fs):',
      '    """El ángulo de incidencia sobre el par 0-2, por barrido de potencia.',
      '',
      ...X_DOC,
      '    Con el mismo par del level 1: para cada dirección candidata',
      '    theta_s = 0°, 1°, ..., 179°, compensar la fase prevista en los dos',
      '    canales, sumar, y quedarse con la de mayor potencia.',
      '',
      '    Devolver (theta, 0.0, P), o None si no hay tono:',
      '',
      '        theta   grados, de 0 a 180, medido desde +x.',
      '        P       180 valores: la potencia apuntando a cada theta_s.',
      '                La herramienta la dibuja como patrón (botón Patrón),',
      '                normalizada a su máximo.',
      '    """',
      '',
      '    return None',
      '',
    ],
    3: [
      ...HEADER,
      '# ── level 3: los cuatro micrófonos en cruz ────────────────────────',
      '',
      'def process_block(x, fs):',
      '    """Azimut y elevación, por barrido de potencia con los cuatro.',
      '',
      ...X_DOC,
      '    Devolver (az, el, mapa), o None si no hay tono:',
      '',
      '        az     azimut en grados: 0° = +x (micrófono 0), antihorario.',
      '        el     elevación en grados: 0° = en el plano de la cruz,',
      '               90° = perpendicular a la placa. Una cruz plana no',
      '               distingue arriba de abajo: se da de 0 a 90.',
      '        mapa   (E, K): la potencia en cada dirección probada, E',
      '               elevaciones de 0 a 90 inclusive por K azimuts de 0 a',
      '               360 sin repetir el 360.',
      '    """',
      '',
      '    return None',
      '',
    ],
    4: [
      ...HEADER,
      '# ── level 4 (opcional): ajuste por cuadrados mínimos ──────────────',
      '',
      'def process_block(x, fs):',
      '    """Azimut y elevación, por cuadrados mínimos sobre los retardos.',
      '',
      ...X_DOC,
      '    Las fases de los cuatro canales (Goertzel), las diferencias entre',
      '    pares convertidas a retardos, y el sistema A·u_xy ≈ b de la',
      '    consigna resuelto por cuadrados mínimos.',
      '',
      '    Devolver (az, el) en grados, como en el level 3, o None si no hay',
      '    tono o el resultado no es físicamente válido. Opcionalmente',
      '    (az, el, mapa), con el mapa como en el level 3.',
      '    """',
      '',
      '    return None',
      '',
    ],
  };
  for (const n of LEVELS) STARTERS[n] = STARTERS[n].join('\n');

  const wantsSolution = () => {
    try { return new URLSearchParams(location.search).has('solution'); }
    catch { return false; }
  };

  /* La solución, si se pidió y se pudo cargar, guarda en otras claves: abrir
     ?solution=1 nunca pisa el código propio. */
  let solution = null;
  const lsKey = n => `mic_array_sandbox${solution ? '.solution' : ''}.level${n}`;
  const LS_LEVEL = 'mic_array_sandbox.open_level';

  const shipped = n => (solution && solution[n]) || STARTERS[n];

  let cm = null, ta = null, runCb = () => {};
  let level = 1;
  const docs = {};          // CodeMirror.Doc por nivel (cada uno con su deshacer)
  const texts = {};         // lo mismo sin CodeMirror

  function stored(n) {
    try {
      const s = localStorage.getItem(lsKey(n));
      if (typeof s === 'string' && s.trim()) return s;
    } catch { /* sin almacenamiento */ }
    return shipped(n);
  }

  function save(n) {
    try { localStorage.setItem(lsKey(n), getSource(n)); } catch { /* cuota o modo privado */ }
  }

  function makeDoc(n, text) {
    const d = CodeMirror.Doc(text, { name: 'python', version: 3, singleLineStringErrors: false });
    d.on('change', () => save(n));
    return d;
  }

  async function fetchSolution() {
    const got = {};
    for (const n of LEVELS) {
      try {
        const r = await fetch(`solution/nivel${n}.py`, { cache: 'no-cache' });
        if (r.ok) got[n] = await r.text();
      } catch { /* no está */ }
    }
    return Object.keys(got).length ? got : null;
  }

  /** @returns {Promise<string|null>} un aviso para la consola, si hace falta */
  async function init(opts) {
    runCb = (opts && opts.onRun) || runCb;
    let note = null;
    if (wantsSolution()) {
      solution = await fetchSolution();
      note = solution
        ? `?solution=1: abiertos los estimadores resueltos (niveles ${Object.keys(solution).join(', ')}), en un almacenamiento aparte del propio`
        : '?solution=1, pero no hay carpeta solution/ junto a la página: se abren los códigos propios';
    }
    try { level = +localStorage.getItem(LS_LEVEL) || 1; } catch { level = 1; }
    if (!LEVELS.includes(level)) level = 1;

    const el = document.getElementById('code-body');
    const extraKeys = {
      Tab: c => c.execCommand('indentMore'),
      'Shift-Tab': c => c.execCommand('indentLess'),
      'Ctrl-Enter': () => runCb(),
      'Cmd-Enter': () => runCb(),
    };
    if (window.CodeMirror) {
      for (const n of LEVELS) docs[n] = makeDoc(n, stored(n));
      cm = CodeMirror(el, {
        value: docs[level],
        theme: 'material-darker',
        lineNumbers: true, indentUnit: 4, indentWithTabs: false, smartIndent: true,
        matchBrackets: true, styleActiveLine: true, viewportMargin: Infinity,
        extraKeys,
      });
    } else {
      for (const n of LEVELS) texts[n] = stored(n);
      ta = document.createElement('textarea');
      ta.className = 'fallback';
      ta.spellcheck = false;
      ta.value = texts[level];
      el.appendChild(ta);
      ta.addEventListener('input', () => { texts[level] = ta.value; save(level); });
      ta.addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runCb(); }
        if (e.key === 'Tab') {
          e.preventDefault();
          ta.setRangeText('    ', ta.selectionStart, ta.selectionEnd, 'end');
          ta.dispatchEvent(new Event('input'));
        }
      });
    }
    return note;
  }

  function getSource(n = level) {
    if (cm) return docs[n].getValue();
    return n === level && ta ? ta.value : texts[n];
  }

  function setSource(text, n = level) {
    if (cm) docs[n].setValue(text);
    else {
      texts[n] = text;
      if (n === level && ta) ta.value = text;
    }
    save(n);
  }

  function setLevel(n) {
    if (!LEVELS.includes(n) || n === level) return;
    if (ta) texts[level] = ta.value;
    level = n;
    if (cm) cm.swapDoc(docs[n]);
    else if (ta) ta.value = texts[n];
    try { localStorage.setItem(LS_LEVEL, String(n)); } catch { /* nada */ }
  }

  const reset = () => setSource(shipped(level));

  /* ─────────── el archivo con los cuatro ─────────── */

  const MARK = n => `# ===== Mic array sandbox: level ${n} =====`;
  const MARK_RE = /^# ===== Mic array sandbox: level ([1-4]) =====\s*$/;

  function pack() {
    const d = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const head = [
      '# Mic array sandbox: los cuatro niveles en un archivo.',
      `# Guardado el ${d}. Se abre con el botón Abrir de la herramienta;`,
      '# cada nivel empieza en su línea de marca y llega hasta la siguiente.',
      '',
    ].join('\n');
    return head + LEVELS.map(n => `${MARK(n)}\n${getSource(n).replace(/\s*$/, '')}\n`).join('\n');
  }

  /** @returns {{levels: number[]}} qué niveles traía el archivo */
  function unpack(text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const found = {};
    let cur = null;
    for (const ln of lines) {
      const m = ln.match(MARK_RE);
      if (m) { cur = +m[1]; found[cur] = []; continue; }
      if (cur !== null) found[cur].push(ln);
    }
    const levels = Object.keys(found).map(Number);
    if (!levels.length) {               // un .py suelto: al nivel abierto
      setSource(text);
      return { levels: [level], single: true };
    }
    for (const n of levels) setSource(found[n].join('\n').replace(/\s*$/, '') + '\n', n);
    return { levels };
  }

  /* Mientras corre, el código en pantalla ya no es el que corre: el
     intérprete tiene el de Run. Para que no se separen sin aviso, el editor
     queda de sólo lectura hasta Stop. */
  function setReadOnly(on) {
    if (cm) cm.setOption('readOnly', on ? 'nocursor' : false);
    if (ta) ta.readOnly = on;
    const shell = document.getElementById('code-shell');
    if (shell) shell.classList.toggle('readonly', on);
  }

  return {
    init, getSource, setSource, reset, setReadOnly, setLevel, pack, unpack,
    level: () => level, LEVELS, STARTERS,
  };
})();
