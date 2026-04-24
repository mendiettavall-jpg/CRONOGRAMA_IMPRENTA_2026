window.mkTimeFromMins = function mkTimeFromMins(min) {
  const total = min; // Ya viene en minutos absolutos desde las 00:00, siendo 480 las 08:00
  const h = Math.floor(total / 60);
  const m = Math.floor(total % 60);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
};

window.t2m = function t2m(t) {
  if (!t) return 0;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

window.fmtDate = function fmtDate() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Función pura compartida para distribuir duración en bloques de tiempo según turnos.
 */
window.allocateTimeBlocks = function allocateTimeBlocks(params) {
  let { 
    duration, 
    machine, 
    cursorDay, 
    cursorMin, 
    turnoInicio, 
    turnoFin, 
    scheduledBlocksObj, 
    type, 
    job, 
    details, 
    customClass, 
    extraData 
  } = params;

  if (duration <= 0) return { cursorDay, cursorMin };

  let remaining = duration;
  let iter = 0;
  
  while (remaining > 0 && iter < 100) {
    iter++;
    const availableInDay = turnoFin - cursorMin;
    const chunk = Math.min(remaining, availableInDay);
    
    if (!scheduledBlocksObj[machine][cursorDay]) {
      scheduledBlocksObj[machine][cursorDay] = [];
    }
    
    scheduledBlocksObj[machine][cursorDay].push({
      startMin: cursorMin,
      duration: chunk,
      type: type,
      job: job,
      details: details,
      cssClass: customClass || '',
      extraData: extraData || null
    });
    
    cursorMin += chunk;
    remaining -= chunk;
    
    if (cursorMin >= turnoFin && remaining > 0) {
      cursorDay++;
      cursorMin = turnoInicio;
    }
  }

  return { cursorDay, cursorMin };
};
