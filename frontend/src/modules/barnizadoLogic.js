/**
 * Asigna los bloques de tiempo en el cronograma para la etapa de Barnizado.
 * 
 * @param {Array} rmaSessionList - Lista de trabajos cargados.
 * @param {Object} rmaFinishTracker - Objeto con los minutos absolutos en que cada RMA se libera de Impresión.
 * @param {Array} tiemposData - Datos técnicos de tiempos de máquina.
 * @param {Object} scheduledBlocks - Objeto mutado in-place donde se guardan los bloques en el cronograma.
 * @param {Number} turnoInicio - Inicio de turno en minutos (ej. 480).
 * @param {Number} turnoFin - Fin de turno en minutos (ej. 1050).
 * 
 * @returns {Object} barnizadoJobFinishTracker - Tracker con los minutos absolutos de finalización de cada RMA post-barnizado.
 */
window.scheduleBarnizadoStage = function scheduleBarnizadoStage(
  rmaSessionList,
  rmaFinishTracker,
  tiemposData,
  scheduledBlocks,
  turnoInicio,
  turnoFin
) {
  // --- ETAPA 2: BARNIZADO (Motor de Optimización por Troquel) ---
  const machinesBarnizado = ['KORD 2', 'KORD 3'];
  const barnizadoTrackers = {};
  const barnizadoJobFinishTracker = {}; // { [rma]: absMin }
  machinesBarnizado.forEach(m => {
    barnizadoTrackers[m] = { day: 0, min: turnoInicio, lastTroquel: null };
  });

  console.log('[DEBUG-BALANCER] DISPONIBILIDAD INICIAL:', JSON.stringify(barnizadoTrackers));

  // Cola de trabajo (referencia a objetos originales con metadatos de liberación)
  let pendingBarnizado = rmaSessionList
    .map((job, idx) => ({
      job: job,
      originalIndex: idx,
      liberationTime: rmaFinishTracker[String(job.n)]
    }))
    .filter(item => item.liberationTime !== undefined);

  let barnizadoIteration = 0;
  while (pendingBarnizado.length > 0 && barnizadoIteration < 500) {
    barnizadoIteration++;

    // 1. Encontrar la máquina que se libera antes
    let targetMachine = 'KORD 2';
    let minAvailAbs = Infinity;
    machinesBarnizado.forEach(m => {
      const t = barnizadoTrackers[m];
      const abs = (t.day * 1440) + t.min;
      if (abs < minAvailAbs) {
        minAvailAbs = abs;
        targetMachine = m;
      }
    });

    const tracker = barnizadoTrackers[targetMachine];
    const machineAvail = (tracker.day * 1440) + tracker.min;

    // 2. Buscar en tiemposData los parámetros de esta máquina
    const mqTiempos = tiemposData.find(t => {
      const maqt = (t.maquina || '').toUpperCase().replace(/\s|-/g, '');
      const mac = targetMachine.toUpperCase().replace(/\s|-/g, '');
      return maqt === mac;
    }) || {};

    if (!mqTiempos || Object.keys(mqTiempos).length === 0) break;

    const baseCambio = parseFloat(mqTiempos.cambio_formato) || 0;
    const valorProm = Number(mqTiempos.valor_prom) || 1;

    // 3. Evaluar cada RMA pendiente para esta máquina específica
    let bestScore = Infinity;
    let winnerIdx = -1;
    let bestWait = 0;
    let bestSetup = 0;

    pendingBarnizado.forEach((cand, idx) => {
      const wait = Math.max(0, cand.liberationTime - machineAvail);

      // Optimización por Troquel: si coincide el troquel, el cambio es 0
      const setup = (String(cand.job.n_troquel).trim() === String(tracker.lastTroquel).trim() && tracker.lastTroquel !== null) ? 0 : baseCambio;

      const score = wait + setup;

      if (score < bestScore) {
        bestScore = score;
        winnerIdx = idx;
        bestWait = wait;
        bestSetup = setup;
      }
    });

    if (winnerIdx === -1) break;

    const item = pendingBarnizado.splice(winnerIdx, 1)[0];
    const job = item.job;
    const liberationTime = item.liberationTime;

    console.log(`[DEBUG-TROQUEL] Máquina: ${targetMachine} | lastTroquel: ${tracker.lastTroquel} | Ganador: RMA ${job.n} (Troquel: ${job.n_troquel}) | Espera: ${bestWait}m | Cambio: ${bestSetup}m | Score: ${bestScore}`);

    // 4. Asignar Bloques (Cambio y Producción)
    let cursorDay = Math.floor(Math.max(liberationTime, machineAvail) / 1440);
    let cursorMin = Math.max(liberationTime, machineAvail) % 1440;
    const machine = targetMachine;

    function addBlockBarnizado(duration, type, job, details, customClass, extraData = null) {
      const startDayLog = cursorDay;
      const startMinLog = cursorMin;
      const res = window.allocateTimeBlocks({
        duration, machine, cursorDay, cursorMin, 
        turnoInicio: turnoInicio, turnoFin: turnoFin,
        scheduledBlocksObj: scheduledBlocks, 
        type, job, details, customClass, extraData
      });
      cursorDay = res.cursorDay;
      cursorMin = res.cursorMin;
      console.log(`[DEBUG-BARNIZADO] INSERCIÓN: ${machine} | Tipo: ${type} | RMA: ${job.n} | Inicio: D${startDayLog} ${window.mkTimeFromMins(startMinLog)} | Fin: D${cursorDay} ${window.mkTimeFromMins(cursorMin)} | Dur: ${Math.round(duration)} min`);
    }

    if (bestSetup > 0) {
      addBlockBarnizado(bestSetup, 'CAMBIO DE FORMATO', job, 'Cambio de Formato Barnizado', 'block-c-formato');
    }

    const tj = Number(job.tirajes) || 0;
    const durProd = Math.ceil((tj / valorProm) * 60);

    if (durProd > 0) {
      addBlockBarnizado(durProd, job.producto || 'Barnizado', job, `Barnizado - ${job.producto}`, 'block-c-prod', { isBarnizado: true });
      console.log('[OK BARNIZADO]', { rma: job.n, valor_prom: valorProm, tirajes: tj, duracion: durProd });
    }

    tracker.day = cursorDay;
    tracker.min = cursorMin;
    tracker.lastTroquel = job.n_troquel;

    // Registrar Fin de Barnizado para este RMA
    barnizadoJobFinishTracker[String(job.n).trim()] = (cursorDay * 1440) + cursorMin;
  }

  return barnizadoJobFinishTracker;
};

