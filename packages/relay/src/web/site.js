async function loadDownloads() {
  const container = document.getElementById("windows-downloads");
  try {
    const response = await fetch("v1/site", { cache: "no-store" });
    if (!response.ok) throw new Error("unavailable");
    const data = await response.json();
    container.replaceChildren();
    const releases = data.windows.filter(item => item.name.startsWith(`OrbisHost-${data.version}-`));
    if (!releases.length) {
      const message = document.createElement("p");
      message.textContent = "Windows 预览包正在准备，请稍后再来。";
      container.append(message);
    }
    document.getElementById("site-version").textContent = `预览版 · ${data.version}`;
    for (const release of releases) {
      const link = document.createElement("a");
      link.className = release.name.endsWith(".exe") ? "button primary" : "text-link portable-link";
      link.href = release.url;
      link.textContent = release.name.endsWith(".exe") ? `免费下载 Windows 版 · ${(release.bytes / 1048576).toFixed(0)} MB ↓` : "下载免安装版 ↗";
      const checksum = document.createElement("a");
      checksum.className = "checksum-link";
      checksum.href = release.checksumUrl;
      checksum.textContent = "下载完整性校验文件";
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
    notice.textContent = data.enabled ? data.qqEmailVerificationRequired ? "现在就能开始 · 使用 QQ 邮箱接收验证码，免费激活电脑端。" : "现在就能开始 · 电脑端可直接免费激活，无需邮箱验证码。" : "新用户激活暂未开放，可先下载客户端，稍后再试。";
    notice.classList.toggle("positive", data.enabled);
    document.getElementById("activation-step").textContent = data.enabled ? data.qqEmailVerificationRequired ? "下载安装，用 QQ 邮箱接收验证码，完成免费激活。" : "下载安装，按客户端提示直接完成免费激活。" : "先下载安装；新用户激活暂未开放，请稍后再试。";
    document.getElementById("email-faq").textContent = data.qqEmailVerificationRequired ? "QQ 邮箱用于接收激活验证码，确认这台电脑由你连接。只需填写验证码，不需要提供 QQ 密码。" : "目前无需邮箱验证码，按客户端提示即可直接激活。以后如需验证，客户端会告诉你如何操作。";
  } catch {
    notice.textContent = "暂时无法确认是否可以注册，请稍后重试。";
  }
}

function setupShowcase() {
  const tablist = document.querySelector(".showcase-tabs");
  const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
  function selectTab(selected) {
    for (const tab of tabs) {
      const active = tab === selected;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      document.getElementById(tab.getAttribute("aria-controls")).hidden = !active;
    }
  }
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener("click", () => selectTab(tab));
    tab.addEventListener("keydown", event => {
      let next;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else return;
      event.preventDefault();
      selectTab(tabs[next]);
      tabs[next].focus();
    });
  }
  tablist.hidden = false;
}
setupShowcase();
void loadDownloads();
void loadRegistration();
