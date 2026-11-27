#!/usr/bin/env python3
"""Render the 9 refreshed Orbis promotional posters matching docs/assets/promo style.

Uses local Google Chrome headless + macOS sips; zero external dependencies.
Reads official Agent SVGs directly from ios/Orbis/Orbis/Assets.xcassets/.
"""

from __future__ import annotations

import base64
import math
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SOURCE_DIR = Path(__file__).resolve().parent
OUT_DIR = SOURCE_DIR.parent
REPO_ROOT = OUT_DIR.parents[2]
ASSETS_DIR = REPO_ROOT / "ios/Orbis/Orbis/Assets.xcassets"
ORBIS_SYMBOL = REPO_ROOT / "packages/relay/src/web/promo/orbis-symbol-2048.png"
CHROME_BIN = os.environ.get(
    "CHROME_PATH",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
)


def data_uri(path: Path) -> str:
    ext = path.suffix.lower()
    mime = {
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
    }.get(ext, "application/octet-stream")
    raw = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{raw}"


AGENTS = [
    {
        "id": "codex",
        "name": "Codex",
        "short": "Codex",
        "tag": "CLI · 桌面版",
        "color": "#00655D",
        "card_color": "#141B24",
        "original": False,
        "svg": ASSETS_DIR / "AgentCodex.imageset/AgentCodex.svg",
    },
    {
        "id": "claude",
        "name": "Claude Code",
        "short": "Claude Code",
        "tag": "终端与项目对话",
        "color": "#9A4521",
        "card_color": "#9A4521",
        "original": True,
        "svg": ASSETS_DIR / "AgentClaude.imageset/AgentClaude.svg",
    },
    {
        "id": "deepseek",
        "name": "DeepSeek",
        "short": "DeepSeek",
        "tag": "CLI · 桌面版",
        "color": "#3550CF",
        "card_color": "#3550CF",
        "original": False,
        "svg": ASSETS_DIR / "AgentDeepSeek.imageset/AgentDeepSeek.svg",
    },
    {
        "id": "pi",
        "name": "Pi",
        "short": "Pi",
        "tag": "轻量扩展接入",
        "color": "#8C3870",
        "card_color": "#8C3870",
        "original": True,
        "svg": ASSETS_DIR / "AgentPi.imageset/AgentPi.svg",
    },
    {
        "id": "kimi",
        "name": "Kimi Code",
        "short": "Kimi Code",
        "tag": "Web · 桌面版",
        "color": "#343B8E",
        "card_color": "#343B8E",
        "original": True,
        "svg": ASSETS_DIR / "AgentKimi.imageset/AgentKimi.svg",
    },
    {
        "id": "opencode",
        "name": "OpenCode",
        "short": "OpenCode",
        "tag": "共享服务同步",
        "color": "#5E4CAD",
        "card_color": "#5E4CAD",
        "original": True,
        "svg": ASSETS_DIR / "AgentOpenCode.imageset/AgentOpenCode.svg",
    },
    {
        "id": "agy",
        "name": "Antigravity",
        "short": "Antigravity CLI",
        "tag": "CLI · ACP 接入",
        "color": "#3569BC",
        "card_color": "#3569BC",
        "original": False,
        "svg": ASSETS_DIR / "AgentAgy.imageset/AgentAgy.svg",
    },
    {
        "id": "hermes",
        "name": "Hermes",
        "short": "Hermes Agent",
        "tag": "Gateway 接入",
        "color": "#765519",
        "card_color": "#765519",
        "original": False,
        "svg": ASSETS_DIR / "AgentHermes.imageset/AgentHermes.svg",
    },
    {
        "id": "openclaw",
        "name": "OpenClaw",
        "short": "OpenClaw",
        "tag": "Gateway 接入",
        "color": "#A93531",
        "card_color": "#A93531",
        "original": True,
        "svg": ASSETS_DIR / "AgentOpenClaw.imageset/AgentOpenClaw.svg",
    },
]

AGENT_MAP = {a["id"]: a for a in AGENTS}
AGENT_URIS = {a["id"]: data_uri(a["svg"]) for a in AGENTS}
ORBIS_URI = data_uri(ORBIS_SYMBOL)


def agent_icon(aid: str, size: int = 20, *, dark_codex: bool = False, mono: str | None = None) -> str:
    a = AGENT_MAP[aid]
    uri = AGENT_URIS[aid]
    if mono is not None:
        return (
            f'<span class="ag-mask" style="width:{size}px;height:{size}px;'
            f"background:{mono};-webkit-mask-image:url('{uri}');mask-image:url('{uri}')\"></span>"
        )
    if a["original"]:
        return f'<img class="ag-img" src="{uri}" style="width:{size}px;height:{size}px" alt="">'
    color = a["card_color"] if dark_codex else a["color"]
    return (
        f'<span class="ag-mask" style="width:{size}px;height:{size}px;'
        f"background:{color};-webkit-mask-image:url('{uri}');mask-image:url('{uri}')\"></span>"
    )


def orbis_mark(size: int = 24, color: str = "currentColor") -> str:
    return (
        f'<span class="ag-mask" style="width:{size}px;height:{size}px;'
        f"background:{color};-webkit-mask-image:url('{ORBIS_URI}');mask-image:url('{ORBIS_URI}')\"></span>"
    )


ICONS = {
    "menu": '<path d="M4 7h16M4 12h16M4 17h16"/>',
    "download": '<path d="M12 4v11m-5-5 5 5 5-5M5 19h14"/>',
    "plus": '<path d="M12 5v14M5 12h14"/>',
    "back": '<path d="M19 12H5m6-6-6 6 6 6"/>',
    "history": '<path d="M3 12a9 9 0 1 0 3-6.7L3 8m0-4v4h4m5 0v4l3 2"/>',
    "desktop": '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 20h8m-4-3v3"/>',
    "lock": '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    "shield": '<path d="M12 3l7 3v5c0 4.6-3 8.4-7 10-4-1.6-7-5.4-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/>',
    "chat_fill": '<path fill="currentColor" stroke="none" d="M4 6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H9.5L5.2 20.4A.7.7 0 0 1 4 19.9V6z"/>',
    "chat": '<path d="M5 6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-4 3v-3a2 2 0 0 1 0-10z"/>',
    "tune": '<path d="M4 7h16M4 12h16M4 17h16"/><circle cx="9" cy="7" r="2" fill="currentColor"/><circle cx="15" cy="12" r="2" fill="currentColor"/><circle cx="10" cy="17" r="2" fill="currentColor"/>',
    "gear": '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.2a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3h.1a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8v.1a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.4 1z"/>',
    "refresh": '<path d="M20 12a8 8 0 1 1-2.3-5.6L20 8.5M20 4v4.5h-4.5"/>',
    "check": '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    "paperclip": '<path d="m8.5 13.5 6.8-6.8a2.8 2.8 0 0 1 4 4L10 20a4.6 4.6 0 0 1-6.5-6.5l9.3-9.3a1.8 1.8 0 0 1 2.6 2.6l-8.5 8.5"/>',
    "up": '<path d="M12 19V5m-6 6 6-6 6 6"/>',
    "folder": '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>',
    "globe": '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a13 13 0 0 1 0 18M12 3a13 13 0 0 0 0 18"/>',
    "image": '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 15l-4.5-4.5L8 19"/>',
    "video": '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path fill="currentColor" stroke="none" d="M10 9.2v5.6l5-2.8z"/>',
    "doc": '<path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
    "expand": '<path d="M15 4h5v5M9 20H4v-5M20 4l-6 6M4 20l6-6"/>',
    "chev_down": '<path d="M6 9l6 6 6-6"/>',
    "chev_up": '<path d="M6 15l6-6 6 6"/>',
    "chev_right": '<path d="M9 6l6 6-6 6"/>',
    "chev_left": '<path d="M15 6l-6 6 6 6"/>',
    "close": '<path d="M6 6l12 12M18 6L6 18"/>',
    "terminal": '<path d="M5 7l5 5-5 5M12 17h7"/>',
    "share": '<path d="M12 15V4m-4 4 4-4 4 4M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>',
    "bell": '<path d="M18 15H6c1.2-1.2 1.8-2.6 1.8-5a4.2 4.2 0 1 1 8.4 0c0 2.4.6 3.8 1.8 5z"/><path d="M10 18.5a2.2 2.2 0 0 0 4 0"/>',
    "stack": '<rect x="7" y="3" width="14" height="14" rx="2"/><path d="M16 21H5a2 2 0 0 1-2-2V8"/>',
    "arrow_ne": '<path d="M7 17L17 7M9 7h8v8"/>',
    "flash": '<path d="M9 3h6v4l-1.5 2.5V21h-3V9.5L9 7V3z"/>',
    "camera": '<rect x="3" y="7" width="18" height="13" rx="2.5"/><path d="M8 7l1.5-3h5L16 7"/><circle cx="12" cy="13.5" r="3.2"/>',
    "phone": '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>',
    "wifi": '<path d="M3 9a13 13 0 0 1 18 0M6.5 12.5a8.5 8.5 0 0 1 11 0M10 16a3.5 3.5 0 0 1 4 0"/><circle cx="12" cy="19" r="1" fill="currentColor" stroke="none"/>',
    "edit": '<path d="M4 20h4l11-11-4-4L4 16v4z"/>',
    "warning_doc": '<path d="M6 4h9l3 3v13H6z"/><path d="M10 11h4m-4 4h2"/>',
}


def svg_ico(name: str, size: int = 16, color: str = "currentColor", sw: float = 1.9) -> str:
    return (
        f'<svg class="svg-ico" width="{size}" height="{size}" viewBox="0 0 24 24" '
        f'fill="none" stroke="{color}" stroke-width="{sw}" stroke-linecap="round" '
        f'stroke-linejoin="round" aria-hidden="true">{ICONS[name]}</svg>'
    )


def status_bar(island_html: str = "", island_cls: str = "", hide_time: bool = False) -> str:
    time_cls = ' style="opacity:0"' if hide_time else ""
    return f"""
    <div class="ios-status">
      <span class="ios-time"{time_cls}>9:41</span>
      <div class="ios-island {island_cls}">{island_html}</div>
      <div class="ios-indicators">
        <span class="sig"><i></i><i></i><i></i><i></i></span>
        {svg_ico("wifi", 12, "currentColor", 2.1)}
        <span class="bat"><i></i></span>
      </div>
    </div>"""


def phone_frame(screen_html: str, *, style: str, cls: str = "", screen_cls: str = "") -> str:
    return f"""
    <div class="phone-wrap {cls}" style="{style}">
      <i class="btn-mute"></i>
      <i class="btn-vol1"></i>
      <i class="btn-vol2"></i>
      <i class="btn-pwr"></i>
      <div class="phone-screen {screen_cls}">
        {screen_html}
        <div class="ios-home-bar"><i></i></div>
      </div>
    </div>"""


def tab_bar(active: str = "chat") -> str:
    items = [
        ("chat", "chat_fill" if active == "chat" else "chat", "聊天"),
        ("agent", "tune", "Agent"),
        ("settings", "gear", "设置"),
    ]
    cols = []
    for key, ico, label in items:
        cls = "tab-item is-active" if key == active else "tab-item"
        cols.append(f'<div class="{cls}">{svg_ico(ico, 16)}<span>{label}</span></div>')
    return f'<div class="orbis-tabs">{"".join(cols)}</div>'


def session_card(aid: str, title: str, path: str, agent_label: str, status_text: str, status_kind: str = "idle") -> str:
    color = AGENT_MAP[aid]["color"]
    dot_cls = {
        "running": "sdot running",
        "approval": "sdot approval",
        "idle": "sdot idle",
    }[status_kind]
    return f"""
    <div class="sess-card">
      <div class="sess-ico">{agent_icon(aid, 18)}</div>
      <div class="sess-meta">
        <div class="sess-title">{title}</div>
        <div class="sess-path">{path}</div>
        <div class="sess-sub"><b style="color:{color}">{agent_label}</b> <i class="{dot_cls}"></i> <span>{status_text}</span></div>
      </div>
    </div>"""


def home_screen(cards: list[tuple[str, str, str, str, str, str]], conn_label: str = "局域网") -> str:
    cards_html = "".join(session_card(*c) for c in cards)
    return f"""
    {status_bar()}
    <div class="app-home">
      <div class="home-top">
        <span class="neu-circle">{svg_ico("menu", 15, "#3b475a")}</span>
        <div class="home-brand">
          <b>Orbis</b>
          <span>Nothing But the Remote</span>
        </div>
        <div class="home-actions">
          <span class="neu-circle">{svg_ico("download", 14, "#3b475a")}</span>
          <span class="neu-circle">{svg_ico("plus", 15, "#3b475a")}</span>
        </div>
      </div>
      <div class="home-host-row">
        <span class="host-name">{svg_ico("desktop", 14, "#4e5c72")}<b>workstation</b></span>
        <span class="conn-pill"><i class="conn-dot"></i>{conn_label}{svg_ico("lock", 10, "#1a6a4d", 2.2)}</span>
      </div>
      <div class="home-list">{cards_html}</div>
      {tab_bar("chat")}
    </div>"""


def poster_shell(
    *,
    eyebrow: str,
    line1: str,
    line2: str,
    subtitle: str,
    content_html: str,
    orbit_style: str = "left:268px;top:318px;width:650px;height:650px;",
    orbit_dot: bool = True,
    show_demo_note: bool = True,
) -> str:
    dot = '<i class="orbit-node"></i>' if orbit_dot else ""
    demo = '<div class="footer-demo">界面演示 · 示例内容</div>' if show_demo_note else ""
    return f"""
    <article class="poster">
      <div class="poster-frame" aria-hidden="true"></div>
      <div class="poster-orbit" style="{orbit_style}" aria-hidden="true">
        <i class="ring r1"></i><i class="ring r2"></i><i class="ring r3"></i>{dot}
      </div>
      <header class="poster-brand">{orbis_mark(25, "#1b2535")}<span>Orbis</span></header>
      <div class="poster-head">
        <div class="eyebrow">{eyebrow}</div>
        <h1 class="headline"><span>{line1}</span><em>{line2}</em></h1>
        <p class="subtitle">{subtitle}</p>
      </div>
      {content_html}
      <footer class="poster-footer">
        <div class="footer-line">完全免费 · Windows / Mac / Android / iOS</div>
        {demo}
      </footer>
    </article>"""


