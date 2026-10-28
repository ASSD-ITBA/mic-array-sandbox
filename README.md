# Mic array sandbox

Código Python a la izquierda, en cuatro pestañas, una por nivel; a la derecha,
los cuatro micrófonos y un gráfico de la dirección. El código que se ve es el
que decide desde dónde llega el sonido, en el navegador, sin instalar nada.

Versión web: https://assd-itba.github.io/mic-array-sandbox/ (no hay que instalar nada).

O local:

```
start.cmd
```

Abre `http://localhost:8000` en el navegador. Tiene que ser por http: los
navegadores no dejan correr Web Workers ni WebAssembly desde `file://`. Para la
placa hace falta **Chrome o Edge** (Web Serial); la fuente sintética funciona en
cualquiera.

Cada pestaña abre con un `process_block` vacío: los estimadores son el
ejercicio.

---

## De dónde vienen las muestras

**Placa.** **Conectar** y elegir la pico-ice (VID:PID `1209:b1c0`). Llegan los
cuatro canales tal como salen del CIC del FPGA. La franja de estado dice la tasa,
tramas por segundo y pérdidas, y si el RP2040 responde pero el FPGA no está
configurado o no manda tramas. Después de un `apio upload` la placa se reinicia:
volver a **Conectar**.

**Sintética.** Una onda plana desde el azimut y la elevación elegidos, generada
aquí, en el mismo formato que la placa (enteros de 24 bits, con offset de DC
distinto por canal). Frecuencia de 100 Hz a 8 kHz, ruido, giro a 30°/s y el R
simulado. La dirección de verdad es el aro punteado del polar, y arriba se lee el
error en azimut y en elevación.

Un estimador que anda con la sintética y no con la placa es el resultado normal,
y el interesante: la sala trae reflexiones, ruido que no es blanco y micrófonos
que no son idénticos.

## La tasa no es de la app

fs = 1 MHz / R, con el R del CIC que esté cargado en el FPGA. La placa lo manda
en cada trama (medido, no declarado), así que al cargar otro bitstream la app se
entera sola: cambia FS, cambia BLOCK y, si Python estaba corriendo, recompila. Lo
dice en la consola.

BLOCK es la potencia de dos que hace que un bloque dure unos 33 ms a esa fs
(1024 a 31.25 kHz, 256 a 7.8 kHz).

## Los niveles

Una pestaña por nivel de la consigna, cada una con su propio código, que se
guarda solo en el navegador. Run corre el de la pestaña abierta; cambiar de
pestaña lo detiene.

| Pestaña | Qué se estima | Qué devuelve `process_block` | Vista |
|---------|---------------|------------------------------|-------|
| level 1 | Ángulo de incidencia sobre el par 0–2, por diferencia de fase. | `(theta, 0.0)` | El par |
| level 2 | Lo mismo, por barrido de 180 direcciones (beamforming). | `(theta, 0.0, P)`, `P` con 180 valores | El par, con el patrón |
| level 3 | Azimut y elevación con los cuatro, por barrido. | `(az, el, mapa)` | Hemisferio, con mapa |
| level 4 (opcional) | Azimut y elevación por cuadrados mínimos. | `(az, el)` o `(az, el, mapa)` | Hemisferio |

**El par (levels 1 y 2).** El eje del par en horizontal, micrófono 0 a la
derecha. La estimación se dibuja como una onda que llega desde θ, con sus frentes
de onda; punteada, su imagen especular −θ: un par lineal no las distingue, por
eso theta va de 0° a 180°. Con la fuente sintética se compara contra el ángulo
que el par puede ver, cos θ = cos az · cos el, no contra el azimut. En el level
2, **Patrón** muestra u oculta P(θs), normalizado a su máximo y en lineal (como
P/Pmax = cos²(…) de la consigna).

**El hemisferio (levels 3 y 4).** El ángulo alrededor del dial es el azimut, y el
radio la elevación: el borde es el horizonte (0°) y el centro el cenit (90°).
**Mapa** muestra u oculta el mapa, pintado en un solo tono, en dB entre su mínimo
y su máximo (30 dB como mucho).

**Guardar** descarga `mic_array_sandbox.py`: los cuatro códigos en un solo
archivo, cada uno después de una línea de marca
(`# ===== Mic array sandbox: level N =====`). Es el archivo para entregar o
compartir. **Abrir** lo vuelve a cargar en las cuatro pestañas; un `.py` sin
marcas se carga en la pestaña abierta. **Reset** vuelve a poner el código inicial
de la pestaña abierta.

