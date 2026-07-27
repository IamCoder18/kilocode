const SCRIPT = `
(() => {
  const out = {
    webdriver: !!navigator.webdriver,
    plugins: navigator.plugins ? navigator.plugins.length : 0,
    languages: navigator.languages ? Array.from(navigator.languages) : [navigator.language || ''],
    userAgent: navigator.userAgent,
    canvasHash: '',
    webglVendor: '',
    webglRenderer: '',
    headlessChrome: false,
    chromium: /chrome|chromium/i.test(navigator.userAgent)
  };
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.textBaseline = 'top';
      ctx.font = '14px Arial';
      ctx.fillStyle = '#f60';
      ctx.fillRect(125, 1, 62, 20);
      ctx.fillStyle = '#069';
      ctx.fillText('kilo-world', 2, 15);
      out.canvasHash = canvas.toDataURL().slice(0, 64);
    }
  } catch {}
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) {
        out.webglVendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) || '';
        out.webglRenderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '';
      }
    }
  } catch {}
  if (navigator.plugins && navigator.plugins.length === 0 && typeof window !== 'undefined' && !window.chrome) {
    out.headlessChrome = out.chromium;
  }
  return out;
})();
`

export const ANTI_DETECT = `
(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  const origQuery = window.navigator.permissions && window.navigator.permissions.query;
  if (origQuery) {
    window.navigator.permissions.query = (params) => {
      if (params && params.name === 'notifications') return Promise.resolve({ state: Notification.permission, onchange: null });
      return origQuery(params);
    };
  }
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true });
  const plugins = [
    { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Chrome PDF Viewer', filename: 'mhnbgjgfghfpdbnlgfkgmcbpfgjjdhhl', description: '' },
    { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
  ];
  Object.defineProperty(navigator, 'plugins', { get: () => plugins, configurable: true });
  const hasChrome = !!(window.chrome && (window.chrome.runtime || window.chrome.csi));
  Object.defineProperty(window, 'chrome', { get: () => (hasChrome ? window.chrome : { runtime: {}, csi: () => {}, loadTimes: () => ({}) }), configurable: true });
})();
`

void SCRIPT
