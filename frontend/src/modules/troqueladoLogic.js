/**
 * Evalúa a un candidato para la etapa de troquelado calculando su puntaje en base al tiempo de espera y cambio de formato.
 * 
 * @param {Object} cand - El objeto candidato de la cola de pendientes.
 * @param {Number} machineAvail - Minuto absoluto en el que la máquina troqueladora estará libre.
 * @param {String|null} trackerLastTroquel - El identificador del último troquel configurado en la máquina.
 * @param {Object} troquelGlobalTracker - Diccionario con los tiempos de liberación de cada troquel físico.
 * @param {Number} mqCambioTroquel - Tiempo (en minutos) que tarda la máquina en hacer un cambio de troquel.
 * @param {Number} barnizadoFinish - Minuto absoluto en el que el candidato terminó la etapa de barnizado.
 * 
 * @returns {Object} { wait, setup, score, isSameTroquel, tKey }
 */
window.evaluateTroqueladoCandidate = function evaluateTroqueladoCandidate(cand, machineAvail, trackerLastTroquel, troquelGlobalTracker, mqCambioTroquel, barnizadoFinish) {
  const tKey = window.getCleanTroquelKey(cand.job.n_troquel);
  const troquelAvail = tKey ? (troquelGlobalTracker[tKey] || 0) : 0;
  
  // Scoring en troquelado (espera)
  // La espera máxima entre: la máquina, la pieza de barnizado, o el troquel físico
  const wait = Math.max(0, barnizadoFinish - machineAvail, troquelAvail - machineAvail);
  
  // Control de disponibilidad de troquel (cambio)
  const isSameTroquel = String(cand.job.n_troquel).trim() === String(trackerLastTroquel).trim() && trackerLastTroquel !== null;
  const setup = isSameTroquel ? 0 : (parseFloat(mqCambioTroquel) || 0);
  
  return { wait, setup, score: wait + setup, isSameTroquel, tKey };
};

/**
 * Asigna los bloques de tiempo en el cronograma para la etapa de Troquelado.
 * 
 * @param {Array} rmaSessionList - Lista de trabajos de la sesión actual.
 * @param {Object} barnizadoJobFinishTracker - Tracker encadenado con los minutos de liberación de cada RMA post-barnizado.
 * @param {Array} tiemposData - Datos técnicos de tiempos de máquina.
 * @param {Object} scheduledBlocks - Objeto global mutado in-place donde se guardan los bloques en el cronograma.
 * @param {Number} turnoInicio - Inicio de turno en minutos (ej. 480).
 * @param {Number} turnoFin - Fin de turno en minutos (ej. 1050).
 */
