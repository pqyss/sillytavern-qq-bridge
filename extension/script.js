/**
 * QQ 酒馆桥接 - SillyTavern 扩展 (script.js)
 * 适配 SillyTavern 1.19.x
 *
 * 行为：
 *  - 监听 MESSAGE_RECEIVED（酒馆 AI 回复），把回复文本通过本地桥接服务转发到 QQ 好友
 *  - 接收桥接服务转来的 QQ 私聊消息：sendMessageAsUser 注入用户消息，再用 Generate 触发 AI 回复
 *  - 一次只桥接「当前激活」的对话窗口；可点击「绑定当前对话并启用」
 *
 * 关于 API 导入（重点，避免 "加载失败：[object Event]"）：
 *  酒馆主脚本是 /script.js（站点根目录，不是 /scripts/script.js）。它把部分 API 以
 *  ES Module 命名导出（eventSource / event_types / sendMessageAsUser / Generate），
 *  而 getContext 在 1.19 里只挂在全局对象 window.SillyTavern 上，不是命名导出。
 *  因此这里用「相对路径 + 动态 import + 多路径回退」的方式加载，兼容两种安装位置：
 *    - 安装到 public/scripts/extensions/third-party/<名字>/  → 向上 4 级
 *    - 安装到 public/scripts/extensions/<名字>/            → 向上 3 级
 *  同时全程不使用静态 import，避免某个名字缺失就导致整个模块加载失败。
 *
 * 关于反复断联（code=1005 / 1006）：
 *  酒馆在某些 UI 切换/扩展重载场景会把本脚本重复求值，从而产生多条连接互相打架，
 *  或触发 pagehide 误关 socket，形成「连接→立刻断开→重连」的循环。
 *  为此我们把连接与监听状态挂到 window.__qqBridge 上共享，并加幂等标志，
 *  保证无论脚本被求值多少次，全局只有「一条连接 + 一组监听」。
 */

// 动态加载酒馆主脚本 API（相对路径，兼容两种安装位置）
async function loadSTAapi() {
  const candidates = [
    new URL('../../../../script.js', import.meta.url).href, // third-party/<名字>/
    new URL('../../../script.js', import.meta.url).href,    // extensions/<名字>/
  ];
  let lastErr = null;
  for (const url of candidates) {
    try {
      const m = await import(url);
      if (m && typeof m.sendMessageAsUser === 'function' && typeof m.Generate === 'function') {
        console.log('[qq-bridge] 已从', url, '加载酒馆 API');
        return m;
      }
      console.warn('[qq-bridge]', url, '已加载但缺少必要导出，尝试下一个路径');
    } catch (e) {
      lastErr = e;
      console.debug('[qq-bridge] 导入失败:', url, e && e.message);
    }
  }
  throw new Error(
    '无法从 script.js 导入酒馆 API（已尝试 third-party 与内置路径）。请确认扩展放在 ' +
    'public/scripts/extensions/third-party/<名字>/ 下，且酒馆主脚本 script.js 存在。'
  );
}

// 顶层 await：等待 API 就绪后再执行后续逻辑
const ST = await loadSTAapi();
const eventSource = ST.eventSource;
const event_types = ST.event_types;
const sendMessageAsUser = ST.sendMessageAsUser;
const Generate = ST.Generate;

// getContext 在部分版本里只挂在全局 SillyTavern 对象上，并不在 script.js 的命名导出中
const getContext =
  (typeof window !== 'undefined' && window.SillyTavern && typeof window.SillyTavern.getContext === 'function')
    ? window.SillyTavern.getContext
    : (typeof ST.getContext === 'function' ? ST.getContext : null);

const BRIDGE_URL_KEY = 'qqBridgeUrl';
const ENABLED_KEY = 'qqBridgeEnabled';
const CHAT_KEY = 'qqBridgeChatId';