# ---------------------------------------------------------------------------
# Poster 01: Hero Cover (Updated to 9 Agents + current UI)
# ---------------------------------------------------------------------------
def build_poster_01() -> tuple[str, str]:
    cards = [
        ("deepseek", "优化首页交互与动画", "/Projects/orbis", "DeepSeek", "运行中", "running"),
        ("codex", "整理新版本发布说明", "/Projects/orbis", "Codex 终端版", "空闲", "idle"),
        ("claude", "实现项目仪表盘界面", "/Projects/orbis", "Claude Code", "等待审批", "approval"),
        ("kimi", "生成季度产品原型页", "/Projects/website", "Kimi Code Web", "空闲", "idle"),
        ("opencode", "补齐端到端测试脚本", "/Projects/orbis", "OpenCode", "空闲", "idle"),
    ]
    pill_row1 = "".join(
        f'<span class="p1-ag-dot">{agent_icon(a["id"], 17, dark_codex=(a["id"] == "codex"))}</span>'
        for a in AGENTS[:5]
    )
    pill_row2 = "".join(
        f'<span class="p1-ag-dot">{agent_icon(a["id"], 17)}</span>'
        for a in AGENTS[5:]
    )
    content = f"""
    <div class="left-col p1-left">
      <div class="accent-bar"></div>
      <h2 class="left-title">电脑上的任务<br>手机里继续</h2>
      <p class="left-desc">把灵感、进度与对话<br>带进每一个日常片刻。</p>
      <div class="p1-agent-pill">
        <div class="p1-agent-rows">
          <div class="p1-agent-row">{pill_row1}</div>
          <div class="p1-agent-row">{pill_row2}</div>
        </div>
        <div class="p1-agent-copy">
          <small>9 位 Agent</small>
          <b>一个 Orbis</b>
        </div>
      </div>
      <div class="micro-cap">CONNECTED TO YOUR COMPUTER</div>
    </div>
    {phone_frame(home_screen(cards), style="left:436px;top:336px;width:368px;height:738px;transform:rotate(4.5deg)")}
    """
    return (
        "01-agents-everywhere",
        poster_shell(
            eyebrow="YOUR AGENTS, WITH YOU.",
            line1="手机在手",
            line2="Agent 随行",
            subtitle="从手机连接电脑上的 Agent",
            content_html=content,
            orbit_style="left:264px;top:324px;width:650px;height:650px;",
        ),
    )


# ---------------------------------------------------------------------------
# Poster 02: 9 Supported Agents (12 modes)
# ---------------------------------------------------------------------------
def build_poster_02() -> tuple[str, str]:
    grid_cards = []
    for idx, a in enumerate(AGENTS, start=1):
        grid_cards.append(
            f"""
            <div class="p2-tile">
              <span class="p2-num">{idx:02d}</span>
              <div class="p2-ico">{agent_icon(a["id"], 22, dark_codex=(a["id"] == "codex"))}</div>
              <b style="color:{a['color']}">{a['name']}</b>
              <small>{a['tag']}</small>
            </div>"""
        )
    cards = [
        ("codex", "重构构建缓存流水线", "/Projects/orbis", "Codex 桌面版", "运行中", "running"),
        ("claude", "排查音频流断连问题", "/Projects/orbis", "Claude Code", "等待审批", "approval"),
        ("kimi", "完善活动落地页排版", "/Projects/website", "Kimi Code 桌面版", "运行中", "running"),
        ("agy", "验证 ACP 协议兼容层", "/Projects/orbis", "Antigravity CLI", "空闲", "idle"),
        ("openclaw", "巡检定时任务与日志", "/Projects/ops", "OpenClaw", "空闲", "idle"),
    ]
    content = f"""
    <div class="p2-left">
      <div class="p2-grid">{"".join(grid_cards)}</div>
      <div class="p2-summary-pill">
        <i class="dot-blue"></i>
        <span>覆盖 CLI · 桌面版 · Web · Gateway，共 <b>12 种接入形态</b></span>
      </div>
    </div>
    {phone_frame(home_screen(cards), style="left:476px;top:350px;width:348px;height:698px;transform:rotate(4deg)")}
    <div class="p2-phone-cap">不同 Agent，会话统一管理。</div>
    """
    return (
        "02-nine-agents",
        poster_shell(
            eyebrow="ONE PLACE. NINE AGENTS.",
            line1="九位搭档",
            line2="一处掌控",
            subtitle='<span class="sub-compact">Codex · Claude Code · DeepSeek · Pi · Kimi Code · OpenCode · Antigravity · Hermes · OpenClaw</span>',
            content_html=content,
            orbit_style="left:338px;top:356px;width:580px;height:580px;",
            orbit_dot=False,
        ),
    )


# ---------------------------------------------------------------------------
# Poster 03: Upgraded Agent & Provider Dual-Ring Dial (with Pin Groove!)
# ---------------------------------------------------------------------------
def build_agent_dial_screen() -> str:
    # Exact concentric geometry scaled cleanly inside 350px screen width
    w, h = 350, 318
    cx, cy = -58, 158
    r_out = 210
    r_seam = 136
    r_hub = 116
    r_hole = 46
    r_agent = 81
    pin_start = cx + r_agent  # 23
    pin_travel = (r_hub + 20) - r_agent  # 55
    pin_socket_x = pin_start + pin_travel  # 78

    # 120 ticks on outer ring
    ticks = []
    for i in range(-45, 46):
        deg = i * 3
        rad = math.radians(deg)
        major = i % 6 == 0
        mid = i % 2 == 0
        length = 12 if major else (8 if mid else 4.5)
        r1 = r_out - 8 - length
        r2 = r_out - 8
        x1, y1 = cx + r1 * math.cos(rad), cy + r1 * math.sin(rad)
        x2, y2 = cx + r2 * math.cos(rad), cy + r2 * math.sin(rad)
        alpha = 0.72 if major else 0.42
        ticks.append(
            f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
            f'stroke="#737d90" stroke-opacity="{alpha}" stroke-width="1"/>'
        )

    # Hub dots
    hdots = []
    for i in range(-36, 37):
        rad = math.radians(i * 4.5)
        hx = cx + (r_hub - 7) * math.cos(rad)
        hy = cy + (r_hub - 7) * math.sin(rad)
        if hx > 0:
            hdots.append(f'<circle cx="{hx:.1f}" cy="{hy:.1f}" r="1.2" fill="#737d90" fill-opacity="0.48"/>')

    # Provider dots on outer ring (-1, 0, +1, +2)
    pdots = []
    for idx, active_p in [(0, True), (1, False), (2, False), (-1, False)]:
        rad = math.radians(idx * 20)
        px = cx + (r_out - 28) * math.cos(rad)
        py = cy + (r_out - 28) * math.sin(rad)
        fill = "#1a6a4d" if active_p else "#8995a9"
        rad_dot = 3.2 if active_p else 2.5
        pdots.append(f'<circle cx="{px:.1f}" cy="{py:.1f}" r="{rad_dot}" fill="{fill}"/>')

    # Outer pointer dot
    ptr_x, ptr_y = cx + r_out + 8, cy
    svg_dial = f"""
    <svg class="dial-svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">
      {''.join(ticks)}
      {''.join(hdots)}
      {''.join(pdots)}
      <circle cx="{ptr_x:.1f}" cy="{ptr_y:.1f}" r="3.4" fill="#00655D"/>
    </svg>"""

    # Inner ring agents (with docked Codex slid out into the socket!)
    # Slots around 0: -2=pi, -1=claude, 0=codex (docked & slid out!), +1=codexDesktop, +2=deepseek, +3=kimi
    ring_items = [
        (-2, "pi", True, None, "success"),
        (-1, "claude", True, None, "success"),
        (0, "codex", True, "terminal", "success"),
        (1, "codex", True, "desktop", "success"),
        (2, "deepseek", True, "terminal", "success"),
        (3, "kimi", False, "web", "off"),
    ]
    beads = []
    for dist, aid, enabled, variant, tone in ring_items:
        if dist == 0:
            bx, by = pin_socket_x, cy
            bead_cls = "dial-bead is-docked"
        else:
            rad = math.radians(dist * 26)
            bx = cx + r_agent * math.cos(rad)
            by = cy + r_agent * math.sin(rad)
            bead_cls = "dial-bead" + (" is-off" if not enabled else "")
        if bx < 10:
            continue
        badge = ""
        if variant:
            vico = "terminal" if variant == "terminal" else ("desktop" if variant == "desktop" else "globe")
            badge = f'<span class="bead-var">{svg_ico(vico, 8, "#4a5364", 2.3)}</span>'
        sdot = '<i class="bead-dot"></i>' if enabled else ""
        beads.append(
            f'<div class="{bead_cls}" style="left:{bx:.1f}px;top:{by:.1f}px">'
            f'<span class="bead-cap"></span>'
            f'{agent_icon(aid, 18)}'
            f'{sdot}{badge}</div>'
        )

    # Outer profile labels
    lbl_x = cx + r_out + 24  # 176
    return f"""
    {status_bar()}
    <div class="app-dial">
      <div class="dial-hdr">
        <b>Agent</b>
        <span class="neu-circle sm">{svg_ico("refresh", 13, "#4a5364")}</span>
      </div>
      <div class="dial-host-row">
        <span class="host-name">{svg_ico("desktop", 13, "#4e5c72")}<b>workstation</b></span>
        <span class="dial-count">9 / 12 已启用</span>
      </div>
      <div class="dial-stage">
        <div class="disc disc-out" style="left:{cx - r_out}px;top:{cy - r_out}px;width:{r_out*2}px;height:{r_out*2}px"></div>
        <div class="disc disc-seam" style="left:{cx - r_seam}px;top:{cy - r_seam}px;width:{r_seam*2}px;height:{r_seam*2}px"></div>
        <div class="disc disc-hub" style="left:{cx - r_hub}px;top:{cy - r_hub}px;width:{r_hub*2}px;height:{r_hub*2}px"></div>
        <div class="disc disc-hole" style="left:{cx - r_hole}px;top:{cy - r_hole}px;width:{r_hole*2}px;height:{r_hole*2}px"></div>
        {svg_dial}
        <div class="pin-groove" style="left:{pin_start - 21}px;top:{cy - 21}px;width:{pin_travel + 42}px;height:42px">
          <span class="pin-socket"></span>
        </div>
        {''.join(beads)}
        <div class="prof-lbl is-dim" style="left:{lbl_x - 8}px;top:{cy - 86}px"><span>openai-direct</span></div>
        <div class="prof-lbl is-sel" style="left:{lbl_x}px;top:{cy - 44}px">
          <small class="pl-agent">Codex CLI</small>
          <strong>本机配置</strong>
          <span class="pl-sub">官方 · 2 个运行中</span>
          <span class="pl-use">{svg_ico("check", 10, "#1a6a4d", 2.5)} 使用中</span>
        </div>
        <div class="prof-lbl is-dim" style="left:{lbl_x - 8}px;top:{cy + 62}px"><span>relay-b</span></div>
        <div class="prof-lbl is-faint" style="left:{lbl_x - 32}px;top:{cy + 114}px"><span>openrouter</span></div>
      </div>
      <div class="dial-foot">
        <div class="quota-pair">
          <div class="q-item">
            <span class="q-lbl">5 小时</span>
            <b class="q-val">86<small>%</small></b>
            <div class="q-bar"><i style="width:86%"></i></div>
            <span class="q-reset">2 小时 14 分后重置</span>
          </div>
          <div class="q-item">
            <span class="q-lbl">7 天</span>
            <b class="q-val">41<small>%</small></b>
            <div class="q-bar"><i style="width:41%"></i></div>
            <span class="q-reset">11 月 29 日 09:00 重置</span>
          </div>
        </div>
        <div class="dial-btn">{svg_ico("check", 13, "#4a5364", 2.2)}<span>正在使用 本机配置</span></div>
        <div class="dial-pos"><span>向外推启用 · 向内拉停用</span><b>1 / 4</b></div>
      </div>
      {tab_bar("agent")}
    </div>"""


def build_poster_03() -> tuple[str, str]:
    icons_row1 = "".join(
        f'<span class="p3-mini-ag">{agent_icon(a["id"], 19, dark_codex=(a["id"] == "codex"))}</span>'
        for a in AGENTS[:5]
    )
    icons_row2 = "".join(
        f'<span class="p3-mini-ag">{agent_icon(a["id"], 19)}</span>'
        for a in AGENTS[5:]
    )
    content = f"""
    <div class="left-col p3-left">
      <div class="sec-kicker">INNER RING · LATCH</div>
      <h2 class="sec-h2">内圈选 Agent<br>滑销即刻启停</h2>
      <div class="p3-icons-stack">
        <div class="p3-icons-row">{icons_row1}</div>
        <div class="p3-icons-row">{icons_row2}</div>
      </div>
      <p class="sec-copy">9 大 Agent 同盘收拢，<br>拨动滑销即可远程启停。</p>

      <div class="sec-kicker" style="margin-top:34px">OUTER RING</div>
      <h2 class="sec-h2">外圈切配置</h2>
      <p class="sec-copy">转动、停靠、确认。<br>供应商与当前状态，一眼可见。</p>

      <div class="neu-pill-card" style="margin-top:34px">
        <i class="dot-green"></i><span>配额余量，随手查看</span>
      </div>
    </div>
    <svg class="p3-guide-arc" viewBox="0 0 900 1200" width="900" height="1200" aria-hidden="true">
      <path d="M 304 510 Q 406 530 538 614" fill="none" stroke="#89a1c4" stroke-width="1.3" stroke-dasharray="4 5" opacity="0.65"/>
      <circle cx="540" cy="615" r="4" fill="#00655D" opacity="0.72"/>
    </svg>
    {phone_frame(build_agent_dial_screen(), style="left:438px;top:346px;width:368px;height:732px;transform:rotate(4deg)")}
    """
    return (
        "03-agent-dial",
        poster_shell(
            eyebrow="A TURN. FULL CONTROL.",
            line1="轻轻一转",
            line2="启停与切换",
            subtitle="用双层转盘与启停滑销，管理 Agent 与配置。",
            content_html=content,
            orbit_style="left:266px;top:338px;width:640px;height:640px;",
            orbit_dot=False,
        ),
    )


