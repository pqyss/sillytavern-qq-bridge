/**
 * QQ 酒馆桥接服务 (bridge.js)
 *
 * 职责：
 *  1. 作为 OneBot v11 客户端，连接 NapCat 的「正向 WebSocket」(ws://127.0.0.1:3001)
 *  2. 作为本地 WebSocket 服务端，给 SillyTavern 的 qq-bridge 扩展连接 (ws://localhost:8787)
 *  3. 路由：
 *     - 酒馆 AI 回复 (来自扩展的 {type:'st_message'})  -> 通过 OneBot send_msg 发到指定 QQ 好友
 *     - QQ 好友发来的私聊消息                            -> 广播给酒馆扩展 ( {type:'qq_message'} )
 *
 * 设计目标：一次只桥接一个酒馆对话窗口（由扩展侧决定当前激活的对话）。
 */

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const configPath = process.env.CONFIG_PATH
  ? path.resolve(process.env.CONFIG_PATH)
  : path.join(__dirname, 'config.json');

if (!fs.existsSync(configPath)) {
  console.error(`[bridge] 找不到配置文件: ${configPath}`);
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const NAPCAT_WS = config.napcat.wsUrl +
  (config.napcat.accessToken ? `?access_token=${config.napcat.accessToken}` : '');
const BRIDGE_PORT = config.bridge.wsPort || 8787;
const TARGET_USER_ID = String(config.qq.targetUserId || '0');

if (TARGET_USER_ID === '0') {
  console.warn('[bridge] 警告: qq.targetUserId 未配置 (为 0)，将转发来自「任意」QQ 好友的私聊消息。请在 config.json 中填好目标好友 QQ。');
}

// ---------- 本地 WebSocket 服务端（给酒馆扩展用） ----------
const wss = new WebSocket.Server({ port: BRIDGE_PORT });
let activeST = null;  // 同时只保留一个酒馆客户端连接：避免扩展被重复加载/重连产生多条连接互相打架、造成反复断联

// 酒馆客户端离线期间收到的 QQ 私聊消息先入队，待其重连后补推（避免用户离线时发的消息丢失）
const stQueue = [];
const ST_QUEUE_MAX = 50;

wss.on('connection', (ws) => {
  // 若已有一条活跃连接（通常是扩展重复加载/重连产生的旧连接），先清理它，保证全局只有一条有效链路
  if (activeST && activeST !== ws && activeST.readyState === WebSocket.OPEN) {
    console.log('[bridge] 发现旧连接，清理以避免重复桥接');
    try { activeST.terminate(); } catch (e) {}
  }
  activeST = ws;
  console.log('[bridge] 酒馆扩展已连接');
  // 酒馆重连后，把离线期间缓存的 QQ 消息补推过去
  if (stQueue.length) {
    console.log(`[bridge] 补推离线期间缓存的 ${stQueue.length} 条 QQ 消息`);
    while (stQueue.length) {
      try { ws.send(stQueue.shift()); } catch (e) { break; }
    }
  }
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg && msg.type === 'st_message' && typeof msg.text === 'string') {
      sendToQQ(msg.text);
    } else if (msg && msg.type === 'ping') {
      // 客户端应用层心跳，回 pong 表示存活（浏览器不发协议层 pong 给 JS，故用应用层）
      try { ws.send(JSON.stringify({ type: 'pong' })); } catch (e) {}
    }
  });
  ws.on('close', (code, reason) => {
    if (activeST === ws) activeST = null;
    console.log(`[bridge] 酒馆扩展已断开 (code=${code})`);
  });
  ws.on('error', () => {});
  // 心跳标记：配合下方定时器检测死连接（容忍偶发漏 pong）
  ws.isAlive = true;
  ws.missed = 0;
  ws.on('pong', () => { ws.isAlive = true; ws.missed = 0; });
});

