/**
 * Construye la estructura lógica de agrupación por colores para la etapa de Impresión.
 * 
 * @param {Object} queues - Diccionario con las colas de trabajo por máquina.
 * Formato exacto esperado:
 * {
 *   'SPEEDMASTER': [ { n, linea, codigo_material, producto, presentacion_comercial, material_requerido, cantidad_requerida_para_cubrir, n_colores, maquina, n_troquel, un_tiraje, ciclos, tirajes, ... }, ... ],
 *   'MOZP': [ ... ],
 *   'GTO-52': [ ... ]
 * }
 * Campos de queue usados explícitamente:
 * - job.linea (Agrupación principal)
 * - job.codigo_material (Match con btRows)
 * - job.n, job.producto, job.presentacion_comercial, job.material_requerido, job.cantidad_requerida_para_cubrir, job.n_colores, job.maquina, job.n_troquel, job.un_tiraje, job.ciclos, job.tirajes (Preservados en los items)
 * 
 * @param {Array} btRows - Array de objetos representando las filas de la tabla técnica bt_imprenta.
 * Formato exacto esperado:
 * [
 *   { codigo: 'IFA-123', codigo_2: 'CYAN, MAGENTA', ... },
 *   ...
 * ]
 * Campos de btRows usados explícitamente:
 * - r.codigo / r.código / r.CÓDIGO (Para el match)
 * - r.codigo_2 / r.código_2 / r.CÓDIGO_2 (Para la extracción de colores)
 * 
 * @returns {Object} structure - Estructura jerárquica: { Máquina: { Línea: { NormalizedColors: { items: [...] } } } }
 */
window.buildScheduleLogicStructure = function buildScheduleLogicStructure(queues, btRows) {
  const structure = {
    'SPEEDMASTER': {},
    'MOZP': {},
    'GTO-52': {}
  };

  const machines = ['SPEEDMASTER', 'MOZP', 'GTO-52'];
  
  machines.forEach(machine => {
    const bodies = (machine === 'GTO-52') ? 4 : 2;
    const queue = queues[machine] || [];
    const groupsByLinea = {};

    queue.forEach(job => {
      const linea = job.linea || 'SIN LINEA';
      if (!groupsByLinea[linea]) groupsByLinea[linea] = {};

      // Match con bt_imprenta (Match: COD-IFA -> código)
      // Normalización robusta para nombres de columna y valores
      let excludeReason = '';
      const match = btRows.find(r => {
        const btCode = String(r['codigo'] || r['código'] || r['CÓDIGO'] || '').trim().toUpperCase();
        const planCode = String(job.codigo_material || '').trim().toUpperCase();
        return btCode === planCode && btCode !== '';
      });

      if (!match) excludeReason = 'IFA no encontrado en bt_imprenta';
      
      const originalColors = match ? (match['codigo_2'] || match['código_2'] || match['CÓDIGO_2'] || '') : '';
      const valid = window.isValidColorCode(originalColors);
      
      if (match && !valid) excludeReason = 'código_2 vacío o inválido (-)';
      
      const normalized = valid ? window.normalizeColors(originalColors) : 'INVALIDO';
      const cycles = valid ? window.getColorsPerCycle(originalColors, bodies) : [];

      if (!groupsByLinea[linea][normalized]) {
        groupsByLinea[linea][normalized] = {
          normalizedColors: normalized,
          items: []
        };
      }

      groupsByLinea[linea][normalized].items.push({
        // Identificadores base
        rma: job.n,
        product: job.producto,
        ifa: job.codigo_material,

        // Campos originales restaurados (Nombres íntegros de Planificación)
        presentacion_comercial: job.presentacion_comercial,
        material_requerido: job.material_requerido,
        cantidad_requerida_para_cubrir: job.cantidad_requerida_para_cubrir,
        linea: job.linea,
        n_colores: job.n_colores,
        maquina: job.maquina,
        n_troquel: job.n_troquel,
        un_tiraje: job.un_tiraje,
        ciclos: job.ciclos,
        tirajes: job.tirajes,

        // Datos técnicos calculados
        originalColors: originalColors,
        normalizedColors: normalized,
        cycles: cycles,
        numCycles: cycles.length,
        bodies: bodies,
        isValid: valid,
        excludeReason: excludeReason,

        // Referencia completa
        jobRef: job
      });
    });

    structure[machine] = groupsByLinea;
  });

  return structure;
};

/**
 * Asigna los bloques de tiempo en el cronograma para la etapa de Impresión.
 * 
 * @param {Object} logicBase - Estructura agrupada retornada por buildScheduleLogicStructure.
 * @param {Array} tiemposData - Datos técnicos de tiempos de máquina.
 * @param {Object} scheduledBlocks - Objeto mutado in-place donde se guardan los bloques.
 * @param {Object} rmaFinishTracker - Objeto mutado in-place que guarda el min abs en que un RMA termina de imprimirse.
 * @param {Number} turnoInicio - Inicio de turno en minutos (ej. 480).
 * @param {Number} turnoFin - Fin de turno en minutos (ej. 1050).
 */