// ── 跨「扩展被重复加载/热重载」保持单一连接与单一监听的核心状态 ──
// 放在 window 上，保证多次脚本求值共享同一份状态，避免产生多条连接互相打架、反复断联。
const G = (window.__qqBridge = window.__qqBridge || {});
G.ws = G.ws || null;
let ws = G.ws;
// 已转发给 QQ 的「最大消息下标」：用于断连期间漏转发的回复在重连后补发。
// 初始化为 -1，首次连接时由 catchUpMissedReplies 自动校准基线（不补发历史）。
G.lastForwardedIndex = (typeof G.lastForwardedIndex === 'number') ? G.lastForwardedIndex : -1;

let enabled = false;
let reconnectTimer = null;
let boundChatId = null;
let busy = false; // 防止 QQ 消息在生成中途重复注入
let lastPong = G.lastPong || Date.now();
G.lastPong = lastPong;
let keepaliveTimer = null;      // 应用层心跳定时器
const KEEPALIVE_MS = 15000;     // 每 15 秒向服务端发一次应用层心跳

// 静音保活（防止标签页被浏览器冻结，是「息屏后不断连」的关键）
let keepAliveAudio = null;        // 静音循环音频元素
let keepAliveAudioEnabled = true; // 是否启用静音保活（可在面板关闭）

function getCurrentChatId() {
  try {
    const ctx = getContext();
    if (ctx.chatId) return ctx.chatId;
    if (ctx.characterId != null) return `char_${ctx.characterId}`;
    if (ctx.chat && ctx.chat[0] && ctx.chat[0].name) return ctx.chat[0].name;
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function getCurrentChatName() {
  try {
    const ctx = getContext();
    const chid = ctx.characterId;
    if (chid != null && ctx.characters && ctx.characters[chid]) {
      return ctx.characters[chid].name;
    }
    if (ctx.chat && ctx.chat[0] && ctx.chat[0].name) return ctx.chat[0].name;
  } catch {}
  return '当前对话';
}

// ── 断连期间漏转发的回复补发逻辑 ──
// 原理：记录「已转发给 QQ 的最大消息下标」。断连时生成的 AI 回复不会触发转发（ws 非 OPEN），
// 重连后扫描当前对话里比基线更新的 AI 消息，把漏掉的回复补发给 QQ。
function getChatMessages() {
  try {
    const ctx = getContext();
    return ctx.chat || [];
  } catch {
    return [];
  }
}

function maxAiIndex(messages) {
  let max = -1;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m && !m.is_user && !m.is_system && i > max) max = i;
  }
  return max;
}

// 校准基线：把 lastForwardedIndex 设为当前已有 AI 消息的最大下标，不补发历史
function baselineForwarded() {
  const max = maxAiIndex(getChatMessages());
  if (max >= 0) G.lastForwardedIndex = max;
}

// 重连后调用：补发断连期间漏掉的 AI 回复
function catchUpMissedReplies() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (G.lastForwardedIndex < 0) baselineForwarded(); // 首次：只校准基线，不补发历史
  const base = G.lastForwardedIndex;
  const messages = getChatMessages();
  for (let i = base + 1; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.is_user || m.is_system) continue;
    const text = (m.mes || '').trim();
    if (!text) continue;
    try {
      ws.send(JSON.stringify({ type: 'st_message', text }));
      G.lastForwardedIndex = i;
    } catch (e) {
      try { ws.close(); } catch (_) {}
      break;
    }
  }
}

function setStatus(connected, text) {
  const dot = document.getElementById('qq-bridge-status');
  const label = document.getElementById('qq-bridge-status-text');
  if (dot) dot.className = 'qq-bridge-dot ' + (connected ? 'on' : 'off');
  if (label) label.textContent = text;
}