# ---------------------------------------------------------------------------
# Poster 04: Tool Approval (faithful to original 05-approval.jpg)
# ---------------------------------------------------------------------------
def build_approval_screen() -> str:
    return f"""
    {status_bar()}
    <div class="app-chat">
      <div class="chat-hdr">
        <span class="neu-circle sm">{svg_ico("back", 14, "#4a5364")}</span>
        <div class="chat-ttl">
          <div>{agent_icon("claude", 15)}<b>修首页下拉回弹</b></div>
          <small><i class="sdot running"></i>运行中</small>
        </div>
        <span class="neu-circle sm">{svg_ico("history", 13, "#4a5364")}</span>
        <span class="neu-circle sm">{svg_ico("download", 13, "#4a5364")}</span>
      </div>
      <div class="chat-body">
        <div class="msg-asst">
          <pre class="mini-tree">      └ ConnectionPill
└ HomePullRefresh.onEnded
   └ withAnimation(.linear)
      └ offset = 0  ← 线性收回</pre>
          <p>下拉 120pt 时每秒要重新测量 60 次，24 张会话卡都会参与布局；松手时又用线性动画收回，所以手感发涩。</p>
          <p>建议把测量挪到下拉开始时只做一次，回弹交给弹簧动画，超出部分按橡皮筋曲线收回。要我直接改吗？</p>
        </div>
        <div class="msg-user">按你说的改，顺便补个测试</div>
        <div class="tool-chip">
          <span>{svg_ico("edit", 12, "#4a5364")}<b>Edit</b> HomePullRefresh.swift</span>
          <em class="ok">已完成</em>
        </div>
        <div class="appr-card">
          <div class="appr-top">
            <span>{svg_ico("warning_doc", 13, "#9A4521")}<b>允许 Claude 使用 Bash?</b></span>
            <em>待确认</em>
          </div>
          <p>Claude Code 请求工具权限。</p>
          <pre>{{"command":"swift test --filter\n  HomePullRefreshTests"}}</pre>
          <div class="appr-btns">
            <span class="btn-deny">拒绝</span>
            <span class="btn-allow">{svg_ico("check", 12, "#9A4521", 2.4)} 允许</span>
          </div>
        </div>
      </div>
      <div class="chat-comp">
        <div class="comp-meta">
          <span>{svg_ico("folder", 11, "#5c687c")}/Projects/orbis</span>
          <b style="color:#9A4521">工作区写入</b>
        </div>
        <div class="comp-row">
          <span class="neu-circle xs" style="color:#9A4521">{svg_ico("paperclip", 13, "#9A4521")}</span>
          <div class="comp-in">发给 Claude Code，/ 命令</div>
          <span class="neu-circle xs muted">{svg_ico("up", 13, "#8b96a9")}</span>
        </div>
      </div>
    </div>"""


def build_poster_04() -> tuple[str, str]:
    content = f"""
    <div class="left-col p4-left">
      <div class="sec-kicker">REQUEST DETAILS</div>
      <h2 class="sec-h2">审批内容<br>完整展开</h2>

      <div class="p4-float-card">
        <div class="appr-top">
          <span>{svg_ico("warning_doc", 14, "#9A4521")}<b>允许 Claude 使用 Bash?</b></span>
          <em>待确认</em>
        </div>
        <p>Claude Code 请求工具权限。</p>
        <pre>{{"command":"swift test --filter\n  HomePullRefreshTests"}}</pre>
        <div class="appr-btns">
          <span class="btn-deny">拒绝</span>
          <span class="btn-allow">{svg_ico("check", 13, "#9A4521", 2.4)} 允许</span>
        </div>
      </div>

      <div class="p4-feedback-lbl">确认后，状态即时反馈</div>
      <div class="p4-feedback-pill">
        {agent_icon("claude", 15)}<span>已允许</span>
      </div>
    </div>
    {phone_frame(build_approval_screen(), style="left:438px;top:338px;width:368px;height:742px;transform:rotate(3.5deg)")}
    """
    return (
        "04-approval",
        poster_shell(
            eyebrow="YOUR DECISION. THEN THE NEXT STEP.",
            line1="该你决定",
            line2="才继续执行",
            subtitle="审批请求到手机，查看后允许或拒绝。",
            content_html=content,
            orbit_style="left:286px;top:350px;width:610px;height:610px;",
            orbit_dot=False,
        ),
    )


# ---------------------------------------------------------------------------
# Poster 05: Review Changes / Turn File Diffs (faithful to original 06-review-changes.jpg)
# ---------------------------------------------------------------------------
def diff_screen(file_name: str, folder: str, adds: int, dels: int, hunk: str, rows: list[tuple[str, str, str, str]], page_text: str) -> str:
    lines = []
    for ln1, ln2, kind, code in rows:
        sign = "+" if kind == "add" else ("-" if kind == "del" else " ")
        lines.append(
            f'<div class="dline d-{kind}"><span class="dln">{ln1}</span><span class="dln">{ln2}</span>'
            f'<span class="dsgn">{sign}</span><code>{code}</code></div>'
        )
    return f"""
    {status_bar()}
    <div class="app-diff">
      <div class="diff-hdr">
        <span class="neu-circle sm">{svg_ico("back", 14, "#4a5364")}</span>
        <b>本轮文件差异</b>
      </div>
      <div class="diff-file-bar">
        <div>
          <span class="tag-mod">修改</span><b>{file_name}</b>
          <div class="diff-dir">{folder}</div>
        </div>
        <div class="diff-stat"><i class="add">+{adds}</i> <i class="del">-{dels}</i></div>
      </div>
      <div class="diff-box">
        <div class="dhunk">{hunk}</div>
        {''.join(lines)}
      </div>
      <div class="diff-pager">
        <span class="neu-circle xs">{svg_ico("chev_left", 13, "#4a5364")}</span>
        <b>{page_text}</b>
        <span class="neu-circle xs">{svg_ico("chev_right", 13, "#4a5364")}</span>
      </div>
    </div>"""


def build_poster_05() -> tuple[str, str]:
    left_rows = [
        ("42", "42", "ctx", "var offset: CGFloat = 0"),
        ("", "43", "add", "var cachedHeight: CGFloat = 0"),
        ("43", "44", "ctx", ""),
        ("", "45", "add", "func onBegan() {"),
        ("", "46", "add", "  cachedHeight = measureList()"),
        ("", "47", "add", "}"),
        ("44", "48", "ctx", "func onChanged(_ v: Value) {"),
        ("45", "", "del", "  let h = measureList()"),
        ("46", "", "del", "  offset = band(v.y, h)"),
        ("", "49", "add", "  offset = band(v.y, cachedHeight)"),
        ("47", "50", "ctx", "}"),
        ("48", "51", "ctx", "func onEnded() {"),
        ("49", "", "del", "  withAnimation(.linear) {"),
        ("", "52", "add", "  withAnimation(.orbisDrag) {"),
        ("50", "53", "ctx", "    offset = 0"),
        ("51", "54", "ctx", "  }"),
        ("52", "55", "ctx", "}"),
    ]
    right_rows = [
        ("598", "598", "ctx", "ScrollView {"),
        ("599", "", "del", "  .refreshable { await refresh() }"),
        ("", "599", "add", "  HomePullRefresh(onRefresh: {"),
        ("", "600", "add", "    store.refresh()"),
        ("", "601", "add", "  })"),
        ("600", "602", "ctx", "  LazyVStack(spacing: 14) {"),
        ("601", "603", "ctx", "    ForEach(sessions) { s in"),
        ("602", "", "del", "      SessionCard(s)"),
        ("", "604", "add", "      SessionCard(s).id(s.id)"),
        ("603", "605", "ctx", "    }"),
        ("604", "606", "ctx", "  }"),
    ]
    left_phone = diff_screen(
        "HomePullRefresh.swift", "ios/Orbis/Orbis/", 18, 7,
        "@@ -42,9 +42,14 @@ struct HomePullRefresh", left_rows, "1 / 3",
    )
    right_phone = diff_screen(
        "ContentView.swift", "ios/Orbis/Orbis/", 9, 4,
        "@@ -598,7 +598,12 @@ HomeView", right_rows, "2 / 3",
    )
    content = f"""
    <div class="p5-file-pill">
      <span>{svg_ico("folder", 15, "#232a36")}<code>HomePullRefresh.swift</code></span>
      <span class="diff-stat"><i class="add">+18</i> <i class="del">-7</i></span>
    </div>
    {phone_frame(left_phone, style="left:68px;top:454px;width:304px;height:604px;transform:rotate(-2.4deg)", cls="phone-compact")}
    {phone_frame(right_phone, style="left:454px;top:364px;width:358px;height:714px;transform:rotate(3.4deg)")}
    <div class="p5-bottom-hint"><span>01</span><i></i><span>02</span><em>← 左右切换文件 →</em></div>
    """
    return (
        "05-review-changes",
        poster_shell(
            eyebrow="EVERY CHANGE, IN VIEW.",
            line1="每一处改动",
            line2="看得清楚",
            subtitle="文件差异，随手翻阅。",
            content_html=content,
            orbit_style="left:170px;top:370px;width:600px;height:600px;",
            orbit_dot=False,
        ),
    )


# ---------------------------------------------------------------------------
# Poster 06: Rich In-Chat File Preview (Images, Videos, HTML, PDF, Markdown)
# ---------------------------------------------------------------------------
def build_preview_screen() -> str:
    return f"""
    {status_bar()}
    <div class="app-chat">
      <div class="chat-hdr">
        <span class="neu-circle sm">{svg_ico("back", 14, "#4a5364")}</span>
        <div class="chat-ttl">
          <div>{agent_icon("codex", 15)}<b>发布页与动效产物</b></div>
          <small><i class="sdot idle"></i>空闲 <span>GPT-5.4 · high</span></small>
        </div>
        <span class="neu-circle sm">{svg_ico("history", 13, "#4a5364")}</span>
        <span class="neu-circle sm">{svg_ico("download", 13, "#4a5364")}</span>
      </div>
      <div class="chat-body p6-chat-body">
        <div class="msg-asst">
          <div class="asst-id">{agent_icon("codex", 13)}<b style="color:#00655D">Codex</b></div>
          <p>已导出交互报告页、高清渲染图与录屏，点击卡片即可在对话内直接预览：</p>
          <div class="pv-card-row">
            <div class="pv-main is-open">
              {svg_ico("globe", 13, "#2f5287")}
              <b>launch-report.html</b>
              <span>184 KB</span>
              {svg_ico("chev_up", 11, "#737d90")}
            </div>
            <span class="pv-dl">{svg_ico("download", 12, "#4a5364")}</span>
          </div>
          <div class="pv-html-box">
            <span class="pv-expand">{svg_ico("expand", 10, "#4a5364", 2.2)}</span>
            <div class="mini-web">
              <div class="mw-top">
                <span class="mw-badge">Orbis v0.1.25</span>
                <em>离线安全渲染</em>
              </div>
              <div class="mw-kpis">
                <div><small>首屏渲染</small><b>142 ms</b></div>
                <div><small>回归通过</small><b style="color:#1a6a4d">99.8%</b></div>
                <div><small>端到端</small><b style="color:#2f5287">AEAD</b></div>
              </div>
              <svg class="mw-chart" viewBox="0 0 240 58" width="100%" height="52">
                <defs>
                  <linearGradient id="cg" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#2f5287" stop-opacity="0.28"/>
                    <stop offset="100%" stop-color="#2f5287" stop-opacity="0.02"/>
                  </linearGradient>
                </defs>
                <path d="M0 44 L34 38 L68 41 L102 27 L136 22 L170 25 L204 12 L240 8 L240 58 L0 58 Z" fill="url(#cg)"/>
                <path d="M0 44 L34 38 L68 41 L102 27 L136 22 L170 25 L204 12 L240 8" fill="none" stroke="#2f5287" stroke-width="2.2" stroke-linecap="round"/>
                <circle cx="204" cy="12" r="3.4" fill="#2f5287"/>
                <circle cx="240" cy="8" r="3.4" fill="#1a6a4d"/>
              </svg>
            </div>
          </div>
          <div class="pv-card-row">
            <div class="pv-main is-open">
              {svg_ico("image", 13, "#8C3870")}
              <b>hero-banner.png</b>
              <span>1.6 MB</span>
              {svg_ico("chev_up", 11, "#737d90")}
            </div>
            <span class="pv-dl">{svg_ico("download", 12, "#4a5364")}</span>
          </div>
          <div class="pv-img-thumb">
            <span class="pv-expand">{svg_ico("expand", 9, "#4a5364", 2.2)}</span>
            <div class="pv-art">
              <div class="pv-art-ring"></div>
              <div class="pv-art-pill">{orbis_mark(15, "#ffffff")}<span>Orbis · 4× 缩放查看</span></div>
            </div>
          </div>
          <div class="pv-card-row">
            <div class="pv-main">
              {svg_ico("video", 13, "#3550CF")}
              <b>refresh-demo.mp4</b>
              <span>4.2 MB</span>
              {svg_ico("chev_down", 11, "#737d90")}
            </div>
            <span class="pv-dl">{svg_ico("download", 12, "#4a5364")}</span>
          </div>
        </div>
      </div>
      <div class="chat-comp">
        <div class="comp-meta">
          <span>{svg_ico("folder", 11, "#5c687c")}/Projects/orbis</span>
          <b style="color:#00655D">工作区写入</b>
        </div>
        <div class="comp-row">
          <span class="neu-circle xs" style="color:#00655D">{svg_ico("paperclip", 13, "#00655D")}</span>
          <div class="comp-in">发给 Codex，/ 命令</div>
          <span class="neu-circle xs muted">{svg_ico("up", 13, "#8b96a9")}</span>
        </div>
      </div>
    </div>"""