## El contrato

Un módulo Python por pestaña, ejecutado tal cual al apretar Run (o Ctrl+Enter).
La app llama a un solo nombre, una vez por bloque:

```python
def process_block(x, fs):
    ...
    return az, el
```

`x` es un arreglo `(BLOCK, 4)`: columna `c` = micrófono `c`. Plena escala ±1 (las
muestras de 24 bits divididas por 2²³), con el offset de DC todavía puesto.
Devolver la dirección en grados, o `None` si no hay nada que ubicar:

- `az`, azimut: 0° = +x (micrófono 0), creciendo antihorario;
- `el`, elevación: 0° = en el plano de la cruz, 90° = perpendicular a la placa.
  Una cruz plana no distingue arriba de abajo (+el y −el dan las mismas cuatro
  señales), así que se da de 0 a 90.

En los levels 1 y 2, `az` es el ángulo theta del par (0° a 180°) y `el` va en 0.

Opcionalmente, un tercer valor:

```python
return az, el, mapa
```

- level 2: `mapa` es un vector de K valores, P para θs equiespaciados de 0° a
  180° sin el 180 (con 180 valores, θs = 0°, 1°, …, 179°).
- levels 3 y 4: `mapa` es `(E, K)`, E elevaciones de 0 a 90 inclusive por K
  azimuts de 0 a 360 sin el 360.

**Nombres de la app**, ligados antes y después de ejecutar el código (pisarlos no
cambia nada, salvo un aviso en la consola):

```python
FS        # Hz, el de ahora
BLOCK     # muestras por canal en cada llamada
C         # 343.0 m/s
R_MIC     # 0.02058 m
MIC_POS   # (4, 2): [x, y] de cada micrófono, en m
```

`numpy` (como `np`), `math` y `cmath` están disponibles. Lo que se define a nivel
de módulo sobrevive entre bloques; el módulo se rehace sólo al apretar Run o
cuando cambia la tasa. Un lazo infinito no cuelga la página: un perro guardián
reinicia el intérprete y lo dice.

La consola muestra cuánto tarda cada bloque contra lo que dura. Si tarda más, la
app descarta bloques para no atrasarse y avisa.

## Pantalla

**Osciloscopio**: una franja por micrófono, acoplada en alterna, con disparo en
el cruce ascendente del canal 0. Con un tono, lo que se corre entre franjas es el
retardo entre micrófonos. **Espectro**: los cuatro superpuestos en dBFS, de 0 a
fs/2, con la línea de c/(4r) ≈ 4.17 kHz, por encima de la cual la fase entre
pares opuestos da la vuelta. Escalas fijas, a propósito.

**Grabar** guarda los cuatro canales en un WAV de 4 canales PCM de 32 bits (la
muestra de 24 bits corrida 8 lugares), hasta 60 s.

## Fuera del navegador

`estimador.py` es el mismo contrato como archivo, con un banco. Pegar ahí el
código de una pestaña (o la sección de ese nivel del archivo de Guardar):

```
python estimador.py --nivel N               tonos desde direcciones conocidas
python estimador.py --nivel N captura.wav   una grabación del botón Grabar
```

Con `--nivel 1` o `2` compara theta contra el ángulo que ve el par; con `3` o `4`,
azimut y elevación.

## Archivos

```
index.html            una página, sin compilación
css/styles.css        la hoja de estilos
js/geometry.js        la cruz, como datos: la única copia
js/board.js           Web Serial y el formato del cable
js/synth.js           la fuente sintética
js/fft.js             FFT radix-2, sólo para el espectro
js/scope.js           osciloscopio y espectro
js/polar.js           la vista de la dirección: el par (1 y 2) y el hemisferio (3 y 4)
js/editor.js          el editor, las cuatro pestañas y Guardar/Abrir
js/pyrunner.js        frente del worker + perro guardián
js/pyworker.js        Pyodide y el arnés por bloque
js/app.js             el motor
estimador.py          el contrato como archivo, con banco — vacío
vendor/               Pyodide (~16 MB) y CodeMirror, con el CDN de respaldo
serve.ps1             servidor estático, sin permisos de administrador
start.cmd             doble clic: la app
```

Comparte con el DTMF sandbox el worker de Python, el editor y el aspecto.
