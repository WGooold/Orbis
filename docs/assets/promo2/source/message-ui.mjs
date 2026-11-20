// Promotional examples use the app's resting message geometry. Values come from
// OrbisDesign.swift, ChatMessageRow.swift, ChatMarkdownView.swift and the widget.
// These are reconstructed example screens, not device-capture evidence.
export function makeMessageUI({ agentUri, orbisUri, pairingMarkUri }) {
  const paths = {
    back: '<path d="M19 12H5m7-7-7 7 7 7"/>',
    down: '<path d="M12 3v14m-6-6 6 6 6-6M4 21h16"/>',
    up: '<path d="M12 21V4m-7 7 7-7 7 7"/>',
    history: '<path d="M3 11a9 9 0 1 1 2.3 7M3 4v7h7m2-5v6l4 3"/>',
    copy: '<rect x="8" y="7" width="12" height="15" rx="2"/><path d="M15 7V3a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h4"/>',
    attach: '<path d="m8 13 7-7a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L13 2a4 4 0 0 1 6 6L8 19a2 2 0 0 1-3-3L16 5"/>',
    folder: '<path d="M3 7h18v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l3 4"/>',
    branch: '<circle cx="6" cy="4" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="12" cy="20" r="2"/><path d="M6 6v3c0 4 6 3 6 7v2m6-11v2c0 4-6 3-6 7"/>',
    shield: '<path d="m12 2 8 3v6c0 5-4 8-8 11-4-3-8-6-8-11V5l8-3Z"/><path d="M12 2v20"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    scan: '<path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3"/><path d="M7 7h4v4H7zm7 0h3v4h-3zM7 14h4v3H7zm7 0v3h3v-3"/>',
    close: '<path d="m5 5 14 14M19 5 5 19"/>',
    desktop: '<rect x="2" y="3" width="20" height="14" rx="1.5"/><path d="M8 22h8m-4-5v5"/>',
    stack: '<rect x="7" y="2" width="14" height="15" rx="2"/><path d="M16 21H4a2 2 0 0 1-2-2V8"/>',
    arrowOut: '<path d="M5 19 19 5M6 5h13v13"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    tool: '<path d="m5 5 6 6-6 6m9 1h6"/>',
    sidebar: '<rect x="2" y="3" width="20" height="18" rx="3"/><path d="M9 3v18"/>',
    wifi: '<path d="M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0m-11 4a6 6 0 0 1 8 0"/><circle cx="12" cy="20" r="1" fill="currentColor" stroke="none"/>',
    photo: '<rect x="2" y="3" width="20" height="18" rx="3"/><circle cx="8" cy="9" r="2"/><path d="m2 17 6-5 5 4 4-7 5 8"/>',
    flash: '<path d="M8 2h8v5l-2 3v12h-4V10L8 7V2Zm0 4h8"/>',
    camera: '<rect x="2" y="6" width="20" height="15" rx="3"/><path d="m7 6 2-4h6l2 4"/><circle cx="12" cy="13" r="4"/>',
  };
  const glyph = (name, size = 20) => `<svg class="app-glyph" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.check}</svg>`;
  const nativeAgent = (id = 'codex', size = 17, mono = false) => {
    if (!mono && (id === 'pi' || id === 'claude')) return `<img class="app-agent app-agent-${id}" src="${agentUri(id)}" width="${size}" height="${size}" alt="">`;
    const color = mono ? 'currentColor' : id === 'deepseek' ? 'var(--deepseek,#3550cf)' : 'var(--codex,#00655d)';
    return `<span class="app-agent app-agent-${id}" style="width:${size}px;height:${size}px;background:${color};mask:url('${agentUri(id)}') center/contain no-repeat;-webkit-mask:url('${agentUri(id)}') center/contain no-repeat"></span>`;
  };
  const orbis = (size = 18) => `<span class="app-orbis" style="width:${size}px;height:${size}px;mask:url('${orbisUri}') center/contain no-repeat;-webkit-mask:url('${orbisUri}') center/contain no-repeat"></span>`;
  const button = (name, cls = '') => `<span class="app-button ${cls}">${glyph(name, 22)}</span>`;
  const copy = () => `<span class="message-copy">${glyph('copy', 14)}</span>`;
  const status = (island = '') => `<div class="app-status"><b>9:41</b><div class="app-island">${island}</div><div class="status-icons"><span class="signal-bars"><i></i><i></i><i></i><i></i></span>${glyph('wifi', 15)}<span class="battery"><i></i></span></div></div>`;
  const header = ({ title, id = 'codex', label = 'GPT-5.4 · high', fold = false }) => `<div class="app-header">${button('back')}${fold ? button('sidebar') : ''}<div class="app-chat-title"><div>${nativeAgent(id, 17)}<b>${title}</b></div><small><i class="idle-dot"></i>空闲 ${label ? `<span>${label}</span>` : ''}</small></div>${button('history')}${button('down')}</div>`;
  const composer = (label = 'Codex') => `<div class="app-composer"><div class="workspace"><span>${glyph('folder', 13)}<code>/Projects/orbis</code>${glyph('branch', 13)}<code>main</code></span><span class="permissions">${glyph('shield', 13)}工作区写入${glyph('chevron', 12)}</span></div><div class="composer-row">${button('attach','attachment')}<div class="composer-field">发给 ${label}，/ 命令</div>${button('up','send-disabled')}</div><div class="app-home-indicator"><i></i></div></div>`;
  const user = (text) => `<div class="app-message user-message" data-message><p>${text}</p></div>`;
  const reply = (id, name, content) => `<div class="app-message assistant-message" data-message style="--agent:${id === 'deepseek' ? 'var(--deepseek)' : 'var(--codex)'}"><div class="assistant-identity">${nativeAgent(id)}<b>${name}</b>${copy()}</div><div class="message-prose">${content}</div></div>`;
  const code = (language, text) => `<div class="message-code"><div><span>${language}</span>${copy()}</div><pre>${text}</pre></div>`;
  const tex = (source, display = false) => `<span class="${display ? 'tex-block' : 'tex-inline'}" data-tex="${source.replace(/"/g, '&quot;')}"></span>`;
  const screen = (name, title, messages, options = {}) => ({ name, width: 393, height: 852, theme: options.dark ? 'dark' : 'light', html: `<main class="app-ui ${options.dark ? 'app-dark' : ''} ${options.id === 'deepseek' ? 'app-dsh' : ''}">${status()}${header({ title, ...options })}<div class="app-transcript">${messages}</div>${composer(options.id === 'deepseek' ? 'DSH' : 'Codex')}</main>` });

  const cover = screen('chat-cover', '登录页细节调整',
    user('帮我把登录页改得更清爽。') +
    reply('codex', 'Codex', '<p>已收紧留白，统一输入框和按钮的样式。</p><p>桌面和手机的布局也一起对齐了。</p>' + code('css', '.login-card {\n  gap: 16px;\n  border-radius: 24px;\n}')) +
    user('按钮再大一点。') +
    reply('codex', 'Codex', '<p>已扩大点击范围，文字与图标保持居中。</p>'));

  const math = screen('chat-math', '实验指标公式整理',
    user('整理一下评估指标的公式和对照表。') +
    reply('codex', 'Codex', '<p>相邻变化与初始基线分别为：</p>' +
      `<div class="message-formula">${tex(String.raw`\begin{aligned}\hat d_t&=g_\theta(X_t)-g_\theta(X_{t-1})\\[5pt]\hat R_t&=g_\theta(X_t)-g_\theta(X_0)\end{aligned}`, true)}</div>` +
      '<div class="message-table"><table><thead><tr><th>指标</th><th>含义</th></tr></thead><tbody><tr><td>' + tex(String.raw`\hat d_t`) + '</td><td>相邻时刻的变化</td></tr><tr><td>' + tex(String.raw`\hat R_t`) + '</td><td>相对初始基线</td></tr></tbody></table></div>' +
      '<p>加权分可写为：</p><div class="message-formula formula-short">' + tex(String.raw`S=\frac{\sum_{i=1}^{6} w_iR_i}{15}+|x|`, true) + '</div>' +
      '<p>例如，一个 2 × 2 矩阵：</p><div class="message-formula formula-short">' + tex(String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}`, true) + '</div>'));

  const deepseek = screen('chat-deepseek', '接口联调与测试补充',
    user('把回归结果和改动文件整理一下。') +
    reply('deepseek', 'DSH', '<p>回归检查已完成，未发现失败用例。</p><p><strong>本次修改</strong></p><ul><li>补齐登录失败时的提示</li><li>保留返回页面前的输入</li><li>统一按钮与输入框的间距</li></ul><p>在手机上也能接着核对改动。</p>') +
    user('新增的校验也补上。') +
    reply('deepseek', 'DSH', '<p>已补充空输入与超时场景，测试通过。</p>'), { id: 'deepseek', label: '' });

  const details = screen('chat-details', '长对话阅读体验',
    user('翻旧消息时，先别把我拉回底部。') +
    reply('codex', 'Codex', '<p>已保留当前阅读位置。</p><p>新回复到来时，你可以继续阅读，再自行回到最新消息。</p>' +
      code('swift', 'if isNearBottom {\n    scrollToLatest()\n}') +
      '<p>切换会话后，草稿也会保留。</p>') +
    user('这段代码发给我。') +
    reply('codex', 'Codex', '<p>已整理好，可以直接复制。</p>'));

  const reading = { name: 'duo-reading', width: 393, height: 260, theme: 'light', html: `<main class="app-ui fold-reading"><div class="fold-status"><b>9:41</b>${glyph('wifi', 14)}</div><div class="app-transcript">${user('把阅读区和操作区分开。')}${reply('codex', 'Codex', '<p>已调整。上屏阅读消息，下屏继续输入和操作。</p>')}</div></main>` };
  const controls = { name: 'duo-controls', width: 393, height: 266, theme: 'light', html: `<main class="app-ui fold-controls">${header({ title: '整理工作区', label: 'GPT-5.4 · high', fold: true })}<div class="fold-touchpad"></div>${composer()}</main>` };

  const liveCard = ({ attention = false, aggregate = false, agentId = 'codex', title = '完善登录页交互', headline = '约 3 分钟', others = '', compact = false, expanded = false } = {}) => `<section class="live-message ${attention ? 'live-attention' : ''} ${compact ? 'live-compact' : ''} ${expanded ? 'live-expanded' : ''}" data-message><div class="live-source">${glyph('desktop', 16)}<span>工作电脑</span><b>${headline}</b></div><div class="live-title">${aggregate ? orbis(18) : nativeAgent(agentId, 18, true)}<strong>${title}</strong></div><p>${agentId === 'claude' ? 'Claude' : 'Codex'} · ${attention ? '需要你处理' : '正在执行任务'}</p><div class="live-state"><span>${attention ? '<i class="attention-sign">!</i>' : '<i class="running-dot"></i>'}${attention ? '等待你处理' : '运行中'}</span><span>${attention ? '查看请求' : '打开会话'}${glyph('arrowOut', 10)}</span></div>${others ? `<div class="live-others">${glyph('stack', 12)}${others}</div>` : ''}</section>`;
  const lockscreen = (cover = false) => ({ name: cover ? 'lock-cover' : 'lock-attention', width: 393, height: 852, theme: 'lock', html: `<main class="app-ui app-lock">${status(`<span>工作电脑</span><span>${cover ? '2 个' : '<i class="attention-sign">!</i> 1'}</span>`)}<div class="lock-calendar">11月18日 星期三</div><div class="lock-clock">9:41</div><div class="lock-messages">${liveCard({ attention: !cover, aggregate: true, agentId: cover ? 'codex' : 'claude', title: cover ? '完善登录页交互' : '实现项目仪表盘界面', headline: cover ? '2 个运行中' : '1 项待处理', others: cover ? '另有 1 个会话运行中' : '另有 2 个会话运行中' })}${cover ? '' : `<div class="system-notification" data-message><div class="notification-app">${orbis(18)}<b>Orbis</b><small>现在</small></div><strong>工作电脑</strong><p>任务已完成</p></div>`}</div><div class="lock-shortcut-row"><span>${glyph('flash', 20)}</span><span>${glyph('camera', 21)}</span></div><div class="app-home-indicator"><i></i></div></main>` });
  const pairing = (scan = false) => ({
    name: scan ? 'pair-scan' : 'pair-entry', width: 393, height: 852, theme: 'light',
    html: `<main class="app-ui pair-app ${scan ? 'pair-app-scanner' : ''}">${status()}
      ${scan ? `<div class="pair-sheet"><header>${button('close')}<b>扫描配对二维码</b></header>
        <div class="pair-camera"><svg viewBox="0 0 340 340" aria-hidden="true">
          <defs><linearGradient id="room" x2="1" y2="1" gradientUnits="objectBoundingBox"><stop stop-color="#77786e"/><stop offset="1" stop-color="#323435"/></linearGradient><linearGradient id="monitor" x2="1" y2="1" gradientUnits="objectBoundingBox"><stop stop-color="#b3bdc3"/><stop offset="1" stop-color="#758a9c"/></linearGradient><filter id="soft"><feGaussianBlur stdDeviation="3"/></filter></defs>
          <rect width="340" height="340" fill="url(#room)"/><g filter="url(#soft)"><path d="M0 268L340 255V340H0Z" fill="#81766a"/><g transform="rotate(-7 177 159)"><path d="M165 219h18l5 42h-29z" fill="#424447"/><rect x="129" y="260" width="90" height="6" rx="3" fill="#575451"/><rect x="53" y="72" width="245" height="153" rx="10" fill="#292d30"/><rect x="61" y="80" width="229" height="136" rx="4" fill="url(#monitor)"/><path d="M61 80h54v136H61z" fill="#a9b4bc"/><rect x="145" y="110" width="96" height="61" rx="9" fill="#cbd2d2"/><rect x="164" y="128" width="59" height="5" rx="2.5" fill="#78858c"/><rect x="163" y="143" width="63" height="10" rx="4" fill="#9ca9ad"/></g><path d="M22 283l160-6 38 16-162 12z" fill="#aaa39a"/></g>
        </svg></div>
        <div class="pair-photo">${glyph('photo',19)}从相册选图</div>
        <div class="pair-action pair-cancel">取消</div></div>` : `<header class="pair-entry-header">Orbis</header>
        <div class="pair-entry-body">
          <span class="pair-app-mark"><img src="${pairingMarkUri}" alt=""></span>
          <h2>连接你的电脑</h2>
          <div class="pair-action pair-primary">${glyph('scan',20)}扫码配对</div>
          <div class="pair-entry-divider">手动输入</div>
          <div class="pair-action pair-paste">${glyph('copy',18)}粘贴配对二维码内容${glyph('chevron',14)}</div>
        </div>`}
      <div class="app-home-indicator"><i></i></div></main>`,
  });
  return { screens: [cover,lockscreen(true),lockscreen(false),math,deepseek,reading,controls,details,pairing(),pairing(true)], glyph,nativeAgent,orbis,liveCard };
}

export const messageCSS = String.raw`
.app-ui{--base:#e6ebf4;--lift:#edf1f8;--text:#232a36;--secondary:#4a5364;--faint:#737d90;--shadow:#a6b2c6;--light:#fff;--codex:#00655d;--deepseek:#3550cf;--agent:var(--codex);position:relative;width:100%;height:100%;display:flex;flex-direction:column;overflow:hidden;background:var(--base);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Helvetica Neue',sans-serif;font-size:15px;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
.app-ui *{box-sizing:border-box}
.app-dark{--base:#23262e;--lift:#292d36;--text:#dde1e9;--secondary:#b8c0ce;--faint:#858d9c;--shadow:#0a0c11;--light:#343946;--codex:#77d6c7;--deepseek:#a9bbff}
.app-glyph,.app-agent,.app-orbis{display:inline-block;vertical-align:middle;flex:none}
.app-agent{object-fit:contain}
.app-orbis{background:currentColor}
.app-status{height:59px;flex:none;padding:18px 27px 0;display:flex;align-items:flex-start;justify-content:space-between;color:var(--text);position:relative}
.app-status>b{font-size:16px;line-height:22px;letter-spacing:-.2px;font-weight:650}
.app-island{position:absolute;left:50%;top:10px;transform:translateX(-50%);width:124px;height:32px;border-radius:22px;background:#0a0c0f;color:#d8dce2}
.status-icons{display:flex;align-items:center;gap:5px;height:22px}
.signal-bars{display:flex;align-items:flex-end;gap:2px;height:11px}
.signal-bars i{display:block;width:3px;background:currentColor;border-radius:.8px}
.signal-bars i:nth-child(1){height:4px}.signal-bars i:nth-child(2){height:6px}.signal-bars i:nth-child(3){height:8px}.signal-bars i:nth-child(4){height:10px}
.battery{width:22px;height:11px;border:1px solid currentColor;border-radius:3px;padding:1px;position:relative;opacity:.95}
.battery:after{content:'';position:absolute;right:-3px;top:3px;width:1.5px;height:4px;border-radius:1px;background:currentColor}
.battery i{display:block;width:90%;height:100%;background:currentColor;border-radius:1px}
.app-header{display:flex;align-items:center;gap:12px;padding:8px 20px 12px;min-height:64px;flex:none}
.app-button{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;flex:none;background:var(--base);color:var(--secondary);box-shadow:2.6px 2.6px 2.6px #a6b2c65c,-2.6px -2.6px 2.6px #ffffff96}
.app-dark .app-button{box-shadow:2.6px 2.6px 2.6px #0a0c1174,-2.6px -2.6px 2.6px #34394686}
.app-chat-title{flex:1;min-width:0}
.app-chat-title>div{display:flex;gap:6px;align-items:center}
.app-chat-title b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px;line-height:20px;font-weight:600;letter-spacing:0}
.app-chat-title small{display:flex;align-items:center;gap:5px;margin-top:4px;font-size:12px;line-height:16px;color:var(--secondary);white-space:nowrap}
.app-chat-title small>span{margin-left:3px;overflow:hidden;text-overflow:ellipsis}
.idle-dot{border:1.4px solid var(--faint);width:7px;height:7px;border-radius:50%;margin:0 3px;flex:none}
.app-dsh{--agent:var(--deepseek)}
.app-dsh .permissions,.app-dsh .app-composer:before{display:none}
.app-transcript{flex:1;min-height:0;padding:12px 16px 24px;display:flex;flex-direction:column;gap:16px;overflow:hidden}
.app-message{flex:none;font-size:15px;line-height:22px;font-weight:400;letter-spacing:0}
.app-message p{margin:0}
.user-message{align-self:flex-end;max-width:calc(100% - 36px);padding:16px;border-radius:24px;background:var(--base);box-shadow:inset 2.6px 2.6px 2.6px #a6b2c65c,inset -2.6px -2.6px 2.6px #ffffff96}
.assistant-message{align-self:stretch;margin-right:8px;padding:16px;border-radius:24px;background:var(--base);box-shadow:2.6px 2.6px 2.6px #a6b2c65c,-2.6px -2.6px 2.6px #ffffff96}
.assistant-identity{display:flex;align-items:center;gap:6px;height:18px;margin-bottom:12px;color:var(--agent);font-size:12px;line-height:18px}
.assistant-identity>b{font-weight:600}
.message-copy{width:28px;height:28px;margin:-5px 0;margin-left:auto;border-radius:50%;background:var(--lift);color:var(--secondary);display:grid;place-items:center;flex:none}
.message-prose{display:flex;flex-direction:column;gap:12px}
.message-prose strong{font-weight:600}
.message-prose ul{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:8px}
.message-code{background:var(--base);border-radius:12px;padding:12px;box-shadow:inset 1.6px 1.6px 1.6px #a6b2c638,inset -1.6px -1.6px 1.6px #ffffff5c}
.message-code>div{display:flex;align-items:center;justify-content:space-between;color:var(--secondary);font:12px/18px ui-monospace,SFMono-Regular,Menlo,monospace;margin-bottom:10px}
.message-code pre{margin:0;font:13px/19px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre;color:var(--text);tab-size:4}
.message-code .message-copy{margin:-6px -4px -6px 0}
.message-formula{font-size:15px;line-height:1.5;color:var(--text);padding:4px 0;display:flex;justify-content:center;max-width:100%}
.message-formula .katex-display{margin:4px 0}
.message-formula .katex{font-size:1.12em}
.formula-short{padding:0}
.message-table{border-radius:12px;overflow:hidden;box-shadow:inset 1.6px 1.6px 1.6px #a6b2c630,inset -1.6px -1.6px 1.6px #ffffff50}
.message-table table{border-collapse:collapse;width:100%;font-size:13px;line-height:20px}
.message-table th,.message-table td{text-align:left;padding:10px;vertical-align:middle;font-weight:400}
.message-table th{font-weight:600;background:var(--lift)}
.message-table th:first-child,.message-table td:first-child{width:50%}
.message-table tr:nth-child(even){background:#edf1f866}
.message-table .katex{font-size:1.05em}
.message-tool{display:flex;gap:8px;align-items:center;padding:12px;border-radius:12px;background:var(--lift);font-size:13px;color:var(--secondary)}
.message-tool small{margin-left:auto;font-size:12px}
.app-dark .user-message{box-shadow:inset 2.6px 2.6px 2.6px #0a0c1174,inset -2.6px -2.6px 2.6px #34394686}
.app-dark .assistant-message{box-shadow:2.6px 2.6px 2.6px #0a0c1174,-2.6px -2.6px 2.6px #34394686}
.app-dark .message-code{box-shadow:inset 1.6px 1.6px 1.6px #0a0c1150,inset -1.6px -1.6px 1.6px #34394650}
.app-composer{flex:none;background:var(--base);padding:0 16px;position:relative}
.app-composer:before{content:'';position:absolute;left:0;right:0;top:0;height:1px;background:var(--agent);opacity:.17}
.workspace{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:36px;color:var(--secondary);font-size:12px;line-height:18px}
.workspace>span{display:flex;align-items:center;gap:7px;white-space:nowrap}
.workspace code{font:12px/18px ui-monospace,SFMono-Regular,Menlo,monospace}
.workspace .permissions{color:var(--agent);gap:5px}
.composer-row{display:flex;align-items:center;gap:10px;padding:7px 0 0}
.composer-row .attachment{color:var(--agent)}
.composer-field{display:flex;align-items:center;min-width:0;flex:1;height:54px;border-radius:16px;padding:14px 16px;color:var(--faint);font-size:15px;line-height:22px;white-space:nowrap;background:var(--base);box-shadow:inset 2.6px 2.6px 2.6px #a6b2c65c,inset -2.6px -2.6px 2.6px #ffffff96}
.send-disabled{color:var(--faint);box-shadow:none;border:1px solid #c9d1de}
.app-dark .composer-field{box-shadow:inset 2.6px 2.6px 2.6px #0a0c1174,inset -2.6px -2.6px 2.6px #34394686}
.app-dark .send-disabled{border-color:#3a4150}
.app-home-indicator{height:30px;display:flex;align-items:flex-end;justify-content:center;padding-bottom:8px;flex:none}
.app-home-indicator>i{width:126px;height:4px;border-radius:6px;background:var(--text);opacity:.85}
.fold-status{height:28px;display:flex;justify-content:flex-end;align-items:center;gap:7px;padding:4px 16px;font-size:11px;flex:none}
.fold-reading .app-transcript{padding:4px 16px 14px;gap:14px}
.fold-reading .user-message{padding:12px 16px}
.fold-reading .assistant-message{padding:16px}
.fold-controls .app-header{gap:8px;padding:10px 14px 8px;min-height:60px}
.fold-controls .app-button{width:34px;height:34px}
.fold-controls .app-button>.app-glyph{width:19px;height:19px}
.fold-controls .app-chat-title b{font-size:13px}
.fold-controls .app-chat-title small{font-size:11px;line-height:14px;margin-top:2px}
.fold-controls .fold-touchpad{flex:1;margin:2px 14px 8px}
.fold-controls .app-composer{padding:0 14px}
.fold-controls .workspace{min-height:30px}
.fold-controls .composer-field{height:42px;font-size:13px}
.fold-controls .composer-row{padding-top:4px}
.fold-controls .app-home-indicator{height:16px;padding-bottom:5px}
.fold-controls .app-home-indicator>i{height:3px;width:100px}
.app-lock{--text:#536982;background:radial-gradient(ellipse at 25% 12%,#f5f7fc,#dfe7f2 64%,#d5dfec)}
.app-lock .app-status{padding-top:15px}
.app-lock .app-status>b{opacity:0}
.app-lock .status-icons{margin-left:auto}
.app-lock .app-island{display:flex;align-items:center;justify-content:space-between;gap:5px;padding:0 10px;width:156px;height:32px;top:10px;font-size:10.5px;line-height:1;font-weight:500}
.app-lock .app-island>span:last-child{display:flex;align-items:center;gap:4px}
.lock-calendar{font-size:16px;font-weight:500;text-align:center;margin-top:20px;line-height:24px}
.lock-clock{text-align:center;font-size:86px;line-height:100px;letter-spacing:-4.5px;font-weight:600;color:#4d668a;margin-bottom:40px}
.lock-messages{padding:0 18px;display:flex;flex-direction:column;gap:14px}
.live-message{background:#080a0d;color:#fff;border-radius:28px;padding:18px;text-align:left;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;box-shadow:0 8px 20px #33425816}
.live-source{display:flex;align-items:center;gap:8px;color:#d5d7db;font-size:13px;line-height:18px;font-weight:500;margin-bottom:14px}
.live-source>.app-glyph{color:#a6a9af}
.live-source>b{margin-left:auto;font-size:13px;line-height:18px;font-weight:500;color:#d1d4d9}
.live-title{display:flex;align-items:center;gap:8px;font-size:16px;line-height:21px;font-weight:600;margin-bottom:6px}
.live-title strong{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.live-message p{font-size:13px;line-height:18px;color:#a6a9af;margin:0}
.live-state{display:flex;justify-content:space-between;align-items:center;font-size:11px;line-height:16px;color:#c7cbd1;padding-top:15px}
.live-state>span{display:flex;align-items:center;gap:5px}
.running-dot{width:4px;height:4px;border-radius:50%;background:currentColor;display:inline-block}
.attention-sign{display:inline-grid;place-items:center;width:13px;height:13px;border-radius:50%;font-style:normal;background:#f5c475;color:#17120b;font-weight:750;font-size:9px;flex:none}
.live-attention .live-source>b,.live-attention .live-state>span:first-child{color:#f5c475}
.live-others{display:flex;align-items:center;gap:6px;margin-top:12px;border-top:1px solid #ffffff24;padding-top:10px;font-size:11px;line-height:16px;color:#999fa8}
.system-notification{padding:14px 16px;border-radius:24px;background:#f2f5fac9;color:#293749;font-size:13px;line-height:19px;box-shadow:0 6px 18px #61779414}
.notification-app{display:flex;align-items:center;gap:7px;font-size:12px;margin-bottom:7px;color:#53637a}
.notification-app b{font-weight:600}
.notification-app small{margin-left:auto;color:#7b899b;font-size:11px}
.system-notification>strong{font-weight:600}
.system-notification>p{margin:2px 0 0}
.lock-shortcut-row{display:flex;justify-content:space-between;padding:0 40px;margin-top:auto;margin-bottom:26px}
.lock-shortcut-row>span{width:42px;height:42px;border-radius:50%;display:grid;place-items:center;background:#b6c4d857;color:#506782}
.app-lock .app-home-indicator{height:20px}
.pair-app{--pair-accent:#2257b4}
.pair-entry-header,.pair-sheet header{font-size:20px;line-height:28px;font-weight:600;padding:8px 20px;min-height:52px;flex:none}
.pair-entry-body{flex:1;display:flex;flex-direction:column;justify-content:center;padding:0 24px 8px}
.pair-app-mark{align-self:center;width:76px;height:76px;display:grid;place-items:center;border-radius:20px;box-shadow:inset 2.6px 2.6px 2.6px #a6b2c65c,inset -2.6px -2.6px 2.6px #ffffff96}
.pair-app-mark img{width:52px;height:52px;object-fit:contain}
.pair-entry-body h2{text-align:center;font-size:20px;line-height:27px;margin:18px 0 28px;font-weight:600}
.pair-action{display:flex;align-items:center;justify-content:center;gap:10px;min-height:52px;border-radius:16px;background:var(--base);box-shadow:2.6px 2.6px 2.6px #a6b2c65c,-2.6px -2.6px 2.6px #ffffff96;font-weight:500}
.pair-primary{color:var(--pair-accent)}
.pair-entry-divider{display:flex;align-items:center;gap:12px;padding:22px 0;font-size:12px;color:var(--secondary);white-space:nowrap}
.pair-entry-divider:before,.pair-entry-divider:after{content:'';flex:1;height:2px;background:#d7dfea;border-radius:4px}
.pair-paste{justify-content:flex-start;padding:0 16px}
.pair-paste>.app-glyph:last-child{margin-left:auto;transform:rotate(90deg)}
.pair-app-scanner{background:#d7deea}
.pair-sheet{display:flex;flex-direction:column;position:relative;flex:1;background:var(--base);border-radius:28px 28px 0 0;gap:20px;padding-top:14px}
.pair-sheet header{display:flex;align-items:center;gap:14px;padding-bottom:0}
.pair-camera{margin:0 24px;padding:6px;aspect-ratio:1;border-radius:20px;box-shadow:inset 2.6px 2.6px 2.6px #a6b2c65c,inset -2.6px -2.6px 2.6px #ffffff96}
.pair-camera svg{display:block;width:100%;height:100%;border-radius:14px}
.pair-photo{color:var(--pair-accent);display:flex;justify-content:center;align-items:center;gap:8px;font-size:15px}
.pair-cancel{margin:auto 24px 20px}
.pair-app-scanner .app-home-indicator{background:var(--base)}
`;
