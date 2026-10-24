// Sponsor on the cars, bridges and boards. Ingenio by default; ?assurix (also ?brand=assurix or ?=assurix) shows Assurix.
// The textures come from tools/build_brand.py; aspect is width / height of each one.
const BRANDS = {
  ingenio: {
    id: 'ingenio', name: 'Ingenio Technologies', domain: 'ingeniotech.co.uk',
    navy: '#222E40', accent: '#DEDC00', white: '#FFFFFF', accent2: '#F8AB08', accentName: 'yellow',
    aspect: { domain: 7.0, domainPanel: 6.605, logo: 2.892, logoPanel: 2.819, lockup: 3.206, lockupPanel: 3.125, banner: 16, barrier: 12 }
  },
  assurix: {
    id: 'assurix', name: 'Assurix', domain: 'assurix.com',
    navy: '#111F46', accent: '#BED95C', white: '#FFFFFF', accent2: '#3DBB98', accentName: 'lime',
    aspect: { domain: 5.895, domainPanel: 5.536, logo: 3.585, logoPanel: 3.444, lockup: 2.678, lockupPanel: 2.638, banner: 16, barrier: 12 }
  }
};
const FILES = {
  domain: 'domain.png', domainPanel: 'domain-panel.png', logo: 'logo.png', logoPanel: 'logo-panel.png',
  lockup: 'lockup.png', lockupPanel: 'lockup-panel.png', banner: 'banner.png', barrier: 'barrier.png'
};

function chosen() {
  try {
    const q = new URLSearchParams(location.search);
    // "?=assurix" reads as an empty key with the value "assurix"
    const want = (q.get('brand') || q.get('') || '').toLowerCase();
    if (BRANDS[want]) return want;
    for (const k of q.keys()) if (BRANDS[k.toLowerCase()]) return k.toLowerCase();
  } catch { /* no location outside the browser */ }
  return 'ingenio';
}

export const BRAND = BRANDS[chosen()];

const textures = {};
// three.js loads here rather than at the top, so cars.js (and the Node tests) can read the palette without it
export async function loadBrand() {
  const THREE = await import('three/webgpu');
  const loader = new THREE.TextureLoader();
  await Promise.all(Object.entries(FILES).map(async ([k, file]) => {
    try {
      const t = await loader.loadAsync(`brand/${BRAND.id}/${file}`);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
      if (k === 'barrier') t.wrapS = THREE.RepeatWrapping;
      textures[k] = t;
    } catch (err) {
      console.warn('Brand texture missing', file, err);
    }
  }));
}

export const brandTexture = (k) => textures[k] || null;