def build_poster_06() -> tuple[str, str]:
    content = f"""
    <div class="left-col p6-left">
      <div class="sec-kicker">RICH PREVIEW</div>
      <h2 class="sec-h2">点开即看<br>全屏也能交互</h2>

      <div class="p6-format-grid">
        <div class="p6-fmt">{svg_ico("globe", 16, "#2f5287")}<div><b>HTML / SVG</b><small>离线安全渲染</small></div></div>
        <div class="p6-fmt">{svg_ico("image", 16, "#8C3870")}<div><b>PNG / JPG</b><small>双指 4× 缩放</small></div></div>
        <div class="p6-fmt">{svg_ico("video", 16, "#3550CF")}<div><b>MP4 视频</b><small>原生全屏播放</small></div></div>
        <div class="p6-fmt">{svg_ico("doc", 16, "#9A4521")}<div><b>PDF / 文本</b><small>逐页翻阅下载</small></div></div>
      </div>

      <div class="p6-media-card">
        <div class="p6-media-head">
          <span>{svg_ico("video", 13, "#3550CF")}<b>refresh-demo.mp4</b></span>
          <small>全屏播放</small>
        </div>
        <div class="p6-video-stage">
          <div class="p6-vid-scene" aria-hidden="true">
            <div class="p6-vid-card"><i></i><span></span></div>
            <div class="p6-vid-card short"><i></i><span></span></div>
          </div>
          <div class="p6-vid-ui">
            <div class="p6-vid-bars"><i></i><i></i><i></i></div>
            <div class="p6-play-btn"><span>▶</span></div>
            <div class="p6-scrub"><span>0:06</span><div class="p6-track"><i style="width:42%"></i></div><span>0:18</span></div>
          </div>
        </div>
      </div>

      <div class="neu-pill-card" style="margin-top:20px">
        <span>原位预览</span><em class="arrow-muted">→</em><span>一键下载原件</span>
      </div>
    </div>
    {phone_frame(build_preview_screen(), style="left:438px;top:346px;width:368px;height:732px;transform:rotate(4deg)")}
    """
    return (
        "06-rich-file-preview",
        poster_shell(
            eyebrow="PREVIEW RIGHT IN CHAT.",
            line1="图片视频 HTML",
            line2="对话里直接看",
            subtitle="对话里的图片、视频与 HTML，按需预览或一键下载。",
            content_html=content,
            orbit_style="left:266px;top:338px;width:640px;height:640px;",
        ),
    )


# ---------------------------------------------------------------------------
# Poster 07: Dynamic Island & Live Activity + Push Notifications
# ---------------------------------------------------------------------------
def build_lock_screen() -> str:
    island = f"""
    <span class="di-left">{orbis_mark(12, "#ffffff")}<span>workstation</span></span>
    <span class="di-right"><i class="di-warn">!</i>1</span>
    """
    return f"""
    {status_bar(island_html=island, island_cls="is-live", hide_time=True)}
    <div class="app-lock">
      <div class="lk-lock">{svg_ico("lock", 13, "#5a708c", 2)}</div>
      <div class="lk-date">11月27日 星期五</div>
      <div class="lk-clock">9:41</div>

      <div class="la-card">
        <div class="la-top">
          <span>{svg_ico("desktop", 13, "#b7bcc4")}workstation</span>
          <b class="la-amber">1 项待处理</b>
        </div>
        <div class="la-title">{agent_icon("claude", 16)}<strong>实现项目仪表盘界面</strong></div>
        <div class="la-sub">Claude Code · 需要你处理</div>
        <div class="la-foot">
          <span class="la-amber"><i class="di-warn">!</i>等待你处理</span>
          <span>查看请求 {svg_ico("arrow_ne", 10, "#d2d6dc", 2.2)}</span>
        </div>
        <div class="la-more">{svg_ico("stack", 11, "#9aa0aa")}另有 2 个会话运行中</div>
      </div>

      <div class="lk-notif">
        <div class="lk-notif-hdr">
          <span class="notif-sq">{orbis_mark(11, "#ffffff")}</span>
          <b>Orbis</b><small>现在</small>
        </div>
        <div class="lk-notif-body"><strong>回复完成</strong><span>Codex · 整理新版本发布说明</span></div>
      </div>

      <div class="lk-shortcuts">
        <span>{svg_ico("flash", 15, "#4c627e")}</span>
        <span>{svg_ico("camera", 15, "#4c627e")}</span>
      </div>
    </div>"""


def build_poster_07() -> tuple[str, str]:
    content = f"""
    <div class="left-col p7-left">
      <div class="sec-kicker">DYNAMIC ISLAND</div>
      <h2 class="sec-h2">灵动岛胶囊<br>长按展开详情</h2>

      <div class="p7-di-compact">
        <span class="di-c-l">{orbis_mark(15, "#ffffff")}<b>2</b></span>
        <span class="di-c-m"></span>
        <span class="di-c-r"><i class="di-warn">!</i><b>1</b></span>
      </div>

      <div class="p7-di-expanded">
        <div class="la-top">
          <span>{svg_ico("desktop", 13, "#b7bcc4")}workstation</span>
          <b class="la-green">2 个运行中</b>
        </div>
        <div class="la-title">{agent_icon("codex", 16, mono="#77d6c7")}<strong>整理新版本发布说明</strong></div>
        <div class="la-foot" style="padding-top:8px">
          <span><i class="la-run-dot"></i>运行中 · Codex</span>
          <span>2 分钟前</span>
        </div>
      </div>

      <div class="sec-kicker" style="margin-top:26px">PUSH NOTIFICATIONS</div>
      <div class="p7-push-card">
        <span class="notif-badge-lg">{orbis_mark(20, "#ffffff")}</span>
        <div class="p7-push-meta">
          <div><b>Orbis</b><small>现在</small></div>
          <strong>允许 Claude 使用 Bash?</strong>
          <span>Claude Code · 轻点立即审批</span>
        </div>
      </div>

      <p class="p7-bottom-note">不必一直守着屏幕。</p>
    </div>
    <div class="p7-bell-badge" aria-hidden="true">
      {svg_ico("bell", 26, "#395682", 1.7)}
      <i></i>
    </div>
    {phone_frame(build_lock_screen(), style="left:444px;top:352px;width:362px;height:730px;transform:rotate(4.2deg)", screen_cls="lock-bg")}
    """
    return (
        "07-live-activity",
        poster_shell(
            eyebrow="LIVE ACTIVITY & ALERTS.",
            line1="灵动岛上",
            line2="进展抬眼即见",
            subtitle="实时活动 · 灵动岛胶囊 · 完成与审批推送",
            content_html=content,
            orbit_style="left:286px;top:368px;width:620px;height:620px;",
            orbit_dot=False,
        ),
    )


# ---------------------------------------------------------------------------
# Poster 08: System Share to Orbis ("发送到 Orbis")
# ---------------------------------------------------------------------------
def build_share_screen() -> str:
    return f"""
    {status_bar()}
    <div class="app-share">
      <div class="sh-backdrop">
        <div class="sh-peek-doc">Q4-产品评审录屏与截图.pdf</div>
      </div>
      <div class="sh-sheet">
        <div class="sh-handle"><i></i></div>
        <div class="sh-hdr">
          <span class="sh-x">{svg_ico("close", 13, "#6a768a", 2.2)}</span>
          <b>发送到 Orbis</b>
          <span style="width:28px"></span>
        </div>
        <div class="sh-body">
          <div class="sh-file-card">
            <span class="sh-file-ico">{svg_ico("doc", 18, "#2f5287")}</span>
            <div class="sh-file-meta">
              <b>Q4-产品评审录屏与截图.pdf</b>
              <small>2 个文件 · 6.8 MB</small>
            </div>
            {svg_ico("chev_down", 13, "#8b97aa")}
          </div>
          <div class="sh-note">帮我提炼核心改动点，并对照当前分支给出待办清单</div>
          <div class="sh-group-lbl">workstation</div>
          <div class="sh-targets">
            <div class="sh-row is-sel">
              {agent_icon("claude", 17)}
              <div class="sh-row-meta">
                <b>实现项目仪表盘界面</b>
                <small>orbis · 运行中 · 最近使用</small>
              </div>
              <span class="sh-chk is-on">{svg_ico("check", 10, "#ffffff", 2.8)}</span>
            </div>
            <div class="sh-row">
              {agent_icon("codex", 17)}
              <div class="sh-row-meta">
                <b>整理新版本发布说明</b>
                <small>orbis</small>
              </div>
              <span class="sh-chk"></span>
            </div>
            <div class="sh-row">
              {agent_icon("kimi", 17)}
              <div class="sh-row-meta">
                <b>生成季度产品原型页</b>
                <small>website</small>
              </div>
              <span class="sh-chk"></span>
            </div>
            <div class="sh-row sh-new">
              <span class="sh-plus">{svg_ico("plus", 14, "#2f5287", 2.2)}</span>
              <b>新建会话</b>
              {svg_ico("chev_right", 13, "#96a2b5")}
            </div>
          </div>
          <div class="sh-group-lbl" style="margin-top:2px">MacBook-Pro</div>
          <div class="sh-targets">
            <div class="sh-row">
              {agent_icon("deepseek", 17)}
              <div class="sh-row-meta">
                <b>排查接口超时与重试</b>
                <small>api-server</small>
              </div>
              <span class="sh-chk"></span>
            </div>
          </div>
        </div>
        <div class="sh-foot">
          <div class="sh-primary">发送到「实现项目仪表盘界面」</div>
          <div class="sh-secondary">先存入 Orbis</div>
        </div>
      </div>
    </div>"""


def build_poster_08() -> tuple[str, str]:
    content = f"""
    <div class="left-col p8-left">
      <div class="sec-kicker">SYSTEM SHARE</div>
      <h2 class="sec-h2">其他 App 的素材<br>顺手交给 Agent</h2>

      <div class="p8-steps">
        <div class="p8-step">
          <span class="p8-step-num">01</span>
          <div>
            <b>任意内容一键分享</b>
            <small>相册截图、文档、网页链接或文字</small>
          </div>
        </div>
        <div class="p8-step">
          <span class="p8-step-num">02</span>
          <div>
            <b>附上一句要求</b>
            <small>直接说明分析、总结或修改方向</small>
          </div>
        </div>
        <div class="p8-step">
          <span class="p8-step-num">03</span>
          <div>
            <b>直达电脑会话</b>
            <small>投递到已有会话，或直接新建任务</small>
          </div>
        </div>
      </div>

      <div class="neu-pill-card" style="margin-top:26px">
        {svg_ico("share", 14, "#2f5287", 2.1)}<span>支持 iOS 分享扩展 · Android 系统分享</span>
      </div>
    </div>
    {phone_frame(build_share_screen(), style="left:438px;top:346px;width:368px;height:732px;transform:rotate(4deg)")}
    """
    return (
        "08-share-to-orbis",
        poster_shell(
            eyebrow="SHARE FROM ANY APP.",
            line1="随时分享",
            line2="直达你的 Agent",
            subtitle="从任意 App 分享图片、文件、链接与文字，交给电脑会话。",
            content_html=content,
            orbit_style="left:266px;top:338px;width:640px;height:640px;",
        ),
    )


# ---------------------------------------------------------------------------
# Poster 09: End-to-End Encryption & Privacy
# ---------------------------------------------------------------------------
def build_privacy_screen() -> str:
    return f"""
    {status_bar()}
    <div class="app-priv">
      <div class="pr-top">
        <span class="pr-title">设置</span>
        <span class="pr-conn-chip"><i class="conn-dot"></i>局域网 {svg_ico("lock", 9, "#1a6a4d", 2.4)}</span>
      </div>
      <div class="pr-sheet">
        <div class="pr-sheet-hdr">
          <span class="neu-circle xs">{svg_ico("close", 12, "#4a5364", 2.2)}</span>
          <b>当前连接</b>
          <span style="width:30px"></span>
        </div>
        <div class="pr-hero">
          <div class="pr-shield-orb">{svg_ico("shield", 28, "#1a6a4d", 1.9)}</div>
          <strong>端到端加密已建立</strong>
          <code>X25519 · HKDF-SHA256 · AES-256-GCM</code>
        </div>
        <div class="pr-rows">
          <div class="pr-row"><span>连接状态</span><b class="pr-pill-ok"><i class="conn-dot"></i>已加密</b></div>
          <div class="pr-row"><span>传输路径</span><b class="pr-ok">局域网直连</b></div>
          <div class="pr-row"><span>连接延迟</span><b>4 ms</b></div>
          <div class="pr-row"><span>端到端加密</span><b class="pr-ok">已启用</b></div>
        </div>
        <div class="pr-sec-lbl">已配对电脑</div>
        <div class="pr-host-sel">
          <span class="pr-radio is-on"><i></i></span>
          <b>workstation</b>
          <small>当前</small>
        </div>
        <div class="pr-sec-lbl" style="margin-top:10px">隐私控制</div>
        <div class="pr-priv-card">
          <div class="pr-tog-row">
            <b>设备使用统计</b>
            <span class="pr-toggle"><i></i></span>
          </div>
          <small>默认关闭；会话内容与密钥留在本地设备，中继不可读取。</small>
        </div>
        <div class="pr-reconn-btn">{svg_ico("refresh", 12, "#2f5287", 2.2)}<span>重新连接</span></div>
      </div>
    </div>"""


def build_poster_09() -> tuple[str, str]:
    content = f"""
    <div class="left-col p9-left">
      <div class="p9-tunnel-card">
        <div class="p9-tunnel-nodes">
          <div class="p9-node"><span>{svg_ico("phone", 18, "#2f5287")}</span><small>你的手机</small></div>
          <div class="p9-tunnel-mid">
            <span class="p9-lock-tag">{svg_ico("lock", 11, "#1a6a4d", 2.2)} AES-256-GCM</span>
            <div class="p9-wire"><i></i></div>
            <em>中继仅转发密文 · 不可读取</em>
          </div>
          <div class="p9-node"><span>{svg_ico("desktop", 18, "#2f5287")}</span><small>你的电脑</small></div>
        </div>
      </div>

      <div class="p9-pillars">
        <div class="p9-pillar">
          <span class="p9-ic">{svg_ico("shield", 16, "#1a6a4d")}</span>
          <div>
            <b>端到端加密传输</b>
            <small>X25519 密钥协商与 AEAD 帧认证，<br>会话消息与文件分片全程密文</small>
          </div>
        </div>
        <div class="p9-pillar">
          <span class="p9-ic">{svg_ico("desktop", 16, "#2f5287")}</span>
          <div>
            <b>Agent 跑在你自己电脑上</b>
            <small>代码、凭据与模型 Key 留在本地，<br>局域网优先直连，外出自动切换加密中继</small>
          </div>
        </div>
        <div class="p9-pillar">
          <span class="p9-ic">{svg_ico("lock", 16, "#4a5a74")}</span>
          <div>
            <b>设备随时可撤销</b>
            <small>统计默认关闭，不记录消息正文、<br>IP 地址或 Cookie，安全透明可控</small>
          </div>
        </div>
      </div>
    </div>
    {phone_frame(build_privacy_screen(), style="left:438px;top:346px;width:368px;height:732px;transform:rotate(4deg)")}
    """
    return (
        "09-e2e-privacy",
        poster_shell(
            eyebrow="END-TO-END ENCRYPTED.",
            line1="端到端加密",
            line2="隐私完全安心",
            subtitle="Agent 运行在你自己的电脑上，中继无法读取任何内容。",
            content_html=content,
            orbit_style="left:266px;top:338px;width:640px;height:640px;",
        ),
    )


