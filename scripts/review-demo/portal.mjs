import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import QRCode from "qrcode";
import { readJson, jsonResponse } from "../../packages/relay/dist/http-utils.js";

const hash = value => createHash("sha256").update(value).digest();
const equal = (a, b) => typeof a === "string" && timingSafeEqual(hash(a), hash(b));
const escapeHtml = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export async function createPortal({ pairing, relayUrl, adminToken, port = 8788, host = "0.0.0.0", ready = () => true }) {
  const image = await QRCode.toBuffer(pairing.text, { width: 800, margin: 3 });
  const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Orbis App Review</title>
<style>body{font:17px system-ui;max-width:760px;margin:30px auto;padding:0 24px;color:#182634;background:#f6f8fa}h1{font-size:28px}p,li{line-height:1.6}img{display:block;width:min(100%,520px);margin:auto}textarea{width:100%;box-sizing:border-box;height:90px}</style>
<h1>Orbis Agent Remote — Review Host</h1><p>Scan this fixed QR code in Orbis to connect to <b>Orbis Review Demo</b>. No webpage login or desktop installation is needed.</p>
<img src="qr.png" alt="Reusable Orbis review pairing QR code"><ol><li>In the app, tap <b>扫码配对</b> and scan this QR from another screen. On one device, copy the JSON below and paste it using <b>粘贴配对二维码内容</b>, then tap <b>连接</b>.</li><li>Open the Pi session in <b>/data/workspace</b>. If needed, create a Pi session in that folder.</li><li>Send <b>Read README.md and explain this sample project.</b> Then try <b>Update the greeting in hello.js and show the changes.</b></li></ol>
<p>This QR can be reused while the review Host is enabled. Each successful new pairing replaces the previous paired device.</p><textarea aria-label="Pairing QR JSON" readonly>${escapeHtml(pairing.text)}</textarea>
<p>This is an isolated shared sample workspace with a real DeepSeek Flash model. Do not enter private information. Optional desktop integrations are not installed here.</p></html>`;
  const base = relayUrl.replace(/^ws/u, "http").replace(/\/$/u, "");
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer"); res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try {
      if (req.url === "/healthz" && req.method === "GET") return jsonResponse(res, ready() ? 200 : 503, { ok: ready() });
      if (req.url === "/v1/pairings" && req.method === "POST") {
        const body = await readJson(req);
        if (!equal(body.code, pairing.code) || typeof body.deviceName !== "string" || !body.deviceName.trim()) return jsonResponse(res, 401, { error: "invalid_pairing_code" });
        // Every scan receives a fresh ordinary Relay transport credential. Only the
        // isolated review adapter accepts the fixed code; production stays unchanged.
        const created = await fetch(`${base}/v1/pairing-codes`, { method: "POST", headers: { authorization: `Bearer ${adminToken}` } });
        if (!created.ok) throw new Error("Could not create review transport credential");
        const { code } = await created.json();
        const redeemed = await fetch(`${base}/v1/pairings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: body.deviceName }) });
        if (!redeemed.ok) throw new Error("Could not redeem review transport credential");
        return jsonResponse(res, 201, await redeemed.json());
      }
      if (req.method === "GET" && req.url === `${pairing.pagePath}qr.png`) {
        res.writeHead(200, { "content-type": "image/png" }); return res.end(image);
      }
      if (req.method === "GET" && req.url === `${pairing.pagePath}pairing.json`) {
        res.writeHead(200, { "content-type": "application/json" }); return res.end(pairing.text);
      }
      if (req.method === "GET" && req.url === pairing.pagePath) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(page);
      }
      return jsonResponse(res, 404, { error: "not_found" });
    } catch { if (!res.headersSent) jsonResponse(res, 503, { error: "Review Host is reconnecting; try again shortly" }); else res.destroy(); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  return { server, url: `http://127.0.0.1:${server.address().port}`, image, close: () => new Promise(resolve => server.close(resolve)) };
}
