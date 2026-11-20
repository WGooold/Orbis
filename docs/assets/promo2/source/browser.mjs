import { chromium } from 'playwright';

// npm ci && npx playwright install chromium && npm run render
// Use CHROME_PATH to render with a particular Chrome installation.
export const launchBrowser = () => chromium.launch({
  headless: true,
  ...(process.env.CHROME_PATH && { executablePath: process.env.CHROME_PATH }),
});

// Use the original Host capture. Reletter only the two agent names at native
// resolution, preserving the rest of the pixels and the disabled-row styling.
export async function labelHostCapture(page, original) {
  return page.evaluate(async (src) => {
    const image = new Image(); image.src = src; await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    if (canvas.width !== 1180 || canvas.height !== 820) throw new Error('Unexpected Host capture dimensions');
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    ctx.font = '15px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    for (const [baseline, label, color] of [[626,'DSH','#68768d'],[688,'DSH 桌面版','#232a36']]) {
      const [r,g,b] = ctx.getImageData(321,baseline,1,1).data;
      ctx.fillStyle = `rgb(${r} ${g} ${b})`; ctx.fillRect(322, baseline-18, 148, 23);
      ctx.fillStyle = color; ctx.fillText(label, 324, baseline);
    }
    return canvas.toDataURL('image/png');
  }, original);
}
