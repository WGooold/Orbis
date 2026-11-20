import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { messageCSS } from './message-ui.mjs';

export async function renderMessageScreens({ browser, screens, work, katexCss, katexPath }) {
  const directory = path.join(work, 'screens');
  await mkdir(directory, { recursive: true });
  const records = [];
  {
    for (const screen of screens) {
      const context = await browser.newContext({ viewport:{width:screen.width,height:screen.height}, deviceScaleFactor:3, colorScheme:screen.theme === 'dark' ? 'dark' : 'light' });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${screen.name}</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}${katexCss}\n${messageCSS}</style><body>${screen.html}</body></html>`;
      await writeFile(path.join(directory, `${screen.name}.html`), html);
      await page.setContent(html, { waitUntil:'load' });
      await page.addScriptTag({ path:katexPath });
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('[data-tex]')) {
          katex.render(el.dataset.tex, el, { displayMode:el.classList.contains('tex-block'), throwOnError:true, output:'html' });
        }
      });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(() => [...document.images].every(image => image.complete));
      const geometry = await page.evaluate(() => {
        const rect = el => { const r = el.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom }; };
        const transcript = document.querySelector('.app-transcript');
        const bounds = transcript ? rect(transcript) : null;
        const messages = [...document.querySelectorAll('.app-transcript>[data-message]')].map(el => ({ ...rect(el),text:el.innerText.slice(0,36) }));
        const overflow = [...document.querySelectorAll('.message-code pre,.message-formula,.message-table,.workspace,.composer-field')].filter(el => el.scrollWidth > el.clientWidth + 1).map(el => ({ selector:el.className || el.tagName,width:el.clientWidth,contentWidth:el.scrollWidth }));
        return {
          screen:rect(document.querySelector('main')),transcript:bounds,messages,
          clippedMessages:bounds ? messages.filter(r => r.x < bounds.x - 1 || r.right > bounds.right + 1 || r.y < bounds.y - 1 || r.bottom > bounds.bottom - 8) : [],
          overflow,katexErrors:document.querySelectorAll('.katex-error').length,formulas:document.querySelectorAll('[data-tex]').length,
          brokenImages:[...document.images].filter(image => !image.naturalWidth).length,
        };
      });
      const record = { name:screen.name,source:'reconstructed-source-aligned-example',dimensions:[screen.width*3,screen.height*3],...geometry,errors };
      records.push(record);
      if (errors.length || geometry.katexErrors || geometry.brokenImages || geometry.clippedMessages.length || geometry.overflow.length) {
        await writeFile(path.join(directory,'checks.json'),JSON.stringify(records,null,2));
        await page.screenshot({path:path.join(directory,`${screen.name}.png`)});
        throw new Error(`Screen ${screen.name} failed layout checks: ${JSON.stringify(record)}`);
      }
      await page.screenshot({path:path.join(directory,`${screen.name}.png`)});
      await context.close();
      console.log('Message screen',screen.name);
    }
  }
  await writeFile(path.join(directory,'checks.json'),JSON.stringify(records,null,2));
  return records;
}
