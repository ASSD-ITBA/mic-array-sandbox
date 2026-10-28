"""estimador.py — el contrato de la herramienta, como archivo para correr fuera de ella.

La herramienta ejecuta el editor como un módulo y llama a un solo nombre, una vez
por bloque:

    def process_block(x, fs):
        ...
        return az, el          # grados; o None si no hay nada que ubicar
        return az, el, mapa    # opcional: mapa (E, K) para pintar en el polar

    az   azimut: 0° = +x (micrófono 0), creciendo antihorario
    el   elevación: 0° = en el plano de la cruz, 90° = perpendicular a la placa.
         Una cruz plana no distingue arriba de abajo: se da de 0 a 90.
    mapa un valor positivo por dirección: E elevaciones de 0 a 90 inclusive,
         K azimuts de 0 a 360 sin el 360

    x    arreglo (BLOCK, 4), columna c = micrófono c en MIC_POS[c], plena escala ±1,
         con el offset de DC de cada micrófono todavía puesto
    fs   frecuencia de muestreo, Hz

Estos nombres son de la herramienta y acá se ligan igual:

    FS        Hz: 1 MHz / R del CIC (en un WAV, la tasa del archivo)
    BLOCK     muestras por canal por llamada: la potencia de dos que dura ~33 ms
    C         343.0 m/s
    R_MIC     0.02058 m, radio de la cruz
    MIC_POS   (4, 2): [x, y] de cada micrófono, en m

Dos usos:

    python estimador.py [--nivel N]               tonos desde direcciones conocidas
    python estimador.py [--nivel N] captura.wav   una grabación del botón Grabar

--nivel (1 a 4, por defecto 3) dice contra qué comparar. En los niveles 1 y 2,
con el par 0-2, process_block devuelve (theta, 0.0) y se compara theta con el
ángulo que ve el par, cos θ = cos az · cos el, igual que en la herramienta. En
los niveles 3 y 4 se comparan azimut y elevación.

Para probar el código de una pestaña acá, pegarlo en lugar del process_block de
abajo (o Guardar en la herramienta y copiar la sección de ese nivel).

El WAV es de 4 canales PCM de 32 bits (la muestra de 24 bits corrida 8 lugares),
así que dividir por 2^31 da la misma plena escala que ve process_block.
"""

import math
import sys

import numpy as np

C = 343.0
R_MIC = 0.02058
MIC_POS = np.array([[R_MIC, 0.0], [0.0, R_MIC], [-R_MIC, 0.0], [0.0, -R_MIC]])
FS = 31250.0
BLOCK = 1024


# ─────────────────────────── el estimador ───────────────────────────

def process_block(x, fs):

    # x es un arreglo (BLOCK, 4). Devolver (az, el) en grados, o None.

    return None


# ──────────────────────────── el banco ─────────────────────────────
#
# Todo lo de abajo hace las veces de la herramienta: arma la señal, la corta en
# bloques y compara. No debería hacer falta tocarlo.

def block_for(fs):
    """La misma elección que la herramienta: potencia de dos de ~33 ms."""
    return int(min(4096, max(256, 2 ** round(math.log2(fs * 0.033)))))


def bind(fs):
    global FS, BLOCK
    FS = float(fs)
    BLOCK = block_for(fs)


def synth(az_deg, el_deg, freq, fs, n, level=0.25, noise=0.02, seed=0):
    """Onda plana desde (az, el), como la fuente sintética de la herramienta."""
    rng = np.random.default_rng(seed)
    t = np.arange(n) / fs
    a, e = math.radians(az_deg), math.radians(el_deg)
    lead = math.cos(e) * (MIC_POS @ np.array([math.cos(a), math.sin(a)])) / C
    dc = np.array([0.004, -0.003, 0.002, -0.005])
    x = level * np.sin(2 * np.pi * freq * (t[:, None] + lead[None, :])) + dc
    x += noise * rng.standard_normal(x.shape)
    return np.round(np.clip(x, -1, 1 - 2 ** -23) * 2 ** 23) / 2 ** 23


def read_wav(path):
    """WAV PCM de 4 canales -> (fs, x) con x en plena escala ±1. Sólo numpy."""
    raw = open(path, "rb").read()
    if raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
        raise ValueError(f"{path}: no es un WAV")
    p, fmt, data = 12, None, None
    while p + 8 <= len(raw):
        cid, size = raw[p:p + 4], int.from_bytes(raw[p + 4:p + 8], "little")
        body = raw[p + 8:p + 8 + size]
        if cid == b"fmt ":
            fmt = (int.from_bytes(body[2:4], "little"), int.from_bytes(body[4:8], "little"),
                   int.from_bytes(body[14:16], "little"))
        elif cid == b"data":
            data = body
        p += 8 + size + (size & 1)
    ch, fs, bits = fmt
    if bits != 32:
        raise ValueError(f"{path}: se esperaban muestras de 32 bits, hay de {bits}")
    x = np.frombuffer(data, dtype="<i4").reshape(-1, ch) / 2.0 ** 31
    return fs, x


