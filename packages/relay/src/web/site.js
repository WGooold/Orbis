const hostPlatforms = {
  windows: {
    requirement: "Windows 10 / 11 · x64",
    detail: "安装后，在电脑端添加手机。",
    note: "当前为预览版，安装时 Windows 可能提示发布者未验证。",
    pattern: /^OrbisHost-(\d+\.\d+\.\d+)-windows-x64(?:-setup\.exe|\.zip)$/,
    files: data => data.windows,
  },
  "macos-arm64": {
    requirement: "macOS · Apple Silicon",
    detail: "打开 DMG，将 Orbis Host 拖入「应用程序」。",
    note: "请按「关于本机」中的芯片类型选择 Apple Silicon 或 Intel 版本。",
    pattern: /^OrbisHost-(\d+\.\d+\.\d+)-macos-arm64\.dmg$/,
    files: data => data.macos,
  },
  "macos-x64": {
    requirement: "macOS · Intel",
    detail: "打开 DMG，将 Orbis Host 拖入「应用程序」。",
    note: "请按「关于本机」中的芯片类型选择 Apple Silicon 或 Intel 版本。",
    pattern: /^OrbisHost-(\d+\.\d+\.\d+)-macos-x64\.dmg$/,
    files: data => data.macos,
  },
};
const appPlatforms = {
  android: {
    requirement: "Android 手机 · APK",
    detail: "安装后，扫描电脑端的配对二维码。",
    note: "安装后扫描电脑端的配对二维码。",
  },
  ios: {
    requirement: "iPhone · iOS",
    detail: "扫码，让 Agent 来到手边。",
    note: "安装入口以当前发布信息为准。",
  },
};
let siteData;

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  return b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
}

function hostReleases(platform) {
  const spec = hostPlatforms[platform];
  const files = siteData && Array.isArray(spec.files(siteData)) ? spec.files(siteData) : [];
  return files.flatMap(file => {
    const match = typeof file?.name === "string" ? file.name.match(spec.pattern) : null;
    return match && typeof file.url === "string" && typeof file.checksumUrl === "string"
      ? [{ ...file, version: match[1] }] : [];
  }).sort((a, b) => compareVersions(a.version, b.version)
    || Number(b.name.endsWith(".exe")) - Number(a.name.endsWith(".exe")));
}

function renderHost(platform) {
  const spec = hostPlatforms[platform];
  const version = document.getElementById("host-version");
  const container = document.getElementById("host-downloads");
  document.getElementById("host-requirement").textContent = spec.requirement;
  document.getElementById("host-detail").textContent = spec.detail;
  document.getElementById("host-note").textContent = spec.note;
  container.replaceChildren();
  if (!siteData) {
    version.textContent = "版本信息暂不可用";
    container.textContent = "暂时无法读取下载信息，请刷新重试或前往 GitHub 版本页。";
    return;
  }
  const releases = hostReleases(platform);
  const latest = releases[0]?.version;
  version.textContent = latest ? `预览版 · ${latest}` : "预览包准备中";
  if (!latest) {
    container.textContent = "该平台的预览包正在准备，发布后即可在这里下载。";
    return;
  }
  for (const release of releases.filter(file => file.version === latest)) {
    const portable = release.name.endsWith(".zip");
    const link = document.createElement("a");
    link.className = portable ? "text-link portable-link" : "button primary";
    link.href = release.url;
    const size = Number.isFinite(release.bytes) && release.bytes > 0 ? ` · ${(release.bytes / 1048576).toFixed(0)} MB` : "";
    link.textContent = portable
      ? "下载免安装版 ZIP ↗"
      : `下载 ${platform === "windows" ? "Windows 安装版" : "macOS 版"}${size} ↓`;
    const checksum = document.createElement("a");
    checksum.className = "checksum-link";
    checksum.href = release.checksumUrl;
    checksum.textContent = portable ? "免安装版 SHA-256 校验文件" : "SHA-256 校验文件";
    container.append(link, checksum);
  }
}

function renderApp(platform) {
  const spec = appPlatforms[platform];
  const version = document.getElementById("app-version");
  const container = document.getElementById("app-downloads");
  document.getElementById("app-requirement").textContent = spec.requirement;
  document.getElementById("app-detail").textContent = spec.detail;
  document.getElementById("app-note").textContent = spec.note;
  container.replaceChildren();
  if (!siteData) {
    version.textContent = "版本信息暂不可用";
    container.textContent = "暂时无法读取下载信息，请刷新重试或前往 GitHub 版本页。";
    return;
  }
  if (platform === "ios") {
    const url = typeof siteData.ios === "string" && /^https:\/\//.test(siteData.ios) ? siteData.ios : undefined;
    version.textContent = url ? "iOS 安装入口" : "安装入口暂未提供";
    if (!url) {
      container.textContent = "当前发布信息未提供 iOS 安装链接，请留意版本页。";
      return;
    }
    const link = document.createElement("a");
    link.className = "button primary";
    link.href = url;
    link.textContent = "获取 iOS 版 ↗";
    container.append(link);
    return;
  }
  if (typeof siteData.android !== "string" || !/^https:\/\//.test(siteData.android)) {
    version.textContent = "安装入口暂未提供";
    container.textContent = "当前发布信息未提供 Android 安装链接。";
    return;
  }
  version.textContent = typeof siteData.androidVersion === "string" ? `预览版 · ${siteData.androidVersion}` : "预览版";
  const url = siteData.android;
  const link = document.createElement("a");
  link.className = "button primary";
  link.href = url;
  link.textContent = "下载 Android 版 ↓";
  const checksum = document.createElement("a");
  checksum.className = "checksum-link";
  checksum.href = `${url}.sha256`;
  checksum.textContent = "SHA-256 校验文件";
  container.append(link, checksum);
}

async function loadDownloads() {
  const hostSelect = document.getElementById("host-platform");
  const appSelect = document.getElementById("app-platform");
  hostSelect.addEventListener("change", () => renderHost(hostSelect.value));
  appSelect.addEventListener("change", () => renderApp(appSelect.value));
  try {
    const response = await fetch("v1/site", { cache: "no-store" });
    if (!response.ok) throw new Error("unavailable");
    siteData = await response.json();
  } catch {
    siteData = undefined;
  }
  renderHost(hostSelect.value);
  renderApp(appSelect.value);
}

async function loadRegistration() {
  const notice = document.getElementById("registration-status");
  try {
    const response = await fetch("v1/registration/status", { cache: "no-store" });
    if (!response.ok) throw new Error("unavailable");
    const data = await response.json();
    notice.textContent = data.enabled ? data.qqEmailVerificationRequired ? "激活已开放 · 在电脑端使用 QQ 邮箱接收验证码。" : "激活已开放 · 在电脑端按提示开始。" : "新用户激活暂未开放，请稍后再试。";
    notice.classList.toggle("positive", data.enabled);
  } catch {
    notice.textContent = "暂时无法确认是否可以注册，请稍后重试。";
  }
}

void loadDownloads();
void loadRegistration();
