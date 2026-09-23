/**
 * 生成 E2E 交叉验证向量（Node 侧权威实现 → Android Kotlin 单元测试）。
 *
 * 固定熵约定（Android 侧 E2eVectors 与测试必须按同一约定构造输入）：
 * - host 长期私钥 = RFC 7748 §5.2 Alice；设备长期私钥 = Bob；
 * - 配对 psk = 32 字节全 0x11；nonce_d = 32×0x22；nonce_h = 32×0x33；
 * - 连接握手临时私钥：设备 = 32×0x44，Host = 32×0x55；
 * - 测试房间路由：room=host-1, from=device-1, to=host-1。
 *
 * 用法：node scripts/e2e-vectors.mjs   （输出与 android E2eVectors.kt 对齐）
 */
import {
  deriveConfirmKey,
  derivePskRoot,
  deriveSessionKeys,
  handshakeMacFromDevice,
  handshakeMacFromHost,
  pairMacFromDevice,
  pairMacFromHost,
  privateKeyFromRaw,
  publicRawFromPrivateRaw,
  sealAead,
  toBase64Url,
} from "../packages/e2e/dist/index.js";
import { canonEnvelopeAad, envelopeNonce } from "../packages/protocol/dist/index.js";
import { createPublicKey, diffieHellman } from "node:crypto";

const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const hostPriv = Buffer.from("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a", "hex");
const devicePriv = Buffer.from("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb", "hex");
const hostPub = publicRawFromPrivateRaw(hostPriv);
const devicePub = publicRawFromPrivateRaw(devicePriv);
const agreement = (privateRaw, peerPublicRaw) =>
  diffieHellman({
    privateKey: privateKeyFromRaw(privateRaw),
    publicKey: createPublicKey({ key: Buffer.concat([SPKI_PREFIX, peerPublicRaw]), format: "der", type: "spki" }),
  });

const ss = agreement(devicePriv, hostPub);
const pskRoot = derivePskRoot({ sharedSecret: ss, hostPublicRaw: hostPub, devicePublicRaw: devicePub });
const psk = Buffer.alloc(32, 0x11);
const confirmKey = deriveConfirmKey({ psk, pskRoot, hostPublicRaw: hostPub, devicePublicRaw: devicePub });
const nonceD = toBase64Url(Buffer.alloc(32, 0x22));
const nonceH = toBase64Url(Buffer.alloc(32, 0x33));

const eDPriv = Buffer.alloc(32, 0x44);
const eHPriv = Buffer.alloc(32, 0x55);
const ePubD = publicRawFromPrivateRaw(eDPriv);
const ePubH = publicRawFromPrivateRaw(eHPriv);
const ee = agreement(eDPriv, ePubH);
const keys = deriveSessionKeys({ sharedSecret: ee, pskRoot, hostEphemeralPublic: ePubH, deviceEphemeralPublic: ePubD });

const dataCt = (n, payload) =>
  toBase64Url(sealAead({
    key: keys.kDeviceToHost,
    nonce: envelopeNonce(n),
    aad: canonEnvelopeAad({ k: "data", room: "host-1", from: "device-1", to: "host-1", n }),
    plaintext: Buffer.from(payload, "utf8"),
  }));

console.log(`HOST_PUB    = ${toBase64Url(hostPub)}`);
console.log(`DEVICE_PUB  = ${toBase64Url(devicePub)}`);
console.log(`PSK_ROOT    = ${toBase64Url(pskRoot)}`);
console.log(`CONFIRM_KEY = ${toBase64Url(confirmKey)}`);
console.log(`MAC_D       = ${toBase64Url(pairMacFromDevice(confirmKey, nonceD))}`);
console.log(`MAC_H       = ${toBase64Url(pairMacFromHost(confirmKey, nonceD, nonceH))}`);
console.log(`E_PUB_D     = ${toBase64Url(ePubD)}`);
console.log(`E_PUB_H     = ${toBase64Url(ePubH)}`);
console.log(`K_H2D       = ${toBase64Url(keys.kHostToDevice)}`);
console.log(`K_D2H       = ${toBase64Url(keys.kDeviceToHost)}`);
console.log(`HS_MAC_H    = ${toBase64Url(handshakeMacFromHost(keys, ePubH, ePubD))}`);
console.log(`HS_MAC_D    = ${toBase64Url(handshakeMacFromDevice(keys, ePubH, ePubD))}`);
console.log(`DATA_CT_N1  = ${dataCt(1, '{"type":"device.ready"}')}`);
console.log(`DATA_CT_N2  = ${dataCt(2, "hello world")}`);