window.scheduleImpresionStage = function scheduleImpresionStage(
  logicBase,
  tiemposData,
  scheduledBlocks,
  rmaFinishTracker,
  turnoInicio,
  turnoFin
) {
  // --- NUEVA CAPA DE OBSERVACIÓN ---
  let releaseEvents = [];
  ['SPEEDMASTER', 'MOZP', 'GTO-52'].forEach(machine => {
    const groupsByLinea = logicBase[machine] || {};
    if (Object.keys(groupsByLinea).length === 0) return;

    let cursorDay = 0;
    let cursorMin = turnoInicio;

    const mqTiempos = tiemposData.find(t => {
      const maqt = (t.maquina || '').toUpperCase().replace(/\s|-/g, '');
      const mac = machine.toUpperCase().replace(/\s|-/g, '');
      return maqt === mac;
    }) || {};

    function addBlock(duration, type, job, details, customClass, extraData = null) {
      const res = window.allocateTimeBlocks({
        duration, machine, cursorDay, cursorMin, 
        turnoInicio: turnoInicio, turnoFin: turnoFin,
        scheduledBlocksObj: scheduledBlocks, 
        type, job, details, customClass, extraData
      });
      cursorDay = res.cursorDay;
      cursorMin = res.cursorMin;
    }

    // 1. Iterar por Línea
    const sortedLineas = Object.keys(groupsByLinea).sort();
    sortedLineas.forEach(lineaName => {
      const colorGroups = groupsByLinea[lineaName];

      // 2. Ordenar Grupos de Colores por complejidad (cantidad de colores únicos)
      const sortedColorSets = Object.keys(colorGroups).sort((a, b) => {
        if (a === 'INVALIDO') return 1;
        if (b === 'INVALIDO') return -1;
        return b.length - a.length;
      });

      sortedColorSets.forEach(colorSet => {
        if (colorSet === 'INVALIDO') return; // Excluir productos inválidos del cronograma

        const group = colorGroups[colorSet];
        const validItems = group.items.filter(i => i.isValid);
        if (validItems.length === 0) return;

        // 3. Validar consistencia de ciclos en el grupo
        const cycleCounts = validItems.map(i => i.numCycles);
        const maxCycles = Math.max(...cycleCounts);
        const allSame = cycleCounts.every(c => c === maxCycles);

        if (!allSame) {
          console.warn(`Advertencia: Ciclos inconsistentes en el grupo ${colorSet} de la línea ${lineaName}. Se usará maxCycles=${maxCycles}.`);
        }

        // 4. Renderizado por Ciclos
        for (let c = 0; c < maxCycles; c++) {
          validItems.forEach((item, itemIdx) => {
            // Protección: Si el producto no tiene este ciclo (grupos heterogéneos), omitir
            if (!item.cycles[c]) return;

            const job = item.jobRef;
            const nColoresCiclo = item.cycles[c].length; // Cuerpos activos en este ciclo
            const tirajes = parseFloat(job.tirajes) || 0;

            // Tiempos Técnicos
            const washBase = parseFloat(mqTiempos.cambio_color_lavado_rod_tin_x_cuerpo) || 0;
            const prepBase = parseFloat(mqTiempos.preparado_de_tinta_x_cuerpo) || 0;
            const plateBase = parseFloat(mqTiempos.cambio_placa_por_cuerpo) || 0;
            const aprobacion = parseFloat(mqTiempos.aprobacion) || 0;
            const valorProm = parseFloat(mqTiempos.valor_prom) || 1;

            const timeWash = washBase * nColoresCiclo;
            const timePrep = prepBase * nColoresCiclo;
            const timePlate = (plateBase * nColoresCiclo) + aprobacion;
            const timeProd = (tirajes / valorProm) * 60;

            // Texto del ciclo para el bloque de producción
            const cycleLabel = `Ciclo ${c + 1}/${item.numCycles}`;
            const colorsLabel = `Colores actual: ${item.cycles[c]}`;

            // Bloques de Preparación (Solo para el primer producto de CADA ciclo)
            if (itemIdx === 0) {
              addBlock(timeWash, 'LAVADO DE RODILLOS Y TINTEROS', job, `${timeWash.toFixed(0)} min | ${colorsLabel}`, 'block-a-wash');
              addBlock(timePrep, 'PREPARADO DE PINTURA', job, `${timePrep.toFixed(0)} min | ${colorsLabel}`, 'block-a-prep');
            }

            // Bloque de Placa + Aprobación (Para todos los productos en cada ciclo)
            addBlock(timePlate, 'CAMBIO DE PLACA + APROBACIÓN', job, `${timePlate.toFixed(0)} min | ${nColoresCiclo} cuerpos`, 'block-b-placa');

            // Bloque de Producción (Se repite íntegro por ciclo)
            const detailsProd = `${cycleLabel} | Línea: ${job.linea || '-'} | Tirajes: ${tirajes}`;
            addBlock(timeProd, job.producto || 'Producción', job, detailsProd, 'block-c-prod', {
              cycleLabel: cycleLabel,
              currentCycle: c + 1,
              totalCycles: maxCycles,
              codigo_2: item.originalColors
            });

            // Registrar Fin de Impresión para este RMA
            const absFinish = (cursorDay * 1440) + cursorMin;
            const rKey = String(job.n).trim();
            if (!rmaFinishTracker[rKey] || absFinish > rmaFinishTracker[rKey]) {
              rmaFinishTracker[rKey] = absFinish;
            }

            // --- NUEVO: CAPTURAR EVENTO DE LIBERACIÓN POR CICLO ---
            releaseEvents.push({
              rma: rKey,
              ciclo: c + 1,
              maquina: machine,
              releaseTime: absFinish,
              troquel: job.n_troquel,
              colores: item.normalizedColors || []
            });
          });
        }
      });
    });
  });

  // Exponer eventos recolectados para fase de observación
  window.impresionReleaseEvents = releaseEvents;
};
