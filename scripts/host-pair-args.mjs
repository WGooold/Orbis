/**
 * `host-pair.mjs` 的纯函数部分：从 argv 解出轮换秒数。
 *
 * 单独成模块是为了能被测试 import 而不启动 Host——`host-pair.mjs` 顶层会
 * `await service.start()`，import 它等于又起一个常驻 Host。
 */

/**
 * 位置参数只认纯数字；`--flag` 之类的开关必须跳过。
 *
 * 这里曾经直接 `Number(process.argv[2] ?? 240)`：传 `--codex` 时拿到 NaN，
 * 而 `setInterval(fn, NaN)` 会被 Node 当成 1ms——于是配对码**每秒轮换上千次**
 * （每次都要打 relay HTTP + 生成二维码 PNG），事件循环被彻底占满，
 * `session.list` 从 25ms 涨到 20 多秒，用户看到的是「新建会话几十秒才出现在手机上」。
 */
export function parseRotateSeconds(argv) {
  const positional = argv.slice(2).filter((arg) => !arg.startsWith("-"));
  const raw = positional[0];
  if (raw === undefined) return 240;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    console.error(`[host] 忽略非法轮换秒数 ${JSON.stringify(raw)}，回退 240s`);
    return 240;
  }
  return seconds;
}