function connect() {
  const urlInput = document.getElementById('qq-bridge-url');
  const url = (urlInput && urlInput.value) || 'ws://localhost:8787';
  // 已存在「正在连接」或「已打开」的连接时，不要重复建连（避免连接抖动 / 多开导致服务端反复打印断联）
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  if (ws) { try { ws.close(); } catch (e) {} }
  lastPong = Date.now(); G.lastPong = lastPong;
  const sock = new WebSocket(url);
  ws = sock; G.ws = sock;
  sock.onopen = () => {
    setStatus(true, '已连接');
    lastPong = Date.now(); G.lastPong = lastPong;
    startKeepalive();
    console.log('[qq-bridge] 已连接桥接服务');
    // 连接成功，取消挂起的重连定时器
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    // 重连后补发断连期间漏掉的 AI 回复（如屏幕关着时生成的回复）
    catchUpMissedReplies();
    setTimeout(catchUpMissedReplies, 1500); // 兜底：聊天内容可能稍晚加载
  };
  sock.onclose = (ev) => {
    stopKeepalive();
    // 仅当仍是当前 socket 时才清空引用，避免误清空后来新建的连接（防止连接来回抖）
    if (ws === sock) ws = null;
    if (G.ws === sock) G.ws = null;
    setStatus(false, '已断开，重连中…');
    if (ev && ev.code) console.debug('[qq-bridge] 连接关闭 code=', ev.code, ev.reason || '');
    scheduleReconnect();
  };
  // 只记录错误，不主动关闭：错误事件之后浏览器通常会紧跟着触发 close，让 close 去处理重连即可，
  // 主动 close 反而可能产生一次「干净断开(1005)」的错觉。
  sock.onerror = (e) => { console.error('[qq-bridge] WebSocket 错误', e && e.message); };
  sock.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    // 任何来自服务端的消息都视为存活信号（含 pong / qq_message）
    lastPong = Date.now(); G.lastPong = lastPong;
    if (msg && msg.type === 'pong') return;
    if (msg && msg.type === 'qq_message' && enabled) {
      handleIncomingQQ(msg.text);
    }
  };
}

// 应用层心跳：客户端定时发 ping，并检测「静默断连」
// （浏览器/系统在标签冻结或空闲过久时，可能悄悄掐掉连接却不会发出 close 事件，
//  此时 ws.readyState 仍是 OPEN，光靠它检测不出来，必须靠真实收发来判断）
function startKeepalive() {
  stopKeepalive();
  keepaliveTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // 超过 3 个周期（45s）没收到任何服务端消息 -> 连接已被静默丢弃，强制重连
    if (Date.now() - lastPong > KEEPALIVE_MS * 3) {
      console.warn('[qq-bridge] 超过 45s 未收到服务端心跳，判定为静默断连，强制重连');
      try { ws.close(); } catch (e) {}
      return; // onclose 会触发 scheduleReconnect
    }
    try { ws.send(JSON.stringify({ type: 'ping' })); } catch (e) {
      try { ws.close(); } catch (_) {}
    }
  }, KEEPALIVE_MS);
}

function stopKeepalive() {
  if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
}

// ── 静音保活：防止标签页被浏览器冻结/丢弃（这是「息屏后不断连」的关键）──
// 浏览器不会冻结「正在播放媒体」的标签页。我们循环播放一段静音 WAV，
// 让标签页始终处于「媒体播放中」状态，Edge/Chrome 就不会把它冻掉或丢弃，
// 连在里面的 WebSocket 也就不会断。此段音频数据全为 0（静音），听不到声音。
function buildSilentWavBase64() {
  const rate = 8000, secs = 0.25, numCh = 1, bytesPerSample = 2;
  const dataLen = Math.floor(rate * secs) * numCh * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buffer);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  const u32 = (off, v) => view.setUint32(off, v, true);
  const u16 = (off, v) => view.setUint16(off, v, true);
  writeStr(0, 'RIFF'); u32(4, 36 + dataLen); writeStr(8, 'WAVE');
  writeStr(12, 'fmt '); u32(16, 16); u16(20, 1); u16(22, numCh); u32(24, rate);
  u32(28, rate * numCh * bytesPerSample); u16(32, numCh * bytesPerSample); u16(34, bytesPerSample * 8);
  writeStr(36, 'data'); u32(40, dataLen);
  // 数据区全 0 = 静音
  let bin = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function startKeepAliveAudio() {
  if (!keepAliveAudioEnabled) return;
  if (keepAliveAudio) {
    try { if (keepAliveAudio.paused) keepAliveAudio.play(); } catch (e) {}
    return;
  }
  try {
    const audio = document.createElement('audio');
    audio.loop = true;
    audio.preload = 'auto';
    audio.muted = false; // 必须是「非静音元素」，浏览器才认为在播放媒体
    audio.volume = 1;    // 但数据本身是静音，所以听不到任何声音
    audio.style.display = 'none';
    audio.src = 'data:audio/wav;base64,' + buildSilentWavBase64();
    document.body.appendChild(audio);
    const p = audio.play();
    if (p && p.catch) p.catch((e) => console.warn('[qq-bridge] 静音保活播放被拦截（可忽略，重连逻辑兜底）：', e && e.message));
    keepAliveAudio = audio;
    console.log('[qq-bridge] 已启动静音保活：标签页不会被浏览器冻结/丢弃');
  } catch (e) {
    console.warn('[qq-bridge] 静音保活启动失败（可忽略，重连逻辑兜底）：', e);
  }
}

