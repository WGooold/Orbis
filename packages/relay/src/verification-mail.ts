import nodemailer from "nodemailer";
import type { VerificationMail } from "./registration.js";

/** Missing SMTP configuration disables registration; verification codes are never logged or returned by HTTP. */
export function verificationMailer(env: NodeJS.ProcessEnv = process.env): ((mail: VerificationMail) => Promise<void>) | undefined {
  if (!env.ORBIS_SMTP_HOST) return undefined;
  const port = Number(env.ORBIS_SMTP_PORT ?? 465);
  const from = env.ORBIS_SMTP_FROM;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !from) throw new Error("ORBIS_SMTP_PORT and ORBIS_SMTP_FROM must be configured");
  const transport = nodemailer.createTransport({
    host: env.ORBIS_SMTP_HOST, port,
    secure: port === 465,
    requireTLS: port !== 465,
    ...(env.ORBIS_SMTP_USER ? { auth: { user: env.ORBIS_SMTP_USER, pass: env.ORBIS_SMTP_PASSWORD ?? "" } } : {}),
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
    disableFileAccess: true, disableUrlAccess: true,
  });
  return async ({ email, code, expiresInMinutes }) => {
    await transport.sendMail({
      from, to: email, subject: "Orbis · 验证你的 QQ 邮箱",
      text: `你的 Orbis 验证码是：${code}\n\n请在 ${expiresInMinutes} 分钟内在 Windows 客户端输入，完成注册并激活这台电脑。\n如非本人操作，请忽略此邮件。不要向他人透露验证码。`,
    });
  };
}