// ---------- 心跳保活（应对息屏/休眠后连接被回收） ----------
// 定期向每个客户端发协议层 ping；浏览器会自动回 pong。
// 连续 3 次（约 HEARTBEAT_MS*3）未收到 pong 才判定为死连接并终止，避免偶发抖动误杀。
// 持续的心跳流量也能让浏览器/系统不要把空闲连接当作可回收资源。
const HEARTBEAT_MS = (config.bridge && config.bridge.heartbeatMs) || 20000;
const heartbeatTimer = setInterval(() => {
  const ws = activeST;
  if (!ws) return;
  if (ws.isAlive === false) {
    // 上一轮没收到 pong：累计未响应次数，连续 3 次才判定死亡
    ws.missed = (ws.missed || 0) + 1;
    if (ws.missed >= 3) {
      try { ws.terminate(); } catch (e) {}
      return;
    }
  }
  ws.isAlive = false;
  try { ws.ping(); } catch (e) {}
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeatTimer));

function broadcastToST(obj) {
  const data = JSON.stringify(obj);
  if (activeST && activeST.readyState === WebSocket.OPEN) {
    activeST.send(data);
  } else if (obj.type === 'qq_message') {
    // 酒馆客户端离线：缓存 QQ 私聊，待重连补推（缓存其他类型无意义）
    stQueue.push(data);
    if (stQueue.length > ST_QUEUE_MAX) stQueue.shift();
  }
}

// ---------- OneBot v11 客户端（连接 NapCat） ----------
let onebot = null;
let echoCounter = 0;
const pending = new Map();

function connectOneBot() {
  console.log(`[bridge] 正在连接 NapCat: ${config.napcat.wsUrl}`);
  onebot = new WebSocket(NAPCAT_WS);

  onebot.on('open', () => console.log('[bridge] 已连接到 NapCat'));

  onebot.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    // API 响应（带 echo）
    if (data.echo) {
      const cb = pending.get(data.echo);
      if (cb) { pending.delete(data.echo); cb(data); }
      return;
    }

    // 事件：私聊消息
    if (data.post_type === 'message' && data.message_type === 'private') {
      if (TARGET_USER_ID !== '0' && String(data.user_id) !== TARGET_USER_ID) return;
      const text = extractText(data.message);
      if (!text) return;
      console.log(`[bridge] 收到 QQ 私聊(${data.user_id}): ${text}`);
      broadcastToST({
        type: 'qq_message',
        text,
        sender: (data.sender && data.sender.nickname) || String(data.user_id),
      });
    }
  });

  onebot.on('close', (code, reason) => {
    console.log(`[bridge] 与 NapCat 断开 (code=${code})，5 秒后重连…`);
    setTimeout(connectOneBot, 5000);
  });

  onebot.on('error', (e) => console.error('[bridge] OneBot 错误:', e.message));
}

function sendToQQ(text) {
  if (!onebot || onebot.readyState !== WebSocket.OPEN) {
    console.warn('[bridge] OneBot 未连接，丢弃一条酒馆消息');
    return;
  }
  const echo = `send_${++echoCounter}`;
  pending.set(echo, (resp) => {
    if (resp.status !== 'ok') console.error('[bridge] send_msg 失败:', JSON.stringify(resp));
    else console.log('[bridge] 已转发到 QQ');
  });
  onebot.send(JSON.stringify({
    action: 'send_msg',
    params: {
      message_type: 'private',
      user_id: Number(TARGET_USER_ID),
      message: text,
    },
    echo,
  }));
}

// OneBot message 字段可能是 string（messagePostFormat=string）
// 也可能是 array（messagePostFormat=array），如 [{type:'text',data:{text:'hi'}}]
function extractText(message) {
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) {
    return message.map((seg) => {
      if (seg.type === 'text') return seg.data?.text || '';
      if (seg.type === 'image') return '[图片]';
      if (seg.type === 'face') return '[表情]';
      return '';
    }).join('');
  }
  return '';
}

connectOneBot();
wss.on('listening', () => {
  console.log(`[bridge] 酒馆桥接 WS 服务已启动: ws://localhost:${BRIDGE_PORT}`);
});