CSS = r"""
*{box-sizing:border-box}
html,body{margin:0;padding:0;width:900px;height:1200px;overflow:hidden}
body{
  font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","SF Pro Display","Helvetica Neue",sans-serif;
  color:#1c2534;
  background:#eaf0f8;
  -webkit-font-smoothing:antialiased;
  font-variant-numeric:tabular-nums;
}
.ag-img{display:block;object-fit:contain;flex:none}
.ag-mask{display:inline-block;flex:none;-webkit-mask-position:center;-webkit-mask-repeat:no-repeat;-webkit-mask-size:contain;mask-position:center;mask-repeat:no-repeat;mask-size:contain}
.svg-ico{display:inline-block;vertical-align:middle;flex:none}

/* Poster Canvas — matches docs/assets/promo */
.poster{
  position:relative;
  width:900px;
  height:1200px;
  overflow:hidden;
  isolation:isolate;
  background:
    radial-gradient(ellipse at 64% 62%, #d9e5f5 0%, rgba(217,229,245,0) 64%),
    linear-gradient(158deg, #f8fbff 0%, #edf2f9 52%, #e4ecf6 100%);
}
.poster-frame{
  position:absolute;inset:16px;
  border:1px solid rgba(255,255,255,0.68);
  border-radius:14px;
  pointer-events:none;z-index:1;
}
.poster-orbit{position:absolute;pointer-events:none;z-index:0}
.poster-orbit .ring{
  position:absolute;border-radius:50%;
  border:1px solid rgba(128,154,188,0.17);
}
.poster-orbit .r1{inset:0}
.poster-orbit .r2{inset:76px}
.poster-orbit .r3{inset:152px}
.poster-orbit .orbit-node{
  position:absolute;left:44px;top:256px;width:9px;height:9px;border-radius:50%;
  background:#b8c7dc;box-shadow:0 0 0 4px rgba(184,199,220,0.22);
}

.poster-brand{
  position:absolute;left:64px;top:44px;z-index:5;
  display:flex;align-items:center;gap:10px;
}
.poster-brand span{font-size:26px;font-weight:700;letter-spacing:-0.6px;color:#1b2535}

.poster-head{
  position:absolute;left:64px;top:116px;right:64px;z-index:5;
}
.eyebrow{
  font-size:11.5px;font-weight:600;letter-spacing:2.4px;color:#526d93;
  text-transform:uppercase;margin-bottom:14px;
}
.headline{
  margin:0;font-size:64px;line-height:1.15;font-weight:700;letter-spacing:-2px;
  display:flex;flex-direction:column;
}
.headline span{color:#1b2535}
.headline em{font-style:normal;color:#2f5287}
.subtitle{
  margin:18px 0 0;font-size:18.5px;line-height:1.45;color:#58677e;font-weight:400;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.sub-compact{font-size:15.2px;letter-spacing:-0.15px}

.poster-footer{
  position:absolute;left:64px;right:64px;bottom:24px;z-index:6;
  border-top:1px solid rgba(132,154,184,0.22);
  padding-top:13px;
}
.footer-line{font-size:12.5px;color:#687890;letter-spacing:0.2px}
.footer-demo{font-size:10.5px;color:#95a3b8;margin-top:4px}

/* Shared Left Editorial Column */
.left-col{position:absolute;left:64px;width:336px;z-index:5}
.accent-bar{width:44px;height:3.5px;border-radius:2px;background:#2f5287;margin-bottom:26px}
.left-title{margin:0;font-size:31px;line-height:1.34;font-weight:700;color:#1b2535;letter-spacing:-0.8px}
.left-desc{margin:18px 0 0;font-size:17px;line-height:1.68;color:#5c6c82}
.sec-kicker{font-size:10.5px;font-weight:600;letter-spacing:2px;color:#667e9f;text-transform:uppercase;margin-bottom:10px}
.sec-h2{margin:0;font-size:28px;line-height:1.3;font-weight:700;color:#1b2535;letter-spacing:-0.6px}
.sec-copy{margin:12px 0 0;font-size:15.5px;line-height:1.65;color:#5c6c82}
.micro-cap{margin-top:26px;font-size:10px;letter-spacing:2.1px;color:#8394ad;font-weight:600}
.neu-pill-card{
  display:inline-flex;align-items:center;gap:10px;
  padding:14px 20px;border-radius:18px;
  background:#ecf1f9;
  box-shadow:8px 10px 22px rgba(126,147,178,0.26),-6px -6px 16px rgba(255,255,255,0.88),inset 0 0 0 1px rgba(255,255,255,0.75);
  font-size:14.5px;font-weight:600;color:#33445c;
}
.dot-green{width:8px;height:8px;border-radius:50%;background:#1a6a4d;flex:none}
.dot-blue{width:8px;height:8px;border-radius:50%;background:#2f5287;flex:none}
.arrow-muted{font-style:normal;color:#8998ae;margin:0 6px}

/* Silver-White iPhone Frame — matches docs/assets/promo */
.phone-wrap{
  position:absolute;z-index:4;
  padding:9px;border-radius:50px;
  background:linear-gradient(135deg,#fafcff 0%,#d7e0ed 42%,#f4f8fd 84%,#cfd9e7 100%);
  border:1px solid rgba(255,255,255,0.94);
  box-shadow:22px 32px 58px rgba(72,95,129,0.24),-9px -9px 22px rgba(255,255,255,0.85),inset 0 0 0 1px rgba(132,149,174,0.26);
  transform-origin:center center;
}
.phone-compact{padding:7px;border-radius:42px}
.phone-compact .phone-screen{border-radius:35px}
.phone-wrap .btn-mute{position:absolute;left:-3px;top:102px;width:3px;height:24px;border-radius:2px 0 0 2px;background:#c5cfde}
.phone-wrap .btn-vol1{position:absolute;left:-3px;top:144px;width:3px;height:44px;border-radius:2px 0 0 2px;background:#c5cfde}
.phone-wrap .btn-vol2{position:absolute;left:-3px;top:198px;width:3px;height:44px;border-radius:2px 0 0 2px;background:#c5cfde}
.phone-wrap .btn-pwr{position:absolute;right:-3px;top:164px;width:3px;height:62px;border-radius:0 2px 2px 0;background:#c5cfde}
.phone-screen{
  position:relative;width:100%;height:100%;
  border-radius:41px;overflow:hidden;
  background:#e6ebf4;
  display:flex;flex-direction:column;
  box-shadow:inset 0 0 0 1px rgba(120,136,162,0.18);
}
.phone-screen.lock-bg{
  background:radial-gradient(ellipse at 32% 18%,#f4f8fd,#e3ebf6 64%,#d9e3f1);
}

/* iOS Status Bar & Home Indicator */
.ios-status{
  position:relative;flex:none;height:42px;
  padding:13px 22px 0;
  display:flex;align-items:center;justify-content:space-between;
  color:#1d2430;z-index:10;
}
.ios-time{font-size:13px;font-weight:700;letter-spacing:-0.2px}
.ios-island{
  position:absolute;left:50%;top:10px;transform:translateX(-50%);
  width:96px;height:24px;border-radius:14px;background:#151a22;
}
.ios-island.is-live{
  width:152px;height:26px;padding:0 10px;
  display:flex;align-items:center;justify-content:space-between;
  color:#e8edf5;font-size:9.5px;font-weight:600;
}
.di-left{display:flex;align-items:center;gap:5px}
.di-right{display:flex;align-items:center;gap:3px;color:#f5c475;font-weight:700}
.di-warn{
  display:inline-grid;place-items:center;width:12px;height:12px;border-radius:50%;
  background:#f5c475;color:#17120b;font-style:normal;font-size:8.5px;font-weight:800;
}
.ios-indicators{display:flex;align-items:center;gap:4px}
.sig{display:flex;align-items:flex-end;gap:1.5px;height:9px}
.sig i{display:block;width:2.2px;background:currentColor;border-radius:0.6px}
.sig i:nth-child(1){height:3.5px}.sig i:nth-child(2){height:5.2px}.sig i:nth-child(3){height:7px}.sig i:nth-child(4){height:9px}
.bat{width:18px;height:9px;border:1.1px solid currentColor;border-radius:2.5px;padding:1px;position:relative}
.bat:after{content:"";position:absolute;right:-2.5px;top:2.2px;width:1.4px;height:3.2px;border-radius:1px;background:currentColor}
.bat i{display:block;width:88%;height:100%;background:currentColor;border-radius:1px}
.ios-home-bar{
  position:absolute;left:0;right:0;bottom:6px;display:flex;justify-content:center;pointer-events:none;z-index:20;
}
.ios-home-bar i{width:108px;height:3.5px;border-radius:3px;background:#1e2633;opacity:0.78}

/* Neumorphic App Primitives */
.neu-circle{
  width:34px;height:34px;border-radius:50%;flex:none;
  display:grid;place-items:center;
  background:#e8edf6;
  box-shadow:3px 3px 6px rgba(166,178,198,0.52),-3px -3px 6px rgba(255,255,255,0.88);
}
.neu-circle.sm{width:30px;height:30px}
.neu-circle.xs{width:28px;height:28px}
.neu-circle.muted{box-shadow:none;border:1px solid #cbd4e2;background:transparent}

/* Home Screen */
.app-home{flex:1;display:flex;flex-direction:column;padding:6px 14px 16px;min-height:0}
.home-top{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.home-brand{flex:1;min-width:0}
.home-brand b{display:block;font-size:17px;line-height:1.1;color:#202a38;font-weight:700}
.home-brand span{display:block;font-size:9.5px;color:#6c7b91;margin-top:2px;letter-spacing:0.15px}
.home-actions{display:flex;gap:8px}
.home-host-row{display:flex;align-items:center;justify-content:space-between;margin:4px 2px 10px}
.host-name{display:flex;align-items:center;gap:6px;font-size:13px;color:#273243}
.host-name b{font-weight:650}
.conn-pill{
  display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:999px;
  background:#eaf0f8;font-size:10.5px;font-weight:600;color:#1a6a4d;
  box-shadow:2.5px 2.5px 6px rgba(166,178,198,0.45),-2.5px -2.5px 6px rgba(255,255,255,0.88);
}
.conn-dot{width:6px;height:6px;border-radius:50%;background:#1a6a4d;display:inline-block}
.home-list{flex:1;display:flex;flex-direction:column;gap:9px;overflow:hidden}
.sess-card{
  display:flex;align-items:center;gap:11px;
  padding:11px 12px;border-radius:17px;
  background:#ebf0f8;
  box-shadow:4px 4px 10px rgba(166,178,198,0.48),-4px -4px 10px rgba(255,255,255,0.88);
}
.sess-ico{
  width:34px;height:34px;border-radius:11px;flex:none;
  display:grid;place-items:center;background:#e4eaf4;
  box-shadow:inset 2px 2px 4px rgba(166,178,198,0.45),inset -2px -2px 4px rgba(255,255,255,0.85);
}
.sess-meta{min-width:0;flex:1}
.sess-title{font-size:12.5px;font-weight:650;color:#202a38;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sess-path{font-size:10px;color:#6c7b91;font-family:"SF Mono",ui-monospace,Menlo,monospace;margin-top:2px}
.sess-sub{display:flex;align-items:center;gap:5px;font-size:10.5px;color:#5a697f;margin-top:3px}
.sess-sub b{font-weight:650}
.sdot{display:inline-block;width:6px;height:6px;border-radius:50%;flex:none}
.sdot.running{background:#1a6a4d}
.sdot.approval{background:#b46914}
.sdot.idle{border:1.4px solid #7d899d;background:transparent}

.orbis-tabs{
  margin-top:10px;display:grid;grid-template-columns:repeat(3,1fr);gap:10px;padding-bottom:6px;
}
.tab-item{
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;
  height:48px;border-radius:14px;background:#e8edf6;color:#58667b;font-size:10px;font-weight:500;
  box-shadow:3px 3px 7px rgba(166,178,198,0.45),-3px -3px 7px rgba(255,255,255,0.86);
}
.tab-item.is-active{
  color:#2f5287;font-weight:650;
  box-shadow:inset 2.5px 2.5px 5px rgba(166,178,198,0.5),inset -2.5px -2.5px 5px rgba(255,255,255,0.88);
}

/* Poster 01 */
.p1-left{top:460px}
.p1-agent-pill{
  margin-top:74px;
  display:flex;align-items:center;gap:14px;
  padding:13px 16px;border-radius:20px;width:336px;
  background:#ecf1f9;
  box-shadow:10px 12px 26px rgba(124,145,175,0.28),-7px -7px 18px rgba(255,255,255,0.9),inset 0 0 0 1px rgba(255,255,255,0.75);
}
.p1-agent-rows{display:flex;flex-direction:column;gap:6px;align-items:center}
.p1-agent-row{display:flex;gap:6px;justify-content:center}
.p1-ag-dot{
  width:26px;height:26px;border-radius:8px;display:grid;place-items:center;
  background:#e5ecf6;
  box-shadow:inset 1.5px 1.5px 3px rgba(166,178,198,0.45),inset -1.5px -1.5px 3px rgba(255,255,255,0.85);
}
.p1-agent-copy{border-left:1px solid rgba(140,158,184,0.3);padding-left:12px;flex:none}
.p1-agent-copy small{display:block;font-size:11px;color:#62748f;font-weight:600}
.p1-agent-copy b{display:block;font-size:15.5px;color:#1f2c40;margin-top:2px;white-space:nowrap}

/* Poster 02 */
.p2-left{position:absolute;left:64px;top:372px;width:376px;z-index:5}
.p2-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:13px}
.p2-tile{
  position:relative;padding:15px 10px 14px;border-radius:19px;
  background:#edf2f9;text-align:center;
  display:flex;flex-direction:column;align-items:center;
  box-shadow:8px 10px 20px rgba(128,148,178,0.24),-6px -6px 16px rgba(255,255,255,0.9),inset 0 0 0 1px rgba(255,255,255,0.72);
}
.p2-num{position:absolute;right:10px;top:8px;font-size:9.5px;font-weight:600;color:#93a3ba}
.p2-ico{
  width:42px;height:42px;border-radius:13px;display:grid;place-items:center;margin-bottom:9px;
  background:#e5ebf5;
  box-shadow:inset 2px 2px 4px rgba(166,178,198,0.45),inset -2px -2px 4px rgba(255,255,255,0.88);
}
.p2-tile b{font-size:13px;font-weight:700;line-height:1.2;white-space:nowrap}
.p2-tile small{font-size:10px;color:#66768d;margin-top:4px;white-space:nowrap}
.p2-summary-pill{
  margin-top:20px;padding:13px 16px;border-radius:16px;
  background:#ecf1f9;display:flex;align-items:center;gap:10px;
  font-size:13px;color:#475871;
  box-shadow:6px 8px 18px rgba(128,148,178,0.22),-5px -5px 14px rgba(255,255,255,0.88),inset 0 0 0 1px rgba(255,255,255,0.7);
}
.p2-summary-pill b{color:#2f5287;font-weight:700}
.p2-phone-cap{
  position:absolute;left:476px;bottom:84px;width:348px;text-align:center;
  font-size:14.5px;color:#5a6b82;z-index:5;
}

/* Poster 03: Agent Dial */
.p3-left{top:426px}
.p3-icons-stack{display:flex;flex-direction:column;gap:8px;margin-top:16px}
.p3-icons-row{display:flex;gap:8px}
.p3-mini-ag{
  width:34px;height:34px;border-radius:11px;display:grid;place-items:center;
  background:#ebf0f8;
  box-shadow:4px 4px 9px rgba(144,160,186,0.3),-3px -3px 8px rgba(255,255,255,0.88);
}
.p3-guide-arc{position:absolute;inset:0;pointer-events:none;z-index:6}

.app-dial{flex:1;display:flex;flex-direction:column;padding:4px 0 16px;min-height:0}
.dial-hdr{display:flex;align-items:center;justify-content:space-between;padding:4px 16px 6px}
.dial-hdr b{font-size:18px;font-weight:700;color:#202a38}
.dial-host-row{display:flex;align-items:center;justify-content:space-between;padding:2px 16px 6px}
.dial-count{font-size:10.5px;font-weight:600;color:#5f6f85}
.dial-stage{position:relative;flex:1;min-height:316px;overflow:hidden}
.disc{position:absolute;border-radius:50%;background:#e6ebf4}
.disc-out{box-shadow:8px 8px 20px rgba(166,178,198,0.58),-8px -8px 20px rgba(255,255,255,0.88)}
.disc-seam{box-shadow:inset 3px 3px 7px rgba(166,178,198,0.52),inset -3px -3px 7px rgba(255,255,255,0.88)}
.disc-hub{box-shadow:5px 5px 12px rgba(166,178,198,0.52),-5px -5px 12px rgba(255,255,255,0.9)}
.disc-hole{box-shadow:inset 4px 4px 8px rgba(166,178,198,0.56),inset -4px -4px 8px rgba(255,255,255,0.88)}
.dial-svg{position:absolute;left:0;top:0;pointer-events:none}
.pin-groove{
  position:absolute;border-radius:21px;background:#e6ebf4;
  box-shadow:inset 2.5px 2.5px 6px rgba(166,178,198,0.58),inset -2.5px -2.5px 6px rgba(255,255,255,0.9);
}
.pin-socket{
  position:absolute;right:3px;top:3px;width:36px;height:36px;border-radius:50%;
  box-shadow:inset 0 0 0 1.6px rgba(0,101,93,0.85);
}
.dial-bead{
  position:absolute;width:40px;height:40px;margin:-20px 0 0 -20px;
  display:grid;place-items:center;
}
.dial-bead .bead-cap{display:none}
.dial-bead.is-docked .bead-cap{
  display:block;position:absolute;inset:2px;border-radius:50%;background:#ecf1f8;
  box-shadow:3px 3px 8px rgba(154,168,190,0.62),-3px -3px 8px rgba(255,255,255,0.92);
}
.dial-bead.is-docked .ag-mask,.dial-bead.is-docked .ag-img{position:relative;z-index:2}
.dial-bead.is-off{opacity:0.38;filter:grayscale(1)}
.bead-dot{
  position:absolute;right:5px;top:5px;width:6px;height:6px;border-radius:50%;
  background:#1a6a4d;box-shadow:0 0 0 1.5px #e6ebf4;z-index:3;
}
.bead-var{
  position:absolute;right:3px;bottom:3px;width:13px;height:13px;border-radius:50%;
  background:#edf1f8;display:grid;place-items:center;z-index:3;
  box-shadow:1.5px 1.5px 3px rgba(154,168,190,0.55),-1.5px -1.5px 3px rgba(255,255,255,0.9);
}
.prof-lbl{position:absolute;display:flex;flex-direction:column;gap:2px}
.prof-lbl.is-sel .pl-agent{font-size:10px;font-weight:700;color:#00655D}
.prof-lbl.is-sel strong{font-size:18px;font-weight:700;color:#1d2736;line-height:1.15}
.prof-lbl.is-sel .pl-sub{font-size:9.5px;color:#5c6a80;margin-top:2px}
.prof-lbl.is-sel .pl-use{display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:650;color:#1a6a4d;margin-top:2px}
.prof-lbl.is-dim span{font-size:12px;color:#6d7b91;font-weight:500}
.prof-lbl.is-faint span{font-size:11px;color:#9aa7ba}

.dial-foot{padding:4px 16px 0;display:flex;flex-direction:column;gap:10px}
.quota-pair{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.q-item{display:flex;flex-direction:column;gap:3px}
.q-lbl{font-size:10.5px;color:#5f6d82;font-weight:500}
.q-val{font-size:24px;line-height:1.05;color:#1d2736;font-weight:700}
.q-val small{font-size:12px;font-weight:600;margin-left:1px}
.q-bar{height:5px;border-radius:3px;background:#dce3ef;box-shadow:inset 1px 1px 2px rgba(152,166,188,0.5);overflow:hidden;margin:2px 0}
.q-bar i{display:block;height:100%;background:#00655D;border-radius:3px}
.q-reset{font-size:9px;color:#738298}
.dial-btn{
  height:40px;border-radius:14px;display:flex;align-items:center;justify-content:center;gap:6px;
  font-size:12px;font-weight:600;color:#4a5568;background:#e8edf6;
  box-shadow:3px 3px 7px rgba(166,178,198,0.45),-3px -3px 7px rgba(255,255,255,0.88);
}
.dial-pos{display:flex;justify-content:space-between;font-size:9.5px;color:#76849a}
.app-dial .orbis-tabs{padding:0 14px 6px}

/* Chat Base (Posters 04 & 06) */
.app-chat{flex:1;display:flex;flex-direction:column;padding:4px 12px 16px;min-height:0}
.chat-hdr{display:flex;align-items:center;gap:8px;padding:4px 2px 8px}
.chat-ttl{flex:1;min-width:0}
.chat-ttl>div{display:flex;align-items:center;gap:5px}
.chat-ttl b{font-size:13px;font-weight:700;color:#202a38;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chat-ttl small{display:flex;align-items:center;gap:4px;font-size:10px;color:#5c6a80;margin-top:2px}
.chat-ttl small span{color:#78869b}
.chat-body{flex:1;display:flex;flex-direction:column;gap:10px;overflow:hidden;padding:4px 2px}
.msg-asst{
  padding:12px;border-radius:18px;background:#ebf0f8;font-size:11.5px;line-height:1.58;color:#243040;
  box-shadow:3.5px 3.5px 8px rgba(166,178,198,0.48),-3.5px -3.5px 8px rgba(255,255,255,0.88);
}
.msg-asst p{margin:0 0 7px}
.msg-asst p:last-child{margin-bottom:0}
.mini-tree{
  margin:0 0 8px;padding:8px 9px;border-radius:10px;background:#e3e9f3;
  font:9.5px/1.45 "SF Mono",ui-monospace,Menlo,monospace;color:#4a586f;
  box-shadow:inset 1.5px 1.5px 3px rgba(160,172,192,0.45),inset -1.5px -1.5px 3px rgba(255,255,255,0.8);
  white-space:pre;overflow:hidden;
}
.msg-user{
  align-self:flex-end;padding:9px 13px;border-radius:16px;background:#e6ebf4;
  font-size:11.5px;font-weight:500;color:#222c3c;
  box-shadow:inset 2.5px 2.5px 5px rgba(166,178,198,0.5),inset -2.5px -2.5px 5px rgba(255,255,255,0.88);
}
.tool-chip{
  display:flex;align-items:center;justify-content:space-between;
  padding:8px 11px;border-radius:12px;background:#edf2f9;font-size:10.5px;color:#465368;
}
.tool-chip span{display:flex;align-items:center;gap:5px}
.tool-chip .ok{font-style:normal;color:#1a6a4d;font-weight:650}
.appr-card{
  padding:12px;border-radius:18px;background:#eef2fa;
  box-shadow:5px 5px 12px rgba(154,168,192,0.48),-4px -4px 10px rgba(255,255,255,0.92);
}
.appr-top{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:6px}
.appr-top span{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:#202a38}
.appr-top em{font-style:normal;font-size:10px;font-weight:650;color:#b26018}
.appr-card p,.p4-float-card p{margin:0 0 8px;font-size:11px;color:#556378}
.appr-card pre,.p4-float-card pre{
  margin:0 0 10px;padding:8px 10px;border-radius:10px;background:#e5ebf4;
  font:9.5px/1.45 "SF Mono",ui-monospace,Menlo,monospace;color:#334054;
  box-shadow:inset 1.5px 1.5px 3px rgba(162,174,194,0.45),inset -1.5px -1.5px 3px rgba(255,255,255,0.85);
  white-space:pre-wrap;word-break:normal;overflow-wrap:break-word;
}
.appr-btns{display:grid;grid-template-columns:1fr 1fr;gap:9px}
.btn-deny,.btn-allow{
  height:34px;border-radius:12px;display:flex;align-items:center;justify-content:center;gap:5px;
  font-size:12px;font-weight:650;background:#e8edf6;
  box-shadow:3px 3px 7px rgba(164,176,196,0.5),-3px -3px 7px rgba(255,255,255,0.9);
}
.btn-deny{color:#a83329}
.btn-allow{color:#9A4521}

.chat-comp{flex:none;padding-top:6px;border-top:1px solid rgba(154,69,33,0.14)}
.comp-meta{display:flex;justify-content:space-between;font-size:9.5px;color:#5c6a80;margin-bottom:6px;padding:0 2px}
.comp-meta span{display:flex;align-items:center;gap:4px;font-family:"SF Mono",ui-monospace,Menlo,monospace}
.comp-row{display:flex;align-items:center;gap:7px;padding-bottom:6px}
.comp-in{
  flex:1;height:36px;border-radius:13px;padding:0 12px;display:flex;align-items:center;
  font-size:11px;color:#7a879c;background:#e6ebf4;
  box-shadow:inset 2px 2px 4px rgba(166,178,198,0.5),inset -2px -2px 4px rgba(255,255,255,0.88);
}

/* Poster 04 Left */
.p4-left{top:418px}
.p4-float-card{
  margin-top:26px;padding:18px;border-radius:22px;background:#edf2fa;
  box-shadow:12px 16px 32px rgba(118,139,170,0.28),-8px -8px 20px rgba(255,255,255,0.92),inset 0 0 0 1px rgba(255,255,255,0.75);
}
.p4-float-card .appr-top span{font-size:14px}
.p4-float-card .appr-top em{font-size:11.5px}
.p4-float-card p{font-size:12.5px}
.p4-float-card pre{font-size:11px;padding:10px 12px}
.p4-float-card .btn-deny,.p4-float-card .btn-allow{height:40px;font-size:13.5px}
.p4-feedback-lbl{margin-top:46px;font-size:13.5px;color:#6c7d96}
.p4-feedback-pill{
  margin-top:12px;height:42px;border-radius:21px;padding:0 16px;
  display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:600;color:#273446;
  background:#e7edf7;
  box-shadow:inset 3px 3px 7px rgba(154,169,192,0.52),inset -3px -3px 7px rgba(255,255,255,0.92);
}

/* Poster 05: Diff Review */
.p5-file-pill{
  position:absolute;left:64px;top:372px;width:366px;height:48px;z-index:5;
  padding:0 18px;border-radius:16px;background:#edf2f9;
  display:flex;align-items:center;justify-content:space-between;
  box-shadow:8px 10px 22px rgba(126,147,178,0.24),-6px -6px 16px rgba(255,255,255,0.9),inset 0 0 0 1px rgba(255,255,255,0.75);
}
.p5-file-pill>span:first-child{display:flex;align-items:center;gap:10px}
.p5-file-pill code{font:13.5px "SF Mono",ui-monospace,Menlo,monospace;color:#283447;font-weight:500}
.diff-stat{font:700 12.5px "SF Mono",ui-monospace,Menlo,monospace;display:flex;gap:7px}
.diff-stat .add{font-style:normal;color:#1a6a4d}
.diff-stat .del{font-style:normal;color:#b23128}
.p5-bottom-hint{
  position:absolute;left:84px;bottom:84px;z-index:5;
  display:flex;align-items:center;gap:10px;font-size:12px;color:#6c7d96;font-weight:600;
}
.p5-bottom-hint i{width:34px;height:1px;background:#a7b6cb}
.p5-bottom-hint em{font-style:normal;margin-left:8px;font-weight:500}

.app-diff{flex:1;display:flex;flex-direction:column;padding:6px 13px 18px;min-height:0}
.diff-hdr{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.diff-hdr b{font-size:15px;font-weight:700;color:#202a38}
.diff-file-bar{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:10px;padding:0 2px}
.tag-mod{
  display:inline-block;padding:2px 6px;border-radius:6px;background:#f2e5cb;color:#8e5807;
  font-size:9.5px;font-weight:700;margin-right:6px;vertical-align:middle;
}
.diff-file-bar b{font-size:12px;font-family:"SF Mono",ui-monospace,Menlo,monospace;color:#1f2a3a}
.diff-dir{font-size:9.5px;color:#6c7b91;font-family:"SF Mono",ui-monospace,Menlo,monospace;margin-top:3px}
.diff-box{
  flex:1;border-radius:14px;background:#eaf0f8;padding:8px 0;overflow:hidden;
  box-shadow:inset 2px 2px 5px rgba(162,174,194,0.45),inset -2px -2px 5px rgba(255,255,255,0.88);
  font:9.2px/1.62 "SF Mono",ui-monospace,Menlo,monospace;
}
.dhunk{padding:3px 10px 6px;color:#6b7a91;font-size:8.5px;text-align:center}
.dline{display:flex;align-items:baseline;padding:0 8px;white-space:pre;color:#354155}
.dline .dln{width:22px;flex:none;color:#8c9ab0;text-align:right;margin-right:5px;font-size:8.2px}
.dline .dsgn{width:11px;flex:none;font-weight:700}
.dline code{font-family:inherit;overflow:hidden;text-overflow:ellipsis}
.d-add{background:rgba(26,106,77,0.13);color:#144d38}
.d-add .dsgn{color:#1a6a4d}
.d-del{background:rgba(178,49,40,0.12);color:#7e251f}
.d-del .dsgn{color:#b23128}
.diff-pager{display:flex;align-items:center;justify-content:space-between;padding:10px 4px 4px;font-size:11px;color:#5a687e}
.phone-compact .diff-box{font-size:8.1px;line-height:1.56}
.phone-compact .diff-file-bar b{font-size:10.5px}

/* Poster 06: Rich File Preview */
.p6-left{top:402px}
.p6-format-grid{margin-top:22px;display:grid;grid-template-columns:1fr 1fr;gap:11px}
.p6-fmt{
  display:flex;align-items:center;gap:9px;padding:11px 12px;border-radius:15px;background:#edf2f9;
  box-shadow:6px 8px 18px rgba(128,148,178,0.22),-5px -5px 14px rgba(255,255,255,0.9),inset 0 0 0 1px rgba(255,255,255,0.72);
}
.p6-fmt b{display:block;font-size:12.5px;color:#1e293b;font-weight:700;line-height:1.2}
.p6-fmt small{display:block;font-size:10.5px;color:#62738b;margin-top:2px}
.p6-media-card{
  margin-top:20px;padding:13px;border-radius:20px;background:#edf2f9;
  box-shadow:10px 14px 28px rgba(124,145,175,0.26),-7px -7px 18px rgba(255,255,255,0.92),inset 0 0 0 1px rgba(255,255,255,0.75);
}
.p6-media-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:9px}
.p6-media-head span{display:flex;align-items:center;gap:6px;font-size:12px;color:#222e40}
.p6-media-head b{font-family:"SF Mono",ui-monospace,Menlo,monospace;font-size:11.5px}
.p6-media-head small{font-size:10.5px;color:#3550CF;font-weight:600}
.p6-video-stage{
  height:122px;border-radius:13px;overflow:hidden;position:relative;
  background:linear-gradient(135deg,#182438 0%,#29426b 55%,#1b2e4d 100%);
  padding:12px;display:flex;flex-direction:column;justify-content:space-between;
}
.p6-vid-scene{
  position:absolute;inset:14px 18px 28px;display:flex;flex-direction:column;gap:8px;opacity:0.22;pointer-events:none;
}
.p6-vid-card{
  height:32px;border-radius:10px;background:rgba(255,255,255,0.55);padding:8px 10px;
  display:flex;align-items:center;gap:8px;
}
.p6-vid-card.short{width:72%;align-self:flex-end}
.p6-vid-card i{width:14px;height:14px;border-radius:50%;background:#ffffff;flex:none}
.p6-vid-card span{flex:1;height:6px;border-radius:3px;background:rgba(255,255,255,0.75)}
.p6-vid-ui{position:relative;z-index:2;display:flex;flex-direction:column;justify-content:space-between;height:100%}
.p6-vid-bars{display:flex;gap:5px}
.p6-vid-bars i{width:28px;height:4px;border-radius:2px;background:rgba(255,255,255,0.22)}
.p6-vid-bars i:first-child{background:rgba(255,255,255,0.55);width:44px}
.p6-play-btn{
  align-self:center;width:42px;height:42px;border-radius:50%;
  background:rgba(255,255,255,0.2);backdrop-filter:blur(6px);border:1px solid rgba(255,255,255,0.45);
  display:grid;place-items:center;color:#ffffff;font-size:14px;padding-left:2px;
}
.p6-scrub{display:flex;align-items:center;gap:7px;font:9.5px "SF Mono",ui-monospace,Menlo,monospace;color:rgba(255,255,255,0.78)}
.p6-track{flex:1;height:3.5px;border-radius:2px;background:rgba(255,255,255,0.22);overflow:hidden}
.p6-track i{display:block;height:100%;background:#ffffff;border-radius:2px}

.asst-id{display:flex;align-items:center;gap:5px;font-size:10.5px;margin-bottom:6px}
.p6-chat-body .msg-asst{display:flex;flex-direction:column;gap:7px}
.pv-card-row{display:flex;align-items:center;gap:6px}
.pv-main{
  flex:1;min-width:0;height:34px;padding:0 10px;border-radius:11px;
  display:flex;align-items:center;gap:7px;background:#e6ebf4;
  box-shadow:2.5px 2.5px 5px rgba(164,176,196,0.48),-2.5px -2.5px 5px rgba(255,255,255,0.88);
}
.pv-main.is-open{
  box-shadow:inset 2px 2px 4px rgba(164,176,196,0.5),inset -2px -2px 4px rgba(255,255,255,0.88);
}
.pv-main b{font-size:10.5px;font-weight:650;color:#222e40;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
.pv-main span{font:9px "SF Mono",ui-monospace,Menlo,monospace;color:#737f94;flex:none}
.pv-dl{
  width:34px;height:34px;border-radius:11px;flex:none;display:grid;place-items:center;background:#e6ebf4;
  box-shadow:2.5px 2.5px 5px rgba(164,176,196,0.48),-2.5px -2.5px 5px rgba(255,255,255,0.88);
}
.pv-html-box{
  position:relative;border-radius:13px;padding:10px;background:#f7faff;
  border:1px solid #cbd5e4;
}
.pv-expand{
  position:absolute;right:8px;top:8px;width:22px;height:22px;border-radius:50%;
  background:rgba(232,238,248,0.9);display:grid;place-items:center;border:1px solid #d2dbe8;
}
.mini-web{display:flex;flex-direction:column;gap:8px}
.mw-top{display:flex;align-items:center;gap:6px}
.mw-badge{padding:2px 7px;border-radius:6px;background:#dfe8f6;color:#2f5287;font-size:9px;font-weight:700}
.mw-top em{font-style:normal;font-size:9px;color:#6c7c94}
.mw-kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.mw-kpis>div{padding:6px 7px;border-radius:8px;background:#edf2fa}
.mw-kpis small{display:block;font-size:8px;color:#6c7b91}
.mw-kpis b{display:block;font-size:12px;color:#1e293b;margin-top:1px}
.mw-chart{display:block;border-radius:8px;background:#eef3fb}
.pv-img-thumb{
  position:relative;height:78px;border-radius:12px;overflow:hidden;
  background:radial-gradient(circle at 28% 34%, #6a8ec4 0%, #34568a 58%, #1f365c 100%);
  border:1px solid #cbd5e4;
}
.pv-art{position:relative;width:100%;height:100%;display:grid;place-items:center}
.pv-art-ring{
  position:absolute;width:128px;height:128px;border-radius:50%;
  border:1.5px solid rgba(255,255,255,0.28);box-shadow:0 0 0 22px rgba(255,255,255,0.08);
}
.pv-art-pill{
  position:relative;z-index:2;display:inline-flex;align-items:center;gap:7px;
  padding:6px 12px;border-radius:999px;background:rgba(18,30,52,0.44);
  border:1px solid rgba(255,255,255,0.34);color:#ffffff;font-size:10px;font-weight:600;
}

/* Poster 07: Dynamic Island & Live Activity */
.p7-left{top:406px;width:348px}
.p7-di-compact{
  margin-top:18px;width:216px;height:42px;border-radius:21px;background:#0c1016;
  padding:0 16px;display:flex;align-items:center;justify-content:space-between;
  color:#ffffff;box-shadow:0 14px 28px rgba(25,37,56,0.24);
}
.di-c-l,.di-c-r{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:700}
.di-c-r{color:#f5c475}
.di-c-m{width:54px;height:10px;border-radius:5px;background:#171d26}

.p7-di-expanded{
  margin-top:14px;padding:16px 18px;border-radius:26px;background:#0b0e13;color:#ffffff;
  box-shadow:0 18px 36px rgba(24,36,56,0.24);
}
.p7-push-card{
  margin-top:10px;padding:15px 16px;border-radius:22px;background:rgba(244,247,253,0.92);
  display:flex;align-items:center;gap:14px;
  box-shadow:10px 14px 28px rgba(120,141,172,0.26),-6px -6px 16px rgba(255,255,255,0.92),inset 0 0 0 1px rgba(255,255,255,0.85);
}
.notif-badge-lg{
  width:42px;height:42px;border-radius:12px;flex:none;display:grid;place-items:center;
  background:linear-gradient(145deg,#3a5f96,#254372);
  box-shadow:0 4px 10px rgba(47,82,135,0.3);
}
.p7-push-meta{flex:1;min-width:0}
.p7-push-meta>div{display:flex;justify-content:space-between;font-size:11px;color:#62738b;margin-bottom:2px}
.p7-push-meta strong{display:block;font-size:14.5px;color:#1b2535;font-weight:700}
.p7-push-meta span{display:block;font-size:11.5px;color:#5f7088;margin-top:2px}
.p7-bottom-note{margin:24px 0 0;font-size:16.5px;color:#4f6079;font-weight:500}
.p7-bell-badge{
  position:absolute;right:84px;top:178px;width:76px;height:76px;border-radius:24px;z-index:5;
  background:#edf2fa;display:grid;place-items:center;transform:rotate(6deg);
  box-shadow:10px 14px 26px rgba(126,147,178,0.26),-6px -6px 16px rgba(255,255,255,0.92),inset 0 0 0 1px rgba(255,255,255,0.8);
}
.p7-bell-badge i{position:absolute;right:16px;top:16px;width:7px;height:7px;border-radius:50%;background:#2f5287}

.app-lock{flex:1;display:flex;flex-direction:column;padding:12px 16px 24px;min-height:0}
.lk-lock{text-align:center;margin-top:10px}
.lk-date{text-align:center;font-size:13px;font-weight:600;color:#526885;margin-top:6px}
.lk-clock{text-align:center;font-size:74px;line-height:1;font-weight:700;letter-spacing:-3.5px;color:#476186;margin:4px 0 28px}
.la-card{
  background:#0a0d12;color:#ffffff;border-radius:24px;padding:15px 16px;
  box-shadow:0 12px 26px rgba(30,44,68,0.22);
}
.la-top{display:flex;align-items:center;justify-content:space-between;font-size:11.5px;color:#cdd2da;margin-bottom:10px}
.la-top span{display:flex;align-items:center;gap:6px;font-weight:500}
.la-amber{color:#f5c475!important;font-weight:650}
.la-green{color:#7dd6ac!important;font-weight:650}
.la-title{display:flex;align-items:center;gap:7px;font-size:14.5px;margin-bottom:4px}
.la-title strong{font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.la-sub{font-size:11.5px;color:#9ea5b0}
.la-foot{display:flex;align-items:center;justify-content:space-between;font-size:10.5px;color:#c7ccd4;padding-top:12px}
.la-foot>span{display:flex;align-items:center;gap:4px}
.la-run-dot{width:5px;height:5px;border-radius:50%;background:#7dd6ac;display:inline-block}
.la-more{
  display:flex;align-items:center;gap:6px;margin-top:10px;padding-top:9px;
  border-top:1px solid rgba(255,255,255,0.14);font-size:10.5px;color:#959ca7;
}
.lk-notif{
  margin-top:12px;padding:12px 14px;border-radius:20px;background:rgba(245,248,253,0.88);
  box-shadow:0 6px 18px rgba(84,106,138,0.14);
}
.lk-notif-hdr{display:flex;align-items:center;gap:7px;font-size:11px;color:#55657c;margin-bottom:5px}
.lk-notif-hdr b{font-weight:650}
.lk-notif-hdr small{margin-left:auto;color:#8291a6;font-size:10px}
.notif-sq{
  width:18px;height:18px;border-radius:5px;display:grid;place-items:center;
  background:#2f5287;
}
.lk-notif-body strong{display:block;font-size:12.5px;color:#1f2a3a;font-weight:650}
.lk-notif-body span{display:block;font-size:11px;color:#5e6f86;margin-top:1px}
.lk-shortcuts{
  margin-top:auto;display:flex;justify-content:space-between;padding:0 18px 8px;
}
.lk-shortcuts span{
  width:38px;height:38px;border-radius:50%;display:grid;place-items:center;
  background:rgba(182,196,216,0.38);
}

/* Poster 08: System Share */
.p8-left{top:418px}
.p8-steps{margin-top:24px;display:flex;flex-direction:column;gap:14px}
.p8-step{
  display:flex;align-items:flex-start;gap:13px;padding:15px 16px;border-radius:18px;background:#edf2f9;
  box-shadow:8px 10px 22px rgba(126,147,178,0.22),-6px -6px 16px rgba(255,255,255,0.9),inset 0 0 0 1px rgba(255,255,255,0.74);
}
.p8-step-num{
  width:28px;height:28px;border-radius:9px;flex:none;display:grid;place-items:center;
  background:#e1e9f5;color:#2f5287;font-size:12px;font-weight:700;
}
.p8-step b{display:block;font-size:15px;color:#1c2636;font-weight:700}
.p8-step small{display:block;font-size:12.5px;color:#5d6e85;margin-top:3px;line-height:1.45}

.app-share{flex:1;display:flex;flex-direction:column;background:#ccd5e2;min-height:0}
.sh-backdrop{height:38px;padding:6px 18px 0;display:flex;align-items:center;justify-content:center}
.sh-peek-doc{
  width:88%;height:26px;border-radius:10px 10px 0 0;background:rgba(244,247,252,0.55);
  display:grid;place-items:center;font-size:9.5px;color:#5b6a82;
}
.sh-sheet{
  flex:1;display:flex;flex-direction:column;background:#eef2f8;
  border-radius:24px 24px 0 0;box-shadow:0 -8px 24px rgba(45,62,88,0.14);
  overflow:hidden;
}
.sh-handle{display:flex;justify-content:center;padding:8px 0 4px}
.sh-handle i{width:34px;height:4px;border-radius:2px;background:#c4cedd}
.sh-hdr{display:flex;align-items:center;justify-content:space-between;padding:4px 14px 10px}
.sh-hdr b{font-size:15px;font-weight:700;color:#1d2736}
.sh-x{width:28px;height:28px;border-radius:50%;background:#e3e9f3;display:grid;place-items:center}
.sh-body{flex:1;padding:0 14px;display:flex;flex-direction:column;gap:10px;overflow:hidden}
.sh-file-card{
  display:flex;align-items:center;gap:10px;padding:11px 12px;border-radius:14px;background:#ffffff;
  box-shadow:0 2px 8px rgba(96,115,146,0.08);
}
.sh-file-ico{
  width:36px;height:36px;border-radius:10px;flex:none;display:grid;place-items:center;
  background:rgba(47,82,135,0.1);
}
.sh-file-meta{flex:1;min-width:0}
.sh-file-meta b{display:block;font-size:12px;color:#1f2a3a;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sh-file-meta small{display:block;font-size:10px;color:#6c7b91;margin-top:2px}
.sh-note{
  padding:10px 12px;border-radius:12px;background:#ffffff;font-size:11.5px;line-height:1.45;color:#273446;
  border:1px solid #dfe6f2;
}
.sh-group-lbl{font-size:10.5px;font-weight:650;color:#6b7a90;padding-left:4px;margin-top:2px}
.sh-targets{background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 2px 8px rgba(96,115,146,0.08)}
.sh-row{
  display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid #edf1f7;
}
.sh-row:last-child{border-bottom:none}
.sh-row.is-sel{background:#f4f8ff}
.sh-row-meta{flex:1;min-width:0}
.sh-row-meta b{display:block;font-size:12px;color:#1f2a3a;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sh-row-meta small{display:block;font-size:9.8px;color:#6e7e94;margin-top:1px}
.sh-chk{
  width:18px;height:18px;border-radius:50%;border:1.5px solid #c5d0df;flex:none;
  display:grid;place-items:center;
}
.sh-chk.is-on{background:#2f5287;border-color:#2f5287}
.sh-new b{flex:1;font-size:12px;color:#2f5287;font-weight:600}
.sh-plus{width:18px;display:grid;place-items:center}
.sh-foot{
  padding:10px 14px 20px;background:#f5f8fc;border-top:1px solid #e1e8f3;
  display:flex;flex-direction:column;gap:6px;
}
.sh-primary{
  height:40px;border-radius:12px;background:#2f5287;color:#ffffff;
  display:grid;place-items:center;font-size:12.5px;font-weight:650;
}
.sh-secondary{height:28px;display:grid;place-items:center;font-size:11.5px;color:#2f5287;font-weight:500}

/* Poster 09: End-to-End Encryption & Privacy */
.p9-left{top:412px;width:342px}
.p9-tunnel-card{
  padding:18px 16px;border-radius:20px;background:#edf2f9;
  box-shadow:10px 14px 28px rgba(124,145,175,0.26),-7px -7px 18px rgba(255,255,255,0.92),inset 0 0 0 1px rgba(255,255,255,0.75);
}
.p9-tunnel-nodes{display:flex;align-items:center;justify-content:space-between;gap:8px}
.p9-node{display:flex;flex-direction:column;align-items:center;gap:6px;flex:none}
.p9-node span{
  width:46px;height:46px;border-radius:15px;display:grid;place-items:center;background:#e5ecf6;
  box-shadow:inset 2px 2px 4px rgba(162,175,196,0.48),inset -2px -2px 4px rgba(255,255,255,0.88);
}
.p9-node small{font-size:11px;font-weight:650;color:#334259}
.p9-tunnel-mid{flex:1;display:flex;flex-direction:column;align-items:center;gap:5px;min-width:0}
.p9-lock-tag{
  display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:999px;
  background:rgba(26,106,77,0.12);color:#1a6a4d;font:700 10px "SF Mono",ui-monospace,Menlo,monospace;
  white-space:nowrap;
}
.p9-wire{width:100%;height:2px;background:repeating-linear-gradient(90deg,#1a6a4d 0 5px,transparent 5px 9px);opacity:0.55}
.p9-tunnel-mid em{font-style:normal;font-size:10px;color:#5e6f88;white-space:nowrap}

.p9-pillars{margin-top:20px;display:flex;flex-direction:column;gap:14px}
.p9-pillar{
  display:flex;align-items:flex-start;gap:12px;padding:15px 15px;border-radius:18px;background:#edf2f9;
  box-shadow:8px 10px 20px rgba(126,147,178,0.22),-6px -6px 16px rgba(255,255,255,0.9),inset 0 0 0 1px rgba(255,255,255,0.74);
}
.p9-ic{
  width:34px;height:34px;border-radius:11px;flex:none;display:grid;place-items:center;background:#e4ebf5;
  box-shadow:inset 2px 2px 4px rgba(162,175,196,0.45),inset -2px -2px 4px rgba(255,255,255,0.88);
}
.p9-pillar b{display:block;font-size:14.5px;color:#1b2535;font-weight:700}
.p9-pillar small{display:block;font-size:12px;color:#5d6e85;margin-top:3px;line-height:1.48}

.app-priv{flex:1;display:flex;flex-direction:column;background:#dce3ef;min-height:0}
.pr-top{display:flex;align-items:center;justify-content:space-between;padding:4px 18px 10px;opacity:0.75}
.pr-title{font-size:15px;font-weight:700;color:#273446}
.pr-conn-chip{
  display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:999px;
  background:#eaf0f8;font-size:9.5px;font-weight:650;color:#1a6a4d;
}
.pr-sheet{
  flex:1;background:#e6ebf4;border-radius:24px 24px 0 0;padding:12px 15px 22px;
  box-shadow:0 -8px 22px rgba(45,62,88,0.12);display:flex;flex-direction:column;
}
.pr-sheet-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.pr-sheet-hdr b{font-size:15px;font-weight:700;color:#1e293b}
.pr-hero{
  padding:16px 12px;border-radius:18px;background:#ebf0f8;text-align:center;margin-bottom:12px;
  box-shadow:4px 4px 10px rgba(166,178,198,0.48),-4px -4px 10px rgba(255,255,255,0.88);
}
.pr-shield-orb{
  width:52px;height:52px;border-radius:50%;margin:0 auto 9px;display:grid;place-items:center;
  background:#e4ecf6;
  box-shadow:inset 2.5px 2.5px 6px rgba(160,174,196,0.5),inset -2.5px -2.5px 6px rgba(255,255,255,0.9);
}
.pr-hero strong{display:block;font-size:14.5px;color:#1a6a4d;font-weight:700}
.pr-hero code{display:block;margin-top:4px;font:9.5px "SF Mono",ui-monospace,Menlo,monospace;color:#5f7088}
.pr-rows{
  padding:4px 13px;border-radius:16px;background:#ebf0f8;margin-bottom:12px;
  box-shadow:3px 3px 8px rgba(166,178,198,0.44),-3px -3px 8px rgba(255,255,255,0.88);
}
.pr-row{
  display:flex;align-items:center;justify-content:space-between;
  padding:9px 0;border-bottom:1px solid rgba(180,192,210,0.34);font-size:12px;
}
.pr-row:last-child{border-bottom:none}
.pr-row span{color:#556479}
.pr-row b{font-weight:650;color:#1f2a3a}
.pr-ok{color:#1a6a4d!important}
.pr-pill-ok{
  display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;
  background:#e2e9f3;color:#1a6a4d!important;font-size:11px;
}
.pr-sec-lbl{font-size:10px;font-weight:650;color:#6c7b91;padding-left:4px;margin-bottom:6px}
.pr-host-sel{
  display:flex;align-items:center;gap:9px;padding:10px 12px;border-radius:14px;background:#e6ebf4;
  box-shadow:inset 2px 2px 5px rgba(164,176,196,0.5),inset -2px -2px 5px rgba(255,255,255,0.88);
  font-size:12px;color:#2f5287;
}
.pr-host-sel small{margin-left:auto;font-size:10px;color:#6e7d94}
.pr-radio{
  width:17px;height:17px;border-radius:50%;display:grid;place-items:center;
  box-shadow:inset 1.5px 1.5px 3px rgba(160,172,192,0.55),inset -1.5px -1.5px 3px rgba(255,255,255,0.88);
}
.pr-radio.is-on i{width:7px;height:7px;border-radius:50%;background:#2f5287;display:block}
.pr-priv-card{
  padding:11px 13px;border-radius:15px;background:#ebf0f8;
  box-shadow:3px 3px 8px rgba(166,178,198,0.44),-3px -3px 8px rgba(255,255,255,0.88);
}
.pr-tog-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:5px}
.pr-tog-row b{font-size:12px;color:#1f2a3a}
.pr-toggle{
  width:34px;height:19px;border-radius:10px;background:#dce4f0;padding:2px;display:flex;align-items:center;
  box-shadow:inset 1.5px 1.5px 3px rgba(154,168,190,0.5),inset -1.5px -1.5px 3px rgba(255,255,255,0.88);
}
.pr-toggle i{width:15px;height:15px;border-radius:50%;background:#f5f8fd;box-shadow:1px 1px 3px rgba(130,145,168,0.45)}
.pr-priv-card small{display:block;font-size:9.8px;line-height:1.45;color:#64748b}
.pr-reconn-btn{
  margin-top:auto;height:38px;border-radius:13px;background:#e8edf6;
  display:flex;align-items:center;justify-content:center;gap:6px;
  font-size:11.5px;font-weight:650;color:#2f5287;
  box-shadow:3px 3px 7px rgba(164,176,196,0.46),-3px -3px 7px rgba(255,255,255,0.88);
}
"""


