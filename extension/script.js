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

let ws = null;
let enabled = false;
let reconnectTimer = null;
let boundChatId = null;
let busy = false; // 防止 QQ 消息在生成中途重复注入

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

function setStatus(connected, text) {
  const dot = document.getElementById('qq-bridge-status');
  const label = document.getElementById('qq-bridge-status-text');
  if (dot) dot.className = 'qq-bridge-dot ' + (connected ? 'on' : 'off');
  if (label) label.textContent = text;
}

function connect() {
  const urlInput = document.getElementById('qq-bridge-url');
  const url = (urlInput && urlInput.value) || 'ws://localhost:8787';
  if (ws) { try { ws.close(); } catch (e) {} }
  try {
    ws = new WebSocket(url);
  } catch (e) {
    console.error('[qq-bridge] 创建 WebSocket 失败', e);
    return;
  }
  ws.onopen = () => {
    setStatus(true, '已连接');
    console.log('[qq-bridge] 已连接桥接服务');
    // 连接成功，取消挂起的重连定时器
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  };
  ws.onclose = () => {
    ws = null;
    setStatus(false, '已断开，重连中…');
    scheduleReconnect();
  };
  ws.onerror = () => { setStatus(false, '连接错误'); try { ws.close(); } catch (e) {} };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg && msg.type === 'qq_message' && enabled) {
      handleIncomingQQ(msg.text);
    }
  };
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
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'st_message', text }));
  }
}

async function setup() {
  // 手动注入设置面板（酒馆不会自动加载扩展的 index.html）
  try {
    const resp = await fetch(new URL('index.html', import.meta.url));
    const html = await resp.text();
    const container = document.getElementById('extensions_settings');
    if (container) {
      container.insertAdjacentHTML('beforeend', html);
    } else {
      console.warn('[qq-bridge] 未找到 #extensions_settings 容器');
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

  function refreshToggleText() {
    const span = toggleBtn && toggleBtn.querySelector('span');
    if (span) span.textContent = enabled ? '停用桥接' : '绑定当前对话并启用';
  }
  refreshToggleText();

  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      enabled = !enabled;
      localStorage.setItem(ENABLED_KEY, String(enabled));
      if (enabled) {
        boundChatId = getCurrentChatId();
        localStorage.setItem(CHAT_KEY, boundChatId);
        if (chatLabel) chatLabel.textContent = getCurrentChatName();
        connect();
      } else {
        if (ws) { try { ws.close(); } catch (e) {} }
        setStatus(false, '已停用');
      }
      refreshToggleText();
    });
  }

  eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
  eventSource.on(event_types.CHAT_CHANGED, () => {
    if (chatLabel) chatLabel.textContent = getCurrentChatName();
  });

  // —— 息屏/休眠恢复：屏幕亮起或网络恢复时立即重连，不再干等定时器 ——
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { console.log('[qq-bridge] 页面恢复可见，检查连接'); ensureConnected(); }
  });
  window.addEventListener('online', () => { console.log('[qq-bridge] 网络恢复，检查连接'); ensureConnected(); });
  // 周期性健康检查：兜底处理「连接被静默丢弃但没收到 close 事件」的情况
  setInterval(() => { if (enabled) ensureConnected(); }, 5000);

  // 如果之前已启用，则自动重连
  if (enabled) connect();

  console.log('[qq-bridge] 扩展已加载');
}

setup();
