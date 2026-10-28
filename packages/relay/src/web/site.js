const hostPlatforms = {
  windows: {
    requirement: "Windows 10 / 11 · x64",
    detail: "安装与更新 Agent，管理模型供应商，添加手机并管理连接。",
    note: "当前为预览版，安装时 Windows 可能提示发布者未验证。",
    pattern: /^OrbisHost-(\d+\.\d+\.\d+)-windows-x64(?:-setup\.exe|\.zip)$/,
    files: data => data.windows,
  },
  "macos-arm64": {
    requirement: "macOS · Apple Silicon",
    detail: "下载 DMG 后打开，将 Orbis Host 拖入「应用程序」，再连接手机。",
    note: "请按「关于本机」中的芯片类型选择 Apple Silicon 或 Intel 版本。",
    pattern: /^OrbisHost-(\d+\.\d+\.\d+)-macos-arm64\.dmg$/,
    files: data => data.macos,
  },
  "macos-x64": {
    requirement: "macOS · Intel",
    detail: "下载 DMG 后打开，将 Orbis Host 拖入「应用程序」，再连接手机。",
    note: "请按「关于本机」中的芯片类型选择 Apple Silicon 或 Intel 版本。",
    pattern: /^OrbisHost-(\d+\.\d+\.\d+)-macos-x64\.dmg$/,
    files: data => data.macos,
  },
};
const appPlatforms = {
  android: {
    requirement: "Android 手机 · APK",
    detail: "接着对话、回应审批、收发文件，也能切换电脑上已保存的供应商。",
    note: "安装后扫描电脑端的配对二维码。",
  },
  ios: {
    requirement: "iPhone · 原生版预览开发中",
    detail: "Orbis iOS 原生客户端已进入开发，支持扫码配对、端到端加密和移动端聊天。",
    note: "当前源码已纳入仓库，正式 TestFlight / App Store 包发布后会在这里提供。",
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
  if (platform === "ios") {
    version.textContent = "原生版预览开发中";
    container.textContent = "iOS 原生客户端源码已提供，正式安装包将在完成 Xcode 真机验证后发布。";
    return;
  }
  if (!siteData) {
    version.textContent = "版本信息暂不可用";
    container.textContent = "暂时无法读取下载信息，请刷新重试或前往 GitHub 版本页。";
    return;
  }
  version.textContent = typeof siteData.androidVersion === "string" ? `预览版 · ${siteData.androidVersion}` : "预览版";
  const url = typeof siteData.android === "string" ? siteData.android : "https://orbising.com/downloads/orbis.apk";
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
    notice.textContent = data.enabled ? data.qqEmailVerificationRequired ? "现在就能开始 · 使用 QQ 邮箱接收验证码，免费激活电脑端。" : "现在就能开始 · 电脑端可直接免费激活，无需邮箱验证码。" : "新用户激活暂未开放，可先下载客户端，稍后再试。";
    notice.classList.toggle("positive", data.enabled);
    document.getElementById("activation-step").textContent = data.enabled ? data.qqEmailVerificationRequired ? "下载安装，用 QQ 邮箱接收验证码，完成免费激活。" : "下载安装，按客户端提示直接完成免费激活。" : "先下载安装；新用户激活暂未开放，请稍后再试。";
    document.getElementById("email-faq").textContent = data.qqEmailVerificationRequired ? "QQ 邮箱用于接收激活验证码，确认这台电脑由你连接。只需填写验证码，不需要提供 QQ 密码。" : "目前无需邮箱验证码，按客户端提示即可直接激活。以后如需验证，客户端会告诉你如何操作。";
  } catch {
    notice.textContent = "暂时无法确认是否可以注册，请稍后重试。";
  }
}

