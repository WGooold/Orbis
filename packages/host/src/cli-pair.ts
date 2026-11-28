import { encodePairingQrText, type DeviceRecord } from "@orbis/e2e";
import type { HostService } from "./host-service.js";

export async function runPairingWindow(
  service: Pick<HostService, "start" | "openPairingWindow" | "stop">,
  paired: Promise<DeviceRecord>,
  printPayload: boolean,
  shutdown?: Promise<void>,
): Promise<"paired" | "expired" | "cancelled"> {
  const status = printPayload ? console.error : console.log;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let device: DeviceRecord | undefined | null;
  try {
    await service.start();
    const opened = await service.openPairingWindow();
    const pairingText = encodePairingQrText(opened.payload);
    if (printPayload) {
      console.log(pairingText);
    } else {
      process.stdout.write(await renderTerminalQr(pairingText));
      const remainingSeconds = Math.round((opened.expiresAtMs - Date.now()) / 1_000);
      status(`请用 Orbis APP 扫码。窗口 ${remainingSeconds} 秒后关闭。`);
    }
    const lan = opened.payload.lan;
    if (lan !== undefined && lan.length > 0) {
      status(`同一局域网内会直连：${lan.map((entry) => `${entry.host}:${entry.port}`).join("、")}`);
    }

    // 计时器在窗口期保持引用，避免 Relay 断开时进程提前退出；成功配对后立即清除。
    const expiry = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), Math.max(0, opened.expiresAtMs - Date.now()));
    });
    const cancelled = shutdown?.then(() => null);
    device = await Promise.race(cancelled ? [paired, expiry, cancelled] : [paired, expiry]);
  } finally {
    clearTimeout(timer);
    await service.stop();
  }

  if (device === null) return "cancelled";
  if (device === undefined) {
    console.error("配对窗口已过期，没有设备完成配对。");
    return "expired";
  }
  status(`配对成功：${device.deviceId}`);
  status("接着运行 `orbis host` 常驻即可。");
  return "paired";
}

async function renderTerminalQr(text: string): Promise<string> {
  const QRCode = (await import("qrcode")).default;
  return await QRCode.toString(text, { type: "terminal", small: true });
}
