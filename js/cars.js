// Car line-up: physics, engine sound and look for each choice in the picker.
// Power in watts, mass in kg (car + driver + some fuel), aero areas in m².

const MODERN = {
  era: 'modern', eraLabel: '2026 rules',
  mass: 800, wheelbase: 3.4, wheelRadius: 0.355,
  powerIce: 400000, powerElectric: 350000, electricFade: [290, 355], boostFade: [320, 372],
  CdA: 1.32, CdAStraight: 1.02, ClA: 3.3, ClAStraight: 2.0,
  mu: 1.72, muBrake: 1.8, brakeMax: 52000, crr: 0.012,
  gears: [3.0, 2.38, 1.96, 1.67, 1.45, 1.28, 1.15, 1.04], final: 4.5,
  engine: { type: 'v6', cylinders: 6, idle: 4200, redline: 12400, shift: 11800, turbo: true, hybrid: true },
  model: { halo: true, wheelCovers: true, rimRadius: 0.23, tyreWidthF: 0.28, tyreWidthR: 0.36, length: 5.4, width: 1.9 },
  specLine: 'V6 turbo hybrid · 1,000 hp · 800 kg'
};

const V10 = {
  era: 'v10', eraLabel: '2005 rules',
  mass: 640, wheelbase: 3.1, wheelRadius: 0.33,
  powerIce: 680000, powerElectric: 0,
  CdA: 1.28, ClA: 3.9,
  mu: 1.62, muBrake: 1.75, brakeMax: 46000, crr: 0.012,
  gears: [3.05, 2.4, 1.98, 1.68, 1.46, 1.29, 1.15], final: 5.75,
  engine: { type: 'v10', cylinders: 10, idle: 4600, redline: 19200, shift: 18600, turbo: false, hybrid: false },
  model: { halo: false, wheelCovers: false, rimRadius: 0.165, tyreWidthF: 0.27, tyreWidthR: 0.34, length: 4.6, width: 1.8 },
  specLine: '3.0 V10 · 920 hp · 640 kg'
};

const CLASSIC = {
  era: 'classic', eraLabel: '1967',
  mass: 560, wheelbase: 2.42, wheelRadius: 0.305,
  powerIce: 300000, powerElectric: 0,
  CdA: 0.78, ClA: -0.15,
  mu: 1.22, muBrake: 1.15, brakeMax: 15000, crr: 0.015,
  gears: [2.6, 1.95, 1.55, 1.27, 1.08], final: 3.6,
  engine: { type: 'v8', cylinders: 8, idle: 2900, redline: 10500, shift: 10000, turbo: false, hybrid: false },
  model: { halo: false, wheelCovers: false, rimRadius: 0.19, tyreWidthF: 0.22, tyreWidthR: 0.3, length: 3.9, width: 1.6 },
  specLine: '3.0 V8 · 410 hp · 560 kg'
};

// Liveries: base, accent, third colour and a pattern the shader understands
export const CARS = [
  { id: 'kigali', name: 'Kigali', ...MODERN, livery: { base: '#00a1de', accent: '#fad201', third: '#20603d', pattern: 'flag', number: 26 },
    blurb: 'Sky blue, sun yellow and hill green.' },
  { id: 'imigongo', name: 'Imigongo', ...MODERN, livery: { base: '#f3eee6', accent: '#141414', third: '#a3462b', pattern: 'zigzag', number: 7 },
    blurb: 'Black, white and clay red, after Rwandan Imigongo art.' },
  { id: 'nyiragongo', name: 'Volcano', ...MODERN, livery: { base: '#111214', accent: '#ff4b14', third: '#ffb000', pattern: 'lava', number: 33 },
    blurb: 'Matt black with molten orange.' },
  { id: 'kivu', name: 'Kivu', ...MODERN, livery: { base: '#0c2a4a', accent: '#e8c46a', third: '#3fc4c9', pattern: 'wave', number: 12 },
    blurb: 'Deep lake blue with gold.' },
  { id: 'v10', name: 'Scream', ...V10, livery: { base: '#c8102e', accent: '#ffffff', third: '#111111', pattern: 'classic', number: 1 },
    blurb: '19,000 rpm, no halo, grooved tyres.' },
  { id: 'classic', name: 'Heritage', ...CLASSIC, livery: { base: '#0f4d2c', accent: '#f2c100', third: '#e8e2d0', pattern: 'band', number: 5 },
    blurb: 'No wings, skinny tyres, a lot of courage.' }
];

export const RHO = 1.04; // air density at about 1,390 m, kg/m³
export const G = 9.81;