function stopKeepAliveAudio() {
  if (keepAliveAudio) {
    try { keepAliveAudio.pause(); keepAliveAudio.remove(); } catch (e) {}
    keepAliveAudio = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (enabled) connect();
  }, 3000);
}

// 确保连接存在：已启用但 ws 不存在/未打开时，立即重连
function ensureConnected() {
  if (!enabled) return;
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    console.log('[qq-bridge] 连接未就绪，立即重连');
    connect();
  }
}

async function handleIncomingQQ(text) {
  const ctx = getContext();
  if (boundChatId && ctx.chatId && ctx.chatId !== boundChatId) {
    console.log('[qq-bridge] 忽略非绑定对话的 QQ 消息');
    return;
  }
  if (busy) {
    console.warn('[qq-bridge] 上一条消息还在生成，忽略这条 QQ 消息');
    return;
  }
  busy = true;
  try {
    // 1) 把 QQ 消息作为用户消息写入聊天记录（不会自动触发生成）
    await sendMessageAsUser(text);
    // 2) 触发一次 AI 生成（automatic_trigger 避免再次读取输入框）
    await Generate('normal', { automatic_trigger: true });
  } catch (e) {
    console.error('[qq-bridge] 注入 QQ 消息或触发生成失败', e);
  } finally {
    busy = false;
  }
}

function onMessageReceived(index) {
  if (!enabled) return;
  const ctx = getContext();
  if (boundChatId && ctx.chatId && ctx.chatId !== boundChatId) return;
  const message = ctx.chat && ctx.chat[index];
  if (!message) return;
  if (message.is_user || message.is_system) return; // 只转发 AI 回复
  const text = (message.mes || '').trim();
  if (!text) return;
  // 已转发过（含断连期间的补发）则跳过，避免重复
  if (index <= G.lastForwardedIndex) return;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'st_message', text }));
    G.lastForwardedIndex = index;
  }
  // 若未连接：不更新 lastForwardedIndex，待重连由 catchUpMissedReplies 补发
}

