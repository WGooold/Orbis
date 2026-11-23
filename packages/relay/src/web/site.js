const hostPlatforms = {
  windows: {
    requirement: "Windows 10 / 11 (x64)",
    pattern: /^OrbisHost-(\d+\.\d+\.\d+)-windows-x64-setup\.exe$/,
    files: data => data.windows,
  },
  "macos-arm64": {
    requirement: "macOS (Apple Silicon)",
    pattern: /^OrbisHost-(\d+\.\d+\.\d+)-macos-arm64\.dmg$/,
    files: data => data.macos,
  },
  "macos-x64": {
    requirement: "macOS (Intel)",
    pattern: /^OrbisHost-(\d+\.\d+\.\d+)-macos-x64\.dmg$/,
    files: data => data.macos,
  },
};
const appPlatforms = {
  android: {
    requirement: "Android 手机（APK）",
  },
  ios: {
    requirement: "iPhone（iOS）",
  },
};
let siteData;
let deviceRecommendation;

function detectDeviceRecommendation(nav = navigator, architecture = "") {
  const ua = typeof nav?.userAgent === "string" ? nav.userAgent : "";
  const platform = typeof nav?.platform === "string" ? nav.platform : "";
  const touchPoints = Number(nav?.maxTouchPoints ?? 0);
  const arch = typeof architecture === "string" ? architecture.toLowerCase() : "";
  // iPadOS may identify as desktop Safari; touch-capable Macs here are iPads.
  if (/iPad|iPhone|iPod/i.test(ua) || (platform === "MacIntel" && touchPoints > 1)) {
    return { card: "app", platform: "ios", label: "Orbis App（iOS）", matches: value => value === "ios" };
  }
  if (/Android/i.test(ua)) {
    return { card: "app", platform: "android", label: "Orbis App（Android）", matches: value => value === "android" };
  }
  if (/Windows/i.test(ua) || /Win/i.test(platform)) {
    return { card: "host", platform: "windows", label: "Orbis Host（Windows）", matches: value => value === "windows" };
  }
  if (/Macintosh|Mac OS X/i.test(ua) || /Mac/i.test(platform)) {
    if (arch === "arm" || /arm64|aarch64/i.test(ua)) {
      return { card: "host", platform: "macos-arm64", label: "Orbis Host（macOS · Apple Silicon）", matches: value => value === "macos-arm64" };
    }
    if (arch === "x86") {
      return { card: "host", platform: "macos-x64", label: "Orbis Host（macOS · Intel）", matches: value => value === "macos-x64" };
    }
    return { card: "host", platform: "macos-arm64", label: "Orbis Host（macOS）", hint: "按芯片选择 Apple Silicon 或 Intel", matches: value => value === "macos-arm64" || value === "macos-x64" };
  }
  return undefined;
}

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
    return match && typeof file.url === "string"
      ? [{ ...file, version: match[1] }] : [];
  }).sort((a, b) => compareVersions(a.version, b.version));
}

function renderRecommendation(hostPlatform, appPlatform) {
  const banner = document.getElementById("device-recommendation");
  const hostCard = document.getElementById("host-card");
  const appCard = document.getElementById("app-card");
  const hostTag = document.getElementById("host-recommend");
  const appTag = document.getElementById("app-recommend");
  if (!banner) return;
  if (!deviceRecommendation) {
    banner.hidden = true;
    hostCard?.classList.remove("is-recommended");
    appCard?.classList.remove("is-recommended");
    if (hostTag) hostTag.hidden = true;
    if (appTag) appTag.hidden = true;
    return;
  }
  const badge = document.createElement("span");
  badge.className = "recommend-badge";
  badge.textContent = "当前设备推荐";
  const text = document.createElement("span");
  const strong = document.createElement("strong");
  strong.textContent = deviceRecommendation.label;
  text.append("下载 ", strong);
  if (deviceRecommendation.hint) text.append(`（${deviceRecommendation.hint}）`);
  banner.replaceChildren(badge, text);
  banner.hidden = false;

  const hostMatched = deviceRecommendation.card === "host" && deviceRecommendation.matches(hostPlatform);
  const appMatched = deviceRecommendation.card === "app" && deviceRecommendation.matches(appPlatform);
  hostCard?.classList.toggle("is-recommended", hostMatched);
  appCard?.classList.toggle("is-recommended", appMatched);
  if (hostTag) hostTag.hidden = !hostMatched;
  if (appTag) appTag.hidden = !appMatched;
}

