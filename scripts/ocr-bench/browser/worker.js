import { init, ocrPage } from './ppocr.js';
let ready;
self.onmessage = async e => {
  const { type, base, threads, url } = e.data;
  try {
    if (type === 'init') { ready = init(base, { threads }); await ready; self.postMessage({ type: 'ready' }); return; }
    await ready;
    const bmp = await createImageBitmap(await (await fetch(url)).blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
    const r = await ocrPage({ w: bmp.width, h: bmp.height, d });
    self.postMessage({ type: 'done', url, ...r });
  } catch (err) { self.postMessage({ type: 'error', url, msg: String(err && err.stack || err) }); }
};