/**
 * Asigna los bloques de tiempo en el cronograma para Barnizado en modo "Streaming" (por ciclo).
 * 
 * @param {Array} rmaSessionList - Lista de trabajos cargados.
 * @param {Array} releaseEvents - Lista de eventos generados por Impresión (1 por ciclo).
 * @param {Array} tiemposData - Datos técnicos.
 * @param {Object} scheduledBlocks - Objeto mutado in-place.
 * @param {Number} turnoInicio - Inicio de turno en minutos.
 * @param {Number} turnoFin - Fin de turno en minutos.
 * 
 * @returns {Object} barnizadoStreamingFinishTracker - Tracker de finalización.
 */
window.scheduleBarnizadoStreamingStage = function scheduleBarnizadoStreamingStage(
  rmaSessionList,
  releaseEvents,
  tiemposData,
  scheduledBlocks,
  turnoInicio,
  turnoFin
) {
  const machinesBarnizado = ['KORD 2', 'KORD 3'];
  const barnizadoTrackers = {};
  window.barnizadoStreamingFinishTracker = window.barnizadoStreamingFinishTracker || {};
  const finishTracker = window.barnizadoStreamingFinishTracker;

  for (let m = 0; m < machinesBarnizado.length; m++) {
    barnizadoTrackers[machinesBarnizado[m]] = { day: 0, min: turnoInicio, lastTroquel: null };
  }

  // Construir pendingBarnizado con un for normal
  let pendingBarnizado = [];
  
  console.log('[STREAM DEBUG] releaseEvents:', releaseEvents);
  console.log('[STREAM DEBUG] rmaSessionList:', rmaSessionList);

  for (let i = 0; i < releaseEvents.length; i++) {
    const event = releaseEvents[i];
    const eventKey = String(event.rma || '').trim().replace(/^0+/, '');
    let job = null;
    
    // Buscar job con for normal
    for (let j = 0; j < rmaSessionList.length; j++) {
      const rKey = String(rmaSessionList[j].n || '').trim().replace(/^0+/, '');
      if (rKey === eventKey) {
        job = rmaSessionList[j];
        break;
      }
    }

    console.log('[STREAM DEBUG] eventKey:', eventKey, 'job encontrado:', !!job);

    if (job) {
      pendingBarnizado.push({
        job: job,
        event: event,
        originalIndex: i,
        liberationTime: event.releaseTime
      });
    } else {
      console.warn('[STREAM DEBUG] No se encontró job para event.rma:', event.rma);
    }
  }

  console.log('[STREAM DEBUG] pendingBarnizado length:', pendingBarnizado.length);

  let barnizadoIteration = 0;
  while (pendingBarnizado.length > 0 && barnizadoIteration < 1500) { 
    barnizadoIteration++;
    console.log('[STREAM DEBUG] entrando al loop principal, iteracion:', barnizadoIteration);

    // 1. Encontrar la máquina que se libera antes
    let targetMachine = 'KORD 2';
    let minAvailAbs = Infinity;
    for (let m = 0; m < machinesBarnizado.length; m++) {
      const mac = machinesBarnizado[m];
      const t = barnizadoTrackers[mac];
      const abs = (t.day * 1440) + t.min;
      if (abs < minAvailAbs) {
        minAvailAbs = abs;
        targetMachine = mac;
      }
    }

    const tracker = barnizadoTrackers[targetMachine];
    const machineAvail = (tracker.day * 1440) + tracker.min;

    // 2. Buscar en tiemposData los parámetros de esta máquina
    let mqTiempos = {};
    for (let t = 0; t < tiemposData.length; t++) {
      const maqt = (tiemposData[t].maquina || '').toUpperCase().replace(/\s|-/g, '');
      const mac = targetMachine.toUpperCase().replace(/\s|-/g, '');
      if (maqt === mac) {
        mqTiempos = tiemposData[t];
        break;
      }
    }

    if (!mqTiempos || Object.keys(mqTiempos).length === 0) {
      console.warn("[STREAM DEBUG] mqTiempos vacío o no encontrado para máquina:", targetMachine, "tiemposData length:", tiemposData.length, "ROMPIENDO BUCLE PRINCIPAL");
      break;
    }

    const baseCambio = parseFloat(mqTiempos.cambio_formato) || 0;
    const valorProm = Number(mqTiempos.valor_prom) || 1;

    // 3. Evaluar cada RMA pendiente para esta máquina específica
    let bestScore = Infinity;
    let winnerIdx = -1;
    let bestWait = 0;
    let bestSetup = 0;

    console.log("[STREAM DEBUG] pendingBarnizado antes del for:", pendingBarnizado);

    for (let idx = 0; idx < pendingBarnizado.length; idx++) {
      console.log("[STREAM DEBUG] entrando al for, index:", idx);
      const cand = pendingBarnizado[idx];
      
      console.log("[STREAM DEBUG] evaluando candidato:", {
        rma: cand.job.n,
        liberationTime: cand.liberationTime,
        machineAvail: machineAvail
      });

      const wait = Math.max(0, cand.liberationTime - machineAvail);

      // Optimización por Troquel: si coincide el troquel, el cambio es 0
      const setup = (String(cand.job.n_troquel).trim() === String(tracker.lastTroquel).trim() && tracker.lastTroquel !== null) ? 0 : baseCambio;

      const score = wait + setup;

      console.log("[STREAM DEBUG] score calc:", {
        wait: wait,
        setup: setup,
        score: score
      });

      if (score < bestScore) {
        console.log("[STREAM DEBUG] nuevo mejor candidato:", cand.job.n);
        bestScore = score;
        winnerIdx = idx;
        bestWait = wait;
        bestSetup = setup;
      }
    }

    console.log("[STREAM DEBUG] bestCandidate final:", winnerIdx !== -1 ? pendingBarnizado[winnerIdx].job.n : null);

    if (winnerIdx === -1) {
      console.error("[STREAM ERROR] No se encontró candidato válido en esta iteración");
      break;
    }

    const item = pendingBarnizado.splice(winnerIdx, 1)[0];
    const job = item.job;
    const event = item.event;
    const liberationTime = item.liberationTime;

    // 4. Asignar Bloques (Cambio y Producción)
    const startTimeAbs = Math.max(machineAvail, liberationTime);
    let cursorDay = Math.floor(startTimeAbs / 1440);
    let cursorMin = startTimeAbs % 1440;
    const machine = targetMachine;

    function addBlockBarnizado(duration, type, job, details, customClass, extraData = null) {
      const res = window.allocateTimeBlocks({
        duration, machine, cursorDay, cursorMin, 
        turnoInicio: turnoInicio, turnoFin: turnoFin,
        scheduledBlocksObj: scheduledBlocks, 
        type, job, details, customClass, extraData
      });
      cursorDay = res.cursorDay;
      cursorMin = res.cursorMin;
    }

    if (bestSetup > 0) {
      addBlockBarnizado(bestSetup, 'CAMBIO DE FORMATO', job, 'Cambio de Formato Barnizado', 'block-c-formato');
    }

    const tj = Number(job.tirajes) || 0;
    
    console.log("[STREAM DEBUG] tj:", tj);
    console.log("[STREAM DEBUG] valorProm:", valorProm);

    if (!valorProm) {
      console.log("[STREAM DEBUG] mqTiempos:", mqTiempos);
    }

    if (!tj || !valorProm) {
      console.warn("[STREAM ERROR] Datos inválidos:", { tj, valorProm, job });
      continue;
    }

    const durProd = Math.ceil((tj / valorProm) * 60);
    console.log('[STREAM DEBUG] durProd calculada:', durProd, 'tj:', tj, 'valorProm:', valorProm);

    if (durProd > 0) {
      const prodName = job.producto || 'Barnizado';
      addBlockBarnizado(durProd, prodName, job, `Barnizado (Ciclo ${event.ciclo}) - ${prodName}`, 'block-c-prod', { isBarnizado: true, ciclo: event.ciclo });
    } else {
      console.log('[STREAM DEBUG] forzando bloque TEST por durProd <= 0');
      addBlockBarnizado(15, 'TEST', job, 'TEST STREAM', 'block-c-prod');
    }

    tracker.day = cursorDay;
    tracker.min = cursorMin;
    tracker.lastTroquel = job.n_troquel;

    // Registrar Fin de Barnizado 
    const absFinish = (cursorDay * 1440) + cursorMin;
    const rKey = String(job.n).trim();
    if (!finishTracker[rKey] || absFinish > finishTracker[rKey]) {
      finishTracker[rKey] = absFinish;
    }
  }

  return finishTracker;
};

