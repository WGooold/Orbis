import dgram from "node:dgram";
import crypto from "node:crypto";
const sock = dgram.createSocket("udp4");
const tid = crypto.randomBytes(12);
const msg = Buffer.alloc(20);
msg.writeUInt16BE(0x0001, 0);      // Binding Request
msg.writeUInt16BE(0, 2);           // msg length
msg.writeUInt32BE(0x2112a442, 4);  // MAGIC COOKIE
tid.copy(msg, 8);
const timer = setTimeout(() => { console.log("TIMEOUT"); sock.close(); process.exit(1); }, 4000);
sock.on("message", (m) => {
  if (m.length < 20 || !m.subarray(8, 20).equals(tid)) return;
  clearTimeout(timer);
  let addr = null, off = 20;
  while (off + 4 <= m.length) {
    const type = m.readUInt16BE(off), len = m.readUInt16BE(off + 2);
    if (type === 0x0020 && len >= 8) {
      const port = m.readUInt16BE(off + 6) ^ 0x2112;
      const ip = [...m.subarray(off + 8, off + 12)].map((b, i) => b ^ [0x21, 0x12, 0xa4, 0x42][i]).join(".");
      addr = `${ip}:${port}`;
    }
    off += 4 + len;
  }
  console.log("STUN_OK " + (addr ?? "no-xor-attr"));
  sock.close(); process.exit(0);
});
sock.send(msg, 3478, process.argv[2] || "74.81.55.191");
