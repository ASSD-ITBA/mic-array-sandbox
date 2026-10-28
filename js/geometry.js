/* ═══════════════════════════════════════════════════════════
   geometry.js — la cruz, como datos: la única copia

   Los cuatro micrófonos del anillo interior que caen sobre los
   ejes, a 20.58 mm del centro (puertos acústicos medidos en el
   PCB). Canal c en MICS[c]. Ángulos desde +x, antihorario,
   mirando la placa de micrófonos desde arriba.

   Lo usan la fuente sintética, el gráfico polar y el bloque de
   parámetros que se le pasa a Python, así que no pueden
   desacordar entre sí. El FPGA tiene la misma tabla en top.v.
   ═══════════════════════════════════════════════════════════ */

const Geo = (() => {
  const R_MIC = 0.02058;         // m
  const C = 343.0;               // m/s, aire a ~20 °C
  const F_PDM = 1e6;             // Hz: 12 MHz / 12, fijado por fpga/top.v

  const MICS = [
    [R_MIC, 0],                  // 0: +x,   0°
    [0, R_MIC],                  // 1: +y,  90°
    [-R_MIC, 0],                 // 2: -x, 180°
    [0, -R_MIC],                 // 3: -y, 270°
  ];
  const NAMES = ['+x', '+y', '−x', '−y'];

  /* Pares opuestos a 2·R_MIC: la diferencia de fase entre ellos deja de ser
     unívoca cuando media longitud de onda ya no cubre la separación. Es el
     peor caso, con la fuente en el plano de la cruz (elevación 0). */
  const F_ALIAS = C / (4 * R_MIC);

  /**
   * Adelanto [s] con que llega al micrófono c una onda plana desde (az, el).
   * Elevación 0 = en el plano de la cruz, 90° = perpendicular (cenit). Sólo
   * la proyección sobre el plano, cos(el)·(cos az, sin az), produce retardos:
   * una fuente a +el y otra a −el dan las mismas cuatro señales.
   */
  function lead(c, azRad, elRad = 0) {
    const k = Math.cos(elRad) / C;
    return k * (MICS[c][0] * Math.cos(azRad) + MICS[c][1] * Math.sin(azRad));
  }

  return { R_MIC, C, F_PDM, MICS, NAMES, F_ALIAS, lead };
})();