/**
 * Función de prueba para validar el modo streaming sin afectar el cronograma visual.
 * Se ejecuta por consola manualmente mediante: window.testBarnizadoStreaming()
 */
window.testBarnizadoStreaming = function() {
  if (!window.impresionReleaseEvents || window.impresionReleaseEvents.length === 0) {
    console.warn("No hay impresionReleaseEvents disponibles. Genera el cronograma general primero.");
    return;
  }

  // Estructura limpia e independiente para simular
  const testBlocks = {};
  ['KORD 2', 'KORD 3'].forEach(m => testBlocks[m] = {});

  // Limpiar tracker de la prueba anterior
  window.barnizadoStreamingFinishTracker = {};
  const startTestTime = performance.now();

  const sessionList = typeof rmaSessionList !== 'undefined' ? rmaSessionList : (window.rmaSessionListDebug || []);

  if (!sessionList || sessionList.length === 0) {
    console.warn("[STREAM DEBUG] rmaSessionList está vacío o no se pudo acceder. Usa window.rmaSessionListDebug = rmaSessionList; en consola.");
    return;
  }

  const tData = window.DATA?.tiempos?.rows || [];
  console.log("[STREAM DEBUG] tiemposData length:", tData.length);
  
  if (tData.length === 0) {
    console.error("[STREAM ERROR] DATA.tiempos no disponible o vacío");
  }

  const resultTracker = window.scheduleBarnizadoStreamingStage(
    sessionList,
    window.impresionReleaseEvents,
    tData,
    testBlocks,
    typeof TURNO_INICIO !== 'undefined' ? TURNO_INICIO : 480,
    typeof TURNO_FIN !== 'undefined' ? TURNO_FIN : 1050
  );

  const endTestTime = performance.now();

  const numEvents = window.impresionReleaseEvents.length;
  let numBlocks = 0;
  let firstBlockStreaming = Infinity;

  ['KORD 2', 'KORD 3'].forEach(m => {
    const days = Object.keys(testBlocks[m]);
    days.forEach(d => {
      const dayBlocks = testBlocks[m][d];
      numBlocks += dayBlocks.length;
      if (dayBlocks.length > 0) {
        const first = dayBlocks[0];
        const absStart = (Number(d) * 1440) + first.startMin;
        if (absStart < firstBlockStreaming) firstBlockStreaming = absStart;
      }
    });
  });

  let firstBlockClassic = Infinity;
  if (window.scheduledBlocks) {
    ['KORD 2', 'KORD 3'].forEach(m => {
      const days = Object.keys(window.scheduledBlocks[m] || {});
      days.forEach(d => {
        const dayBlocks = window.scheduledBlocks[m][d];
        if (dayBlocks && dayBlocks.length > 0) {
          const first = dayBlocks[0];
          const absStart = (Number(d) * 1440) + first.startMin;
          if (absStart < firstBlockClassic) firstBlockClassic = absStart;
        }
      });
    });
  }

  console.log("=== REPORTE DE PRUEBA: BARNIZADO STREAMING ===");
  console.log(`Eventos de Impresión (Ciclos): ${numEvents}`);
  console.log(`Bloques de Barnizado generados: ${numBlocks}`);
  console.log(`Primer inicio Barnizado Clásico (AbsMin): ${firstBlockClassic === Infinity ? 'N/A' : firstBlockClassic}`);
  console.log(`Primer inicio Barnizado Streaming (AbsMin): ${firstBlockStreaming === Infinity ? 'N/A' : firstBlockStreaming}`);
  console.log(`Diferencia de inicio: ${firstBlockClassic !== Infinity && firstBlockStreaming !== Infinity ? (firstBlockClassic - firstBlockStreaming) + ' minutos de ganancia (' + ((firstBlockClassic - firstBlockStreaming) / 60).toFixed(1) + ' hrs)' : 'N/A'}`);
  console.log(`Tiempo de cálculo: ${(endTestTime - startTestTime).toFixed(2)} ms`);

  return {
    scheduledBlocksTest: testBlocks,
    finishTracker: resultTracker,
    eventosProcesados: numEvents
  };
};