window.scheduleTroqueladoStage = function scheduleTroqueladoStage(
  rmaSessionList,
  barnizadoJobFinishTracker,
  tiemposData,
  scheduledBlocks,
  turnoInicio,
  turnoFin
) {
  // --- ETAPA 3: TROQUELADO (Motor de Optimización por Troquel y Recursos Globales) ---
  const machinesTroquelado = ['TROQUELADORA 57', 'TROQUELADORA 72', 'TROQUELADORA 77', 'TROQUELADORA MERCEDES'];
  const troqueladoTrackers = {};
  const troquelGlobalTracker = {}; // { [n_troquel]: absMinFree }

  machinesTroquelado.forEach(m => {
    troqueladoTrackers[m] = { day: 0, min: turnoInicio, lastTroquel: null };
  });

  console.log('FASE 3: Empezando etapa de Troquelado. RMAs con fin de barnizado:', Object.keys(barnizadoJobFinishTracker));

  let pendingTroquelado = rmaSessionList
    .filter(rma => {
      const ut = parseFloat(rma.un_tiraje);
      const isValid = !isNaN(ut) && ut > 0;
      if (!isValid) console.warn("[TROQUELADO] RMA omitido por UN/TIRAJE inválido", { rma: rma.n, UN_TIRAJE: rma.un_tiraje });
      return isValid;
    })
    .map((job, idx) => ({
      job: job,
      originalIndex: idx,
      barnizadoFinish: barnizadoJobFinishTracker[String(job.n).trim()] || 0
    }));

  let troqueladoIteration = 0;
  while (pendingTroquelado.length > 0 && troqueladoIteration < 500) {
    troqueladoIteration++;

    // 1. Encontrar la máquina que se libera antes
    let targetMachine = null;
    let minAvailAbs = Infinity;
    machinesTroquelado.forEach(m => {
      const t = troqueladoTrackers[m];
      const abs = (t.day * 1440) + t.min;
      if (abs < minAvailAbs) {
        minAvailAbs = abs;
        targetMachine = m;
      }
    });

    if (!targetMachine) break;
    const tracker = troqueladoTrackers[targetMachine];
    const machineAvail = (tracker.day * 1440) + tracker.min;

    // 2. Buscar en tiemposData los parámetros de esta máquina (Match Exacto)
    const mqTiempos = tiemposData.find(t => {
      return (t.maquina || '').toUpperCase().trim() === targetMachine.toUpperCase().trim();
    });

    if (!mqTiempos) {
      console.error(`[TROQUELADO] No se encontraron tiempos para la máquina: ${targetMachine}`);
      troqueladoTrackers[targetMachine].min = turnoFin;
      continue;
    }

    // 3. Evaluar cada RMA pendiente para esta máquina con jerarquía de desempate
    let bestScore = Infinity;
    let winnerIdx = -1;
    let winnerEval = null;

    pendingTroquelado.forEach((cand, idx) => {
      const evalResult = window.evaluateTroqueladoCandidate(cand, machineAvail, tracker.lastTroquel, troquelGlobalTracker, mqTiempos.cambio_troquel, cand.barnizadoFinish);
      const score = evalResult.score;

      if (score < bestScore) {
        bestScore = score;
        winnerIdx = idx;
        winnerEval = evalResult;
      } else if (score === bestScore && winnerIdx !== -1) {
        // Desempate 1: Priorizar mismo troquel
        const winnerIsSame = winnerEval.isSameTroquel;
        const candIsSame = evalResult.isSameTroquel;

        if (candIsSame && !winnerIsSame) {
          winnerIdx = idx;
          winnerEval = evalResult;
        } else if (candIsSame === winnerIsSame) {
          // Desempate 2: FIFO (Orden original)
          if (cand.originalIndex < pendingTroquelado[winnerIdx].originalIndex) {
            winnerIdx = idx;
            winnerEval = evalResult;
          }
        }
      }
    });

    if (winnerIdx === -1) break;

    const item = pendingTroquelado.splice(winnerIdx, 1)[0];
    const job = item.job;
    const tKey = winnerEval.tKey;
    const troquelAvail = tKey ? (troquelGlobalTracker[tKey] || 0) : 0;

    // 4. Asignar Bloques - FÓRMULA EXACTA: Math.max(machineAvail, barnizadoFinish, troquelAvail)
    const startTimeAbs = Math.max(machineAvail, item.barnizadoFinish, troquelAvail);
    let cursorDay = Math.floor(startTimeAbs / 1440);
    let cursorMin = startTimeAbs % 1440;
    const machine = targetMachine;

    function addBlockTroquel(duration, type, job, details, customClass, extraData = null) {
      const res = window.allocateTimeBlocks({
        duration, machine, cursorDay, cursorMin, 
        turnoInicio: turnoInicio, turnoFin: turnoFin,
        scheduledBlocksObj: scheduledBlocks, 
        type, job, details, customClass, extraData
      });
      cursorDay = res.cursorDay;
      cursorMin = res.cursorMin;
    }

    // Tiempos Técnicos
    const isSameTroquel = String(job.n_troquel).trim() === String(tracker.lastTroquel).trim() && tracker.lastTroquel !== null;
    const tCambio = isSameTroquel ? 0 : (parseFloat(mqTiempos.cambio_troquel) || 0);
    const tRegulado = parseFloat(mqTiempos.regulado_troquel) || 0;
    const tAprob = parseFloat(mqTiempos.aprobacion) || 0;
    const ut = parseFloat(job.un_tiraje) || 0;

    let tRegEsp = 0;
    let isMissingRegEsp = false;
    if (ut >= 6) {
      tRegEsp = parseFloat(mqTiempos.regulado_especial) || 0;
      if (tRegEsp === 0) isMissingRegEsp = true;
    }

    const vProm = parseFloat(mqTiempos.valor_prom) || 1;
    const tj = parseFloat(job.tirajes) || 0;
    const tProd = Math.ceil((tj / vProm) * 60);

    // Ejecutar Secuencia Técnica (Troquel bloqueado desde el inicio de la secuencia)
    if (tCambio > 0) addBlockTroquel(tCambio, 'CAMBIO DE TROQUEL', job, 'Preparación', 'block-troq-setup');
    addBlockTroquel(tRegulado, 'REGULADO TROQUEL', job, 'Regulado', 'block-troq-setup');
    addBlockTroquel(tAprob, 'APROBACIÓN', job, 'Aprobación', 'block-troq-setup');

    if (ut >= 6) {
      if (isMissingRegEsp) {
        addBlockTroquel(5, '[!] FALTA TIEMPO REGULADO ESPECIAL', job, `RMA: ${job.n} | MAQUINA: ${machine}`, 'block-error-data');
      } else {
        addBlockTroquel(tRegEsp, 'REGULADO ESPECIAL', job, 'Regulado Especial', 'block-troq-setup');
      }
    }

    if (tProd > 0) {
      addBlockTroquel(tProd, job.producto || 'Troquelado', job, `Tirajes: ${job.tirajes} | UN/TIRAJE: ${job.un_tiraje}`, 'block-c-prod', { isTroquelado: true });
    }

    // Actualizar trackers
    const absFinish = (cursorDay * 1440) + cursorMin;
    tracker.day = cursorDay;
    tracker.min = cursorMin;
    tracker.lastTroquel = job.n_troquel;

    // Bloqueo exclusivo: el troquel queda liberado SOLO después de fin de producción
    if (tKey) {
      troquelGlobalTracker[tKey] = absFinish;
    }
  }
};
