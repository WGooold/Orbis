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