async function setup() {
  // 幂等：通过 window 上的标志位，避免扩展被酒馆重复加载时重复注入面板 / 重复绑定监听 / 重复建连
  try {
    if (!G.panelInjected) {
      const resp = await fetch(new URL('index.html', import.meta.url));
      const html = await resp.text();
      const container = document.getElementById('extensions_settings');
      if (container && !document.getElementById('qq-bridge-toggle')) {
        container.insertAdjacentHTML('beforeend', html);
        G.panelInjected = true;
      } else if (document.getElementById('qq-bridge-toggle')) {
        G.panelInjected = true; // 面板已存在，标记避免重复注入
      } else {
        console.warn('[qq-bridge] 未找到 #extensions_settings 容器');
      }
    }
  } catch (e) {
    console.error('[qq-bridge] 加载设置面板失败', e);
  }

  const urlInput = document.getElementById('qq-bridge-url');
  const toggleBtn = document.getElementById('qq-bridge-toggle');
  const chatLabel = document.getElementById('qq-bridge-chat');

  if (urlInput) {
    urlInput.value = localStorage.getItem(BRIDGE_URL_KEY) || 'ws://localhost:8787';
    urlInput.addEventListener('change', () => localStorage.setItem(BRIDGE_URL_KEY, urlInput.value));
  }
  enabled = localStorage.getItem(ENABLED_KEY) === 'true';
  boundChatId = localStorage.getItem(CHAT_KEY) || null;
  if (chatLabel) chatLabel.textContent = getCurrentChatName();

  // 静音保活开关
  const keepaliveChk = document.getElementById('qq-bridge-keepalive');
  if (keepaliveChk) {
    keepAliveAudioEnabled = keepaliveChk.checked;
    keepaliveChk.addEventListener('change', () => {
      keepAliveAudioEnabled = keepaliveChk.checked;
      if (keepAliveAudioEnabled) { if (enabled) startKeepAliveAudio(); }
      else stopKeepAliveAudio();
    });
  }

  function refreshToggleText() {
    const span = toggleBtn && toggleBtn.querySelector('span');
    if (span) span.textContent = enabled ? '停用桥接' : '绑定当前对话并启用';
  }
  refreshToggleText();

  // 切换按钮只绑定一次
  if (toggleBtn && !G.toggleBound) {
    toggleBtn.addEventListener('click', () => {
      enabled = !enabled;
      localStorage.setItem(ENABLED_KEY, String(enabled));
      if (enabled) {
        boundChatId = getCurrentChatId();
        localStorage.setItem(CHAT_KEY, boundChatId);
        if (chatLabel) chatLabel.textContent = getCurrentChatName();
        baselineForwarded(); // 校准基线，避免把已有历史当成新消息转发
        startKeepAliveAudio(); // 用户点击 = 有效的播放手势，启动静音保活
        connect();
      } else {
        if (ws) { try { ws.close(); } catch (e) {} }
        stopKeepAliveAudio();
        setStatus(false, '已停用');
      }
      refreshToggleText();
    });
    G.toggleBound = true;
  }

  // 事件监听 + 健康检查只绑定一次（跨重复加载共享）
  if (!G.hooked) {
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.CHAT_CHANGED, () => {
      if (chatLabel) chatLabel.textContent = getCurrentChatName();
      // 回到绑定对话时重新校准基线，避免把旧历史当成「漏发」补发
      if (boundChatId) {
        try {
          const ctx = getContext();
          if (!ctx.chatId || ctx.chatId === boundChatId) baselineForwarded();
        } catch {}
      }
    });

    // —— 息屏/休眠恢复：屏幕亮起或网络恢复时立即重连，不再干等定时器 ——
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        console.log('[qq-bridge] 页面恢复可见，检查连接');
        if (enabled && keepAliveAudio && keepAliveAudio.paused) { try { keepAliveAudio.play(); } catch (e) {} }
        ensureConnected();
      }
    });
    window.addEventListener('online', () => { console.log('[qq-bridge] 网络恢复，检查连接'); ensureConnected(); });
    window.addEventListener('focus', () => { if (!document.hidden) { console.log('[qq-bridge] 窗口聚焦，检查连接'); ensureConnected(); } });
    // 周期性健康检查：兜底处理「连接被静默丢弃但没收到 close 事件」的情况
    setInterval(() => { if (enabled) ensureConnected(); }, 5000);

    G.hooked = true;
  }

  // 如果之前已启用，则自动重连（仅在当前确实没有活跃连接时）
  if (enabled && (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING)) {
    try { startKeepAliveAudio(); } catch (e) {} // 重载后若无手势可能被拦截，重连逻辑兜底
    connect();
  }

  console.log('[qq-bridge] 扩展已加载');
}

setup();