function renderHost(platform) {
  const spec = hostPlatforms[platform];
  const version = document.getElementById("host-version");
  const container = document.getElementById("host-downloads");
  document.getElementById("host-requirement").textContent = spec.requirement;
  container.replaceChildren();
  container.setAttribute("aria-busy", "false");
  if (!siteData) {
    version.textContent = "版本信息暂不可用";
    container.textContent = "暂时无法读取下载信息，请刷新重试或前往 GitHub 版本页。";
    return;
  }
  const releases = hostReleases(platform);
  const latest = releases[0];
  version.textContent = latest ? `预览版 ${latest.version}` : "预览包准备中";
  if (!latest) {
    container.textContent = "该平台的预览包正在准备，发布后即可在这里下载。";
    return;
  }
  const link = document.createElement("a");
  link.className = "button primary";
  link.href = latest.url;
  const size = Number.isFinite(latest.bytes) && latest.bytes > 0 ? `（${(latest.bytes / 1048576).toFixed(0)} MB）` : "";
  link.textContent = `下载 ${platform === "windows" ? "Windows 版" : "macOS 版"}${size}`;
  container.append(link);
}

function renderApp(platform) {
  const spec = appPlatforms[platform];
  const version = document.getElementById("app-version");
  const container = document.getElementById("app-downloads");
  document.getElementById("app-requirement").textContent = spec.requirement;
  container.replaceChildren();
  container.setAttribute("aria-busy", "false");
  if (!siteData) {
    version.textContent = "版本信息暂不可用";
    container.textContent = "暂时无法读取下载信息，请刷新重试或前往 GitHub 版本页。";
    return;
  }
  if (platform === "ios") {
    const url = typeof siteData.ios === "string" && /^https:\/\//.test(siteData.ios) ? siteData.ios : undefined;
    const testFlight = url?.startsWith("https://testflight.apple.com/join/");
    version.textContent = url ? testFlight ? "TestFlight 测试版" : "iOS 安装入口" : "安装入口暂未提供";
    if (!url) {
      container.textContent = "当前发布信息未提供 iOS 安装链接，请留意版本页。";
      return;
    }
    const link = document.createElement("a");
    link.className = "button primary";
    link.href = url;
    link.textContent = testFlight ? "加入 iOS 测试" : "获取 iOS 版";
    container.append(link);
    return;
  }
  if (typeof siteData.android !== "string" || !/^https:\/\//.test(siteData.android)) {
    version.textContent = "安装入口暂未提供";
    container.textContent = "当前发布信息未提供 Android 安装链接。";
    return;
  }
  version.textContent = typeof siteData.androidVersion === "string" ? `预览版 ${siteData.androidVersion}` : "预览版";
  const url = siteData.android;
  const link = document.createElement("a");
  link.className = "button primary";
  link.href = url;
  link.textContent = "下载 Android 版";
  container.append(link);
}

async function loadDownloads() {
  const hostSelect = document.getElementById("host-platform");
  const appSelect = document.getElementById("app-platform");
  if (!hostSelect || !appSelect) return;
  let hostTouched = false;
  let appTouched = false;
  deviceRecommendation = detectDeviceRecommendation();

  function syncRecommendedSelection() {
    if (!deviceRecommendation) return;
    if (deviceRecommendation.card === "app" && !appTouched) {
      appSelect.value = deviceRecommendation.platform;
    }
    if (deviceRecommendation.card === "host" && !hostTouched && (!siteData || hostReleases(deviceRecommendation.platform).length > 0)) {
      if (siteData) hostSelect.value = deviceRecommendation.platform;
    }
  }

  if (deviceRecommendation?.card === "app") appSelect.value = deviceRecommendation.platform;
  renderRecommendation(hostSelect.value, appSelect.value);

  hostSelect.addEventListener("change", () => {
    hostTouched = true;
    renderHost(hostSelect.value);
    renderRecommendation(hostSelect.value, appSelect.value);
  });
  appSelect.addEventListener("change", () => {
    appTouched = true;
    renderApp(appSelect.value);
    renderRecommendation(hostSelect.value, appSelect.value);
  });

  const archPromise = navigator.userAgentData?.getHighEntropyValues?.(["architecture"])
    .then(values => values?.architecture || "")
    .catch(() => "");

  try {
    const response = await fetch("v1/site", { cache: "no-store" });
    if (!response.ok) throw new Error("unavailable");
    siteData = await response.json();
  } catch {
    siteData = undefined;
  }

  const architecture = await Promise.resolve(archPromise);
  if (architecture) deviceRecommendation = detectDeviceRecommendation(navigator, architecture);
  syncRecommendedSelection();
  renderHost(hostSelect.value);
  renderApp(appSelect.value);
  renderRecommendation(hostSelect.value, appSelect.value);
}

