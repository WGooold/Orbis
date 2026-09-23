async function loadDownloads() {
  const container = document.getElementById("windows-downloads");
  try {
    const response = await fetch("v1/site", { cache: "no-store" });
    if (!response.ok) throw new Error("unavailable");
    const data = await response.json();
    container.replaceChildren();
    if (!data.windows.length) {
      const message = document.createElement("p");
      message.textContent = "Windows 预览包正在准备，请稍后再来。";
      container.append(message);
    }
    document.getElementById("site-version").textContent = `PREVIEW · ${data.version}`;
    for (const release of data.windows.filter(item => item.name.startsWith(`OrbisHost-${data.version}-`))) {
      const link = document.createElement("a");
      link.className = release.name.endsWith(".exe") ? "button primary" : "text-link portable-link";
      link.href = release.url;
      link.textContent = release.name.endsWith(".exe") ? `下载 Windows 安装版 · ${(release.bytes / 1048576).toFixed(0)} MB ↓` : "下载便携 ZIP 版 ↗";
      const checksum = document.createElement("a");
      checksum.className = "checksum-link";
      checksum.href = release.checksumUrl;
      checksum.textContent = "SHA-256 校验文件";
      container.append(link, checksum);
    }
  } catch {
    container.textContent = "暂时无法读取 Windows 下载信息，请刷新页面重试。";
  }
}
async function loadRegistration() {
  const notice = document.getElementById("registration-status");
  try {
    const response = await fetch("v1/registration/status", { cache: "no-store" });
    if (!response.ok) throw new Error("unavailable");
    const data = await response.json();
    notice.textContent = data.enabled ? data.qqEmailVerificationRequired ? "公共注册服务已开放 · 使用 QQ 邮箱验证码激活你的 Windows Host。" : "公共注册服务已开放 · 新 Host 目前可直接激活，无需邮箱验证码。" : "公共注册尚未开放：邮件服务仍在配置中。可以先安装预览客户端；新 Host 需待注册开放后完成激活。";
    notice.classList.toggle("positive", data.enabled);
    document.getElementById("activation-step").textContent = data.qqEmailVerificationRequired ? "Windows 客户端自带所需运行依赖，使用 QQ 邮箱验证码注册并激活。" : "Windows 客户端自带所需运行依赖，按服务器当前设置直接激活。";
    document.getElementById("email-faq").textContent = data.qqEmailVerificationRequired ? "当前服务器要求通过 QQ 邮箱验证码验证所有权。只需要验证码，无需提供 QQ 密码；邮件服务配置完成后会开放新注册。" : "当前服务器未要求 QQ 邮箱验证，新 Host 可以直接激活。管理员以后可以重新开启邮箱验证。";
  } catch {
    notice.textContent = "暂时无法确认公共注册服务状态，请稍后重试。";
  }
}
void loadDownloads();
void loadRegistration();
