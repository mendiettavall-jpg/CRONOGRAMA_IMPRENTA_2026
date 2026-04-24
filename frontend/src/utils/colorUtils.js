window.getColorByRMA = function getColorByRMA(rma) {
  return window.getColorInfoByRMA(rma).bg;
};

window.getHash = function getHash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
  }
  return Math.abs(hash);
};

window.EXEC_PALETTE_HSL = [
  [210, 55, 52], [120, 45, 50], [15, 60, 55],  [215, 30, 50], [281, 45, 52],
  [180, 50, 48], [38, 65, 58],  [243, 50, 54], [200, 60, 56], [342, 60, 58],
  [84, 45, 48],  [210, 25, 55], [263, 40, 56], [10, 65, 60],  [160, 50, 52],
  [50, 40, 55],  [250, 45, 60], [20, 70, 62],  [190, 65, 50], [30, 30, 50]
];

window.getColorInfoByRMA = function getColorInfoByRMA(rma) {
  const s = String(rma || '').trim();
  if (!s) return { bg: '#f3f4f6', text: '#374151' };

  const hash = window.getHash(s);
  const baseIdx = hash % window.EXEC_PALETTE_HSL.length;
  const base = window.EXEC_PALETTE_HSL[baseIdx];

  // Variation: 0: normal, 1: -6% Lightness, 2: +6% Lightness
  const variant = Math.floor(hash / window.EXEC_PALETTE_HSL.length) % 3;
  
  let [h, sat, lum] = base;

  if (variant === 1) { // Lighter
    lum = Math.min(65, lum + 6);
  } else if (variant === 2) { // Darker
    lum = Math.max(35, lum - 6);
  }

  // PROTECTION: Avoid being exactly on the 55-57% threshold
  if (lum >= 55 && lum <= 57) {
    lum = (variant === 1) ? 58 : 54;
  }

  const bg = `hsl(${h}, ${sat}%, ${lum}%)`;
  const text = (lum >= 56) ? '#111827' : '#ffffff'; // Contrast validation

  return { bg, text };
};

window.normalizeColors = function normalizeColors(s) {
  if (!s || typeof s !== 'string') return '';
  return Array.from(s.replace(/\s+/g, '').toUpperCase()).sort().join('');
};

window.isValidColorCode = function isValidColorCode(s) {
  if (!s || typeof s !== 'string') return false;
  const clean = s.trim();
  return clean !== '' && clean !== '-';
};

window.getColorsPerCycle = function getColorsPerCycle(colors, bodies) {
  if (!colors) return [];
  const chars = Array.from(colors.replace(/\s+/g, '').toUpperCase());
  const cycles = [];
  for (let i = 0; i < chars.length; i += bodies) {
    cycles.push(chars.slice(i, i + bodies).join(''));
  }
  return cycles;
};
