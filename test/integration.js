/**
 * 集成自测：用「假 NapCat」+「假酒馆客户端」验证桥接路由是否正确。
 *
 * 测试项：
 *  A. QQ 私聊消息 -> 应被广播给酒馆客户端 (qq_message)
 *  B. 酒馆客户端发 st_message -> 桥接服务应通过 OneBot send_msg 发到目标 QQ
 *
 * 运行：node test/integration.js  (需先 npm install)
 */
const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

// 1) 假 NapCat 正向 WebSocket 服务（端口 3001）
const napcat = new WebSocket.Server({ port: 3001 });
let napcatConn = null;
const sentToQQ = []; // 记录桥接服务调用 OneBot send_msg 的参数
napcat.on('connection', (ws) => {
  napcatConn = ws;
  ws.on('message', (raw) => {
    const data = JSON.parse(raw.toString());
    if (data.action === 'send_msg') sentToQQ.push(data.params);
  });
});
function qqSend(text) {
  if (!napcatConn) return;
  napcatConn.send(JSON.stringify({
    post_type: 'message',
    message_type: 'private',
    user_id: 10001,
    message: text,
    sender: { nickname: 'Friend' },
  }));
}

// 2) 写一份测试用配置，启动 bridge.js
const testConfig = {
  napcat: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '' },
  bridge: { wsPort: 8787 },
  qq: { botQQ: 20002, targetUserId: 10001 },
};
fs.writeFileSync(path.join(__dirname, 'config.test.json'), JSON.stringify(testConfig, null, 2));

const bridgeProc = spawn(process.execPath, ['bridge.js'], {
  cwd: ROOT,
  env: { ...process.env, CONFIG_PATH: path.join(__dirname, 'config.test.json') },
  stdio: ['ignore', 'ignore', 'inherit'],
});

function finish(pass) {
  console.log('--- 自测结果 ---');
  console.log('酒馆端收到的 QQ 消息:', receivedFromQQ);
  console.log('桥接服务发往 QQ 的 send_msg:', sentToQQ);
  console.log(pass ? 'PASS ✅' : 'FAIL ❌');
  try { bridgeProc.kill(); } catch (e) {}
  try { napcat.close(); } catch (e) {}
  setTimeout(() => process.exit(pass ? 0 : 1), 200);
}

const receivedFromQQ = [];

// 3) 等桥接服务起来后，连一个「假酒馆客户端」
setTimeout(() => {
  const st = new WebSocket('ws://localhost:8787');
  st.on('open', () => {
    console.log('[test] 假酒馆客户端已连接，0.5s 后模拟 QQ 发来私聊');
    setTimeout(() => qqSend('你好，我是手机端'), 500);
  });
  st.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'qq_message') {
      receivedFromQQ.push(m.text);
      console.log('[test] 酒馆端收到 QQ 消息:', m.text);
      // 收到后，模拟酒馆把 AI 回复发回桥接服务
      st.send(JSON.stringify({ type: 'st_message', text: '来自酒馆的回复' }));
    }
  });
  st.on('error', (e) => { console.error('[test] ST 连接错误', e.message); });

  // 4) 2 秒后判定
  setTimeout(() => {
    const pass = receivedFromQQ.includes('你好，我是手机端') &&
      sentToQQ.some((p) => p.user_id === 10001 && p.message === '来自酒馆的回复');
    finish(pass);
  }, 2000);
}, 1500);

process.on('exit', () => { try { bridgeProc.kill(); } catch (e) {} });