function setupFeatureTour() {
  const tour = document.querySelector(".feature-tour");
  const slides = Array.from(document.querySelectorAll(".feature-slide"));
  const tabs = Array.from(document.querySelectorAll(".feature-tab"));
  if (!tour || !slides.length || slides.length !== tabs.length) return;
  const counter = tour.querySelector(".tour-counter");
  const progress = tour.querySelector(".tour-progress-line");
  const toggle = tour.querySelector(".tour-toggle");
  const toggleLabel = toggle?.querySelector("span:last-child");
  const directionButtons = Array.from(tour.querySelectorAll("[data-tour-direction]"));
  const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  let activeIndex = 0;
  let paused = reducedMotion;
  let timer;

  function schedule() {
    globalThis.clearTimeout(timer);
    if (paused) return;
    timer = globalThis.setTimeout(() => selectFeature(slides[(activeIndex + 1) % slides.length].dataset.featureSlide), 6500);
  }

  function selectFeature(name, { updateHash = false } = {}) {
    const nextIndex = slides.findIndex(slide => slide.dataset.featureSlide === name);
    if (nextIndex < 0) return;
    activeIndex = nextIndex;
    for (const [index, slide] of slides.entries()) {
      const active = index === activeIndex;
      slide.classList.toggle("is-active", active);
      slide.setAttribute("aria-hidden", String(!active));
    }
    for (const [index, tab] of tabs.entries()) {
      const active = index === activeIndex;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
    }
    if (counter) counter.textContent = `${String(activeIndex + 1).padStart(2, "0")} / ${String(slides.length).padStart(2, "0")}`;
    if (progress) progress.style.setProperty("--feature-progress", `${((activeIndex + 1) / slides.length) * 100}%`);
    if (updateHash) globalThis.history.replaceState(null, "", `#${slides[activeIndex].id}`);
    schedule();
  }

  for (const tab of tabs) tab.addEventListener("click", () => selectFeature(tab.dataset.featureTab));
  for (const button of directionButtons) {
    button.addEventListener("click", () => {
      const step = button.dataset.tourDirection === "previous" ? -1 : 1;
      selectFeature(slides[(activeIndex + step + slides.length) % slides.length].dataset.featureSlide);
    });
  }
  toggle?.addEventListener("click", () => {
    paused = !paused;
    tour.classList.toggle("is-paused", paused);
    toggle.setAttribute("aria-label", paused ? "继续自动播放" : "暂停自动播放");
    if (toggleLabel) toggleLabel.textContent = paused ? "播放" : "暂停";
    schedule();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) schedule();
  });
  for (const anchor of document.querySelectorAll("a[href^=\"#\"]")) {
    const target = anchor.getAttribute("href")?.slice(1);
    const slide = slides.find(item => item.id === target);
    if (!slide) continue;
    anchor.addEventListener("click", event => {
      event.preventDefault();
      selectFeature(slide.dataset.featureSlide, { updateHash: true });
      tour.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
  const initialTarget = slides.find(slide => slide.id === globalThis.location.hash.slice(1));
  selectFeature(initialTarget?.dataset.featureSlide ?? slides[0].dataset.featureSlide);
}

function setupUseCases() {
  const steps = Array.from(document.querySelectorAll(".use-case-step"));
  const screens = Array.from(document.querySelectorAll(".use-case-screen"));
  if (!steps.length || !screens.length) return;
  function selectUseCase(name) {
    for (const step of steps) step.classList.toggle("is-active", step.dataset.useCase === name);
    for (const screen of screens) {
      const active = screen.dataset.useScreen === name;
      screen.classList.toggle("is-active", active);
      screen.setAttribute("aria-hidden", String(!active));
    }
  }
  selectUseCase(steps[0].dataset.useCase);
  if (!("IntersectionObserver" in globalThis)) return;
  const observer = new globalThis.IntersectionObserver(entries => {
    const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (visible) selectUseCase(visible.target.dataset.useCase);
  }, { rootMargin: "-38% 0px -42%", threshold: [0, .25, .6] });
  for (const step of steps) observer.observe(step);
}
setupFeatureTour();
setupUseCases();
void loadDownloads();
void loadRegistration();