def angle_err(a, b):
    return (a - b + 180.0) % 360.0 - 180.0


def as_dir(r):
    """Lo que devolvió process_block -> (az, el) en grados, o None."""
    if r is None:
        return None
    if not isinstance(r, (tuple, list)) or len(r) not in (2, 3):
        raise TypeError("process_block tiene que devolver (az, el), (az, el, mapa) o None")
    if r[0] is None or r[1] is None:
        return None
    return float(r[0]) % 360.0, float(r[1])


def pair_angle(az, el):
    """El ángulo que ve el par 0-2: cos θ = cos az · cos el, en 0..180°."""
    c = math.cos(math.radians(az)) * math.cos(math.radians(el))
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def bench(nivel=3):
    bind(31250.0)
    pair = nivel in (1, 2)
    print(f"level {nivel}: FS = {FS:g} Hz, BLOCK = {BLOCK}, c/4r = {C / (4 * R_MIC):.0f} Hz\n")
    if pair:
        print("   fuente az  el   frec [Hz]   el par ve    estimado θ      error")
    else:
        print("   verdad az  el   frec [Hz]    estimado az    el      error az    el")
    worst_az = worst_el = 0.0
    n_ok = 0
    for az, el, f in [(0, 0, 1000), (45, 20, 1000), (90, 40, 700), (135, 10, 1500),
                      (200, 60, 2000), (270, 30, 3000), (330, 5, 3800), (60, 0, 5000)]:
        x = synth(az, el, f, FS, BLOCK, seed=az)
        d = as_dir(process_block(x, FS))
        alias = f > C / (4 * R_MIC * math.cos(math.radians(el)))
        flag = "   <- sobre c/4r" if alias else ""
        if d is None:
            print(f"   {az:9.1f} {el:4.0f}   {f:9.0f}           None{flag}")
            continue
        if pair:
            th = pair_angle(az, el)
            eaz, eel = d[0] - th, 0.0
            print(f"   {az:9.1f} {el:4.0f}   {f:9.0f}   {th:9.1f}    {d[0]:10.1f}   {eaz:+8.1f}{flag}")
        else:
            eaz, eel = angle_err(d[0], az), d[1] - el
            print(f"   {az:9.1f} {el:4.0f}   {f:9.0f}    {d[0]:11.1f} {d[1]:5.1f}   "
                  f"{eaz:+10.1f} {eel:+5.1f}{flag}")
        if not alias:
            worst_az, worst_el = max(worst_az, abs(eaz)), max(worst_el, abs(eel))
            n_ok += 1
    if not n_ok:
        print("\nprocess_block no devolvió ninguna dirección por debajo de c/4r")
    elif pair:
        print(f"\nerror máximo por debajo de c/4r: θ {worst_az:.1f}°")
    else:
        print(f"\nerror máximo por debajo de c/4r: az {worst_az:.1f}°, el {worst_el:.1f}°")


def run_wav(path):
    fs, x = read_wav(path)
    bind(fs)
    n = x.shape[0] // BLOCK
    print(f"{path}: {x.shape[0] / fs:.2f} s, fs = {fs} Hz, BLOCK = {BLOCK}, {n} bloques\n")
    ests = [as_dir(process_block(x[i * BLOCK:(i + 1) * BLOCK].copy(), FS)) for i in range(n)]
    step = max(1, round(0.25 * fs / BLOCK))           # una línea cada ~0.25 s
    for i in range(0, n, step):
        d = ests[i]
        print(f"  t = {i * BLOCK / fs:6.2f} s   " +
              ("—" if d is None else f"az {d[0]:6.1f}°  el {d[1]:5.1f}°"))
    got = np.array([d for d in ests if d is not None])
    if got.size:
        a = np.radians(got[:, 0])
        m = math.degrees(math.atan2(np.sin(a).mean(), np.cos(a).mean())) % 360
        print(f"\n{len(got)}/{n} bloques con estimación: azimut medio (circular) {m:.1f}°, "
              f"elevación mediana {np.median(got[:, 1]):.1f}°")
    else:
        print("\nningún bloque devolvió una dirección")


def main(argv):
    nivel, rest = 3, []
    it = iter(argv)
    for a in it:
        if a == "--nivel":
            nivel = int(next(it))
        else:
            rest.append(a)
    if nivel not in (1, 2, 3, 4):
        sys.exit("--nivel va de 1 a 4")
    if rest:
        run_wav(rest[0])
    else:
        bench(nivel)


if __name__ == "__main__":
    main(sys.argv[1:])