async function loadRegistration() {
  const notice = document.getElementById("registration-status");
  try {
    const response = await fetch("v1/registration/status", { cache: "no-store" });
    if (!response.ok) throw new Error("unavailable");
    const data = await response.json();
    notice.textContent = data.enabled ? data.qqEmailVerificationRequired ? "激活已开放，在电脑端使用 QQ 邮箱接收验证码。" : "激活已开放，在电脑端按提示开始。" : "新用户激活暂未开放，请稍后再试。";
    notice.classList.toggle("positive", data.enabled);
  } catch {
    notice.textContent = "暂时无法确认是否可以注册，请稍后重试。";
  }
}

void loadDownloads();
void loadRegistration();

function initWechatGroup() {
  const fab = document.getElementById("wechat-fab");
  if (!fab) return;
  const trigger = fab.querySelector("summary");
  const close = document.getElementById("wechat-close");
  function dismiss() {
    if (!fab.open) return;
    fab.open = false;
    trigger?.focus();
  }
  close?.addEventListener("click", dismiss);
  fab.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.stopPropagation(); dismiss(); }
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && fab.open) dismiss();
  });
  document.addEventListener("pointerdown", event => {
    if (fab.open && !fab.contains(event.target)) fab.open = false;
  });
}

initWechatGroup();

// Preferences are local to this device; the system scheme remains live while selected.
function initAppearance() {
  const root = document.documentElement;
  const menu = document.getElementById("appearance-menu");
  if (!menu) return;
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const follow = document.getElementById("appearance-follow");
  const listeners = new Set();
  let preference = { material: "mist", mode: "system" };
  try {
    const stored = JSON.parse(window.localStorage.getItem("orbis.appearance") || "null");
    if (stored && ["mist", "sage"].includes(stored.material) && ["system", "light", "dark"].includes(stored.mode)) preference = stored;
  } catch { /* A storage-disabled browser still supports appearance for this visit. */ }
  function apply() {
    const dark = preference.mode === "dark" || preference.mode === "system" && system.matches;
    root.dataset.ob = `${preference.material === "sage" ? "sage-" : ""}${dark ? "dark" : "light"}`;
    follow.checked = preference.mode === "system";
    for (const button of menu.querySelectorAll("button[data-mode]")) {
      button.setAttribute("aria-pressed", String(button.dataset.mode === (dark ? "dark" : "light")));
      button.querySelector(".theme-preview").dataset.ob = `${preference.material === "sage" ? "sage-" : ""}${button.dataset.mode}`;
    }
    for (const button of menu.querySelectorAll("button[data-material]")) {
      button.setAttribute("aria-pressed", String(button.dataset.material === preference.material));
      button.querySelector(".theme-preview").dataset.ob = `${button.dataset.material === "sage" ? "sage-" : ""}${dark ? "dark" : "light"}`;
    }
    document.getElementById("appearance-system").textContent = dark ? "深色" : "浅色";
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = window.getComputedStyle(root).getPropertyValue("--surface-base").trim();
    for (const listener of listeners) listener();
  }
  function update(patch) {
    preference = { ...preference, ...patch };
    try { window.localStorage.setItem("orbis.appearance", JSON.stringify(preference)); } catch { /* Session preference is sufficient without storage. */ }
    if (!reduced.matches && document.startViewTransition) document.startViewTransition(apply);
    else apply();
  }
  window.orbisAppearance = { current: () => ({ ...preference, dark: preference.mode === "dark" || preference.mode === "system" && system.matches }), update, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  menu.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (button?.dataset.mode) update({ mode: button.dataset.mode });
    if (button?.dataset.material) update({ material: button.dataset.material });
  });
  follow.addEventListener("change", () => update({ mode: follow.checked ? "system" : system.matches ? "dark" : "light" }));
  system.addEventListener("change", () => { if (preference.mode === "system") apply(); });
  menu.addEventListener("keydown", event => {
    if (event.key === "Escape") { menu.open = false; menu.querySelector("summary").focus(); }
  });
  document.addEventListener("pointerdown", event => { if (!menu.contains(event.target)) menu.open = false; });
  apply();
}

initAppearance();