def wrap_html(title: str, body: str) -> str:
    return (
        "<!doctype html><html lang='zh-CN'><meta charset='utf-8'>"
        f"<title>Orbis — {title}</title>"
        f"<style>{CSS}</style><body>{body}</body></html>"
    )


def chrome_shot(html_path: Path, png_path: Path, width: int, height: int, scale: int, profile_dir: Path) -> None:
    cmd = [
        CHROME_BIN,
        "--headless=new",
        f"--user-data-dir={profile_dir}",
        "--disable-gpu",
        "--no-sandbox",
        "--hide-scrollbars",
        f"--window-size={width},{height}",
        f"--force-device-scale-factor={scale}",
        f"--screenshot={png_path}",
        html_path.as_uri(),
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0 or not png_path.exists():
        raise RuntimeError(f"Chrome failed for {html_path.name}: {res.stderr[-600:]}")


def png_to_jpg(png_path: Path, jpg_path: Path, quality: int = 93) -> None:
    res = subprocess.run(
        ["/usr/bin/sips", "-s", "format", "jpeg", "-s", "formatOptions", str(quality), str(png_path), "--out", str(jpg_path)],
        capture_output=True,
        text=True,
    )
    if res.returncode != 0:
        raise RuntimeError(f"sips failed for {png_path.name}: {res.stderr}")


def main() -> None:
    builders = [
        build_poster_01,
        build_poster_02,
        build_poster_03,
        build_poster_04,
        build_poster_05,
        build_poster_06,
        build_poster_07,
        build_poster_08,
        build_poster_09,
    ]
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    tmp_root = Path(tempfile.mkdtemp(prefix="orbis-promo-render-"))
    profile_dir = tmp_root / "chrome-profile"
    profile_dir.mkdir(parents=True, exist_ok=True)
    rendered: list[tuple[str, Path]] = []

    try:
        for builder in builders:
            slug, body = builder()
            html_file = tmp_root / f"{slug}.html"
            png_file = tmp_root / f"{slug}.png"
            jpg_file = OUT_DIR / f"{slug}.jpg"
            html_file.write_text(wrap_html(slug, body), encoding="utf-8")
            chrome_shot(html_file, png_file, 900, 1200, 2, profile_dir)
            png_to_jpg(png_file, jpg_file, quality=93)
            rendered.append((slug, jpg_file))
            print(f"Rendered {jpg_file.name} ({jpg_file.stat().st_size // 1024} KB)")

        # Build 3x3 contact sheet for fast visual review (saved in .artifacts, not cluttering promo dir)
        artifacts_dir = REPO_ROOT / ".artifacts/promo-refresh"
        artifacts_dir.mkdir(parents=True, exist_ok=True)
        items_html = "".join(
            f'<div class="item"><img src="{data_uri(p)}" alt="{slug}"><span>{slug}</span></div>'
            for slug, p in rendered
        )
        sheet_html = f"""<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
          *{{box-sizing:border-box}}html,body{{margin:0;padding:0;width:1200px;height:1680px;overflow:hidden;background:#cfd8e5;font-family:-apple-system,"PingFang SC",sans-serif}}
          .wrap{{padding:24px}}
          .head{{display:flex;justify-content:space-between;align-items:baseline;padding-bottom:12px;margin-bottom:16px;border-bottom:1px solid #96a8c266;color:#283d5c}}
          .head h1{{margin:0;font-size:26px;letter-spacing:-0.8px}}
          .head span{{font-size:12px;font-weight:600;color:#4f6482}}
          .grid{{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}}
          .item img{{width:100%;display:block;border-radius:10px;box-shadow:0 6px 16px rgba(37,54,80,0.2)}}
          .item span{{display:block;margin-top:6px;font-size:11px;color:#3f5370;text-align:center;font-weight:600}}
        </style><body><div class="wrap">
          <div class="head"><h1>Orbis Promo — 9 Posters</h1><span>9 张 · 1800 × 2400 · 3×3 九宫格</span></div>
          <div class="grid">{items_html}</div>
        </div></body></html>"""
        sheet_html_file = tmp_root / "00-contact-sheet.html"
        sheet_png_file = tmp_root / "00-contact-sheet.png"
        sheet_jpg_file = artifacts_dir / "00-contact-sheet.jpg"
        sheet_html_file.write_text(sheet_html, encoding="utf-8")
        chrome_shot(sheet_html_file, sheet_png_file, 1200, 1680, 1, profile_dir)
        png_to_jpg(sheet_png_file, sheet_jpg_file, quality=92)
        print(f"Contact sheet: {sheet_jpg_file}")
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


if __name__ == "__main__":
    main()
