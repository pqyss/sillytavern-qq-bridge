# QQ 酒馆桥接 (QQ ↔ SillyTavern)

把酒馆（SillyTavern）里**某一个对话窗口**通过你的 QQ 小号，桥接到一个指定的 **QQ 好友私聊**。
效果：

- 酒馆里角色（AI）的回复 → 自动发到你的 QQ 好友
- 你在 QQ 好友里发的消息 → 自动作为「用户消息」发回酒馆并触发 AI 回复

于是你可以用手机 QQ 远程和酒馆里的角色聊天，一次只桥接一个对话窗口。

## 架构

```
QQ 好友  <--私聊-->  NapCat(正向WebSocket/OneBot v11)  <--ws-->  bridge.js  <--ws-->  酒馆扩展(qq-bridge)
```

- **NapCat**：登录你的 QQ 小号，提供 OneBot v11 正向 WebSocket（默认 `ws://127.0.0.1:3001`）。
- **bridge.js**（本项目）：Node.js 桥接服务，左边连 NapCat，右边开本地 WS 给酒馆扩展（`ws://localhost:8787`）。
- **qq-bridge 扩展**（本项目 `extension/` 目录）：装在酒馆里，负责读取/注入对话消息。

> 兼容性：扩展用「相对路径 + 动态导入 + 多路径回退」加载酒馆 API，兼容安装在 `third-party/` 或内置 `extensions/` 两种位置，并兼容 1.19.x。

## 一、准备 QQ 小号 + NapCat

> 强烈建议用 **QQ 小号** 做机器人账号，避免主号风控。

1. 下载并安装 NapCat（Windows 一键包，解压后运行 `napcat.bat`；或按官方文档安装）。
2. 启动后用手机 QQ 扫码登录小号。
3. 打开 NapCat 的 **WebUI**（默认 `http://127.0.0.1:6099`），进入「网络配置」→「新建」：
   - 类型：**WebSocket 服务器**（正向 WS）
   - Host：`127.0.0.1`
   - Port：`3001`
   - 消息格式（messagePostFormat）：`array`
   - 上报自身消息（reportSelfMessage）：**关闭**
   - Token：自己定一段字符串（也可留空；若填了，记下来填进下面的 `config.json`）
4. 保存，确认该 WS 配置已启用。

## 二、安装并配置桥接服务

需要 Node.js（本项目已在 Node 22 验证）。

```bash
cd qq-tavern-bridge
npm install
```

编辑 `config.json`：

```json
{
  "napcat": {
    "wsUrl": "ws://127.0.0.1:3001",
    "accessToken": ""            // 与 NapCat 里设的 Token 保持一致（没设就留空）
  },
  "bridge": { "wsPort": 8787, "heartbeatMs": 20000 },  // wsPort: 本地端口；heartbeatMs: 服务端心跳间隔(ms)，用于息屏时保活连接（详见下方「端口说明」）
  "qq": {
    "botQQ": 0,                  // 小号 QQ，仅备注用，可留 0
    "targetUserId": 123456789    // 改成你想桥接的「好友」QQ 号（必须填！）
  }
}
```

启动桥接服务（保持运行，不要关掉窗口，最小化即可）：

```bash
npm start
# 看到 "[bridge] 酒馆桥接 WS 服务已启动: ws://localhost:8787" 即成功
```

可选：自测（用假 NapCat + 假酒馆客户端验证路由）：

```bash
npm test
```

### 端口说明（在哪里确认、改了要同步哪里）

- 桥接服务监听的端口由 `config.json` 里的 `bridge.wsPort` 决定，**默认 8787**。
- 酒馆扩展那边连的地址默认是 `ws://localhost:8787`，可在扩展面板的「桥接地址」输入框里改（会记到浏览器本地，下次自动填）。
- **两边都得一致**：如果你把 8787 改成了别的端口，必须：
  1. 改 `config.json` 的 `bridge.wsPort`，并重启 `bridge.js`；
  2. 在酒馆扩展面板的「桥接地址」里也改成同样的 `ws://localhost:<新端口>`。
- **怎么确认实际用的端口**：
  - 看 `bridge.js` 启动时的那行日志：`[bridge] 酒馆桥接 WS 服务已启动: ws://localhost:8787`；
  - 或在命令行执行 `netstat -ano | findstr 8787`，有 `LISTENING` 就说明正在监听；
  - 或直接打开 `config.json` 看 `bridge.wsPort`。

## 三、把扩展装进酒馆（重点：文件夹怎么放）

本项目里有一个 `extension/` 文件夹，它**只是一个打包容器**，里面装着扩展的 4 个文件：

```
qq-tavern-bridge/extension/
├── manifest.json   ← 扩展清单
├── script.js       ← 扩展主逻辑
├── index.html      ← 设置面板
└── style.css       ← 样式
```

你要做的，是**把 `extension/` 里面的这 4 个文件，复制到你自己在酒馆里新建的一个文件夹里**——
**不是**把整个 `extension/` 文件夹塞进去（那样会多套一层，酒馆找不到）。

### 正确步骤

1. 进入酒馆的安装目录，找到扩展目录：
   ```
   SillyTavern/public/scripts/extensions/third-party/
   ```
2. 在那里**新建一个文件夹**，名字随意（例如 `qq-bridge`）。
3. 把 `extension/` 里的 4 个文件复制进这个新建文件夹。

### 最终结构应该是这样（✅ 正确）

```
SillyTavern/public/scripts/extensions/third-party/qq-bridge/
├── manifest.json
├── script.js
├── index.html
└── style.css
```

### 错误示范（❌ 不要让结构变成这样）

```
SillyTavern/public/scripts/extensions/third-party/qq-bridge/extension/manifest.json
                                                                  ├── script.js
                                                                  ├── index.html
                                                                  └── style.css
```
（错误点：多套了一层 `extension/`，酒馆扫描不到。）

> 提示：文件夹名字（`qq-bridge`）就是扩展的内部标识，随意起都行；但里面 4 个文件名不要改，
> `manifest.json` 里写死了 `js: "script.js"`、`css: "style.css"`。

### 启用扩展

1. **彻底关闭酒馆再重启**（不是只关浏览器标签，要把运行酒馆的命令行窗口也关掉再重开）。
   酒馆只在启动时扫描扩展目录，运行中放入的文件不会自动出现。
2. 浏览器里按 **Ctrl + F5** 强制刷新。
3. 打开「扩展管理 / 已安装扩展程序」，找到 **QQ 酒馆桥接**，把开关打开。
4. 打开你想桥接的那个**角色对话窗口**。
5. 在扩展设置面板（扩展管理里找到「QQ 酒馆桥接」的折叠项并展开）点 **「绑定当前对话并启用」**。
6. 状态点变绿（已连接）即可。

之后用你的目标好友 QQ 给小号发消息，就能在酒馆里看到角色自动回复，回复也会回传到 QQ。
7.此后再次启动，只需先启动napcat，再双击start.bat即可

## 四、使用注意

- **一次只桥接一个窗口**：绑定的是「当前激活对话」。切换酒馆对话后，想换窗口就重新点绑定。
- 只有**角色的回复**会被转发到 QQ（不会把你在酒馆里手打的用户消息也转发，避免冗余）。
- QQ 里发来的消息会作为用户消息触发一次新回复，形成闭环；NapCat 侧已关闭上报自身消息，不会回环。
- 桥接服务、NapCat、酒馆三者都跑在同一台机器上（本地回环）。若酒馆在别的机器用浏览器访问，需要把 `bridge.wsPort` 暴露/改地址。

## 常见问题

- **扩展「加载失败：[object Event]」**：通常是扩展脚本加载/解析失败。先按 F12 看浏览器控制台红字。本版扩展已改用动态导入 + 多路径回退，并改用全局 `SillyTavern.getContext`，可兼容 1.19.x；若仍失败，检查文件是否放对位置（见上方「三」），以及 `script.js` 能否被访问到。
- **桥接服务连不上 NapCat**：确认 NapCat 正向 WS 已启用且端口是 3001；若设了 Token，两处一致。
- **酒馆扩展连不上桥接服务**：确认 `bridge.js` 正在运行；酒馆浏览器能访问 `localhost:8787`（同机）；确认「桥接地址」与 `config.json` 的端口一致。
- **QQ 收不到回复**：检查 `qq.targetUserId` 是否填成好友 QQ 号；确认小号已登录且未被风控。
- **息屏/休眠后扩展显示「已断开」，开屏又自动连上**：这是浏览器/系统在息屏低功耗态回收了空闲 WebSocket 连接所致。本版已做两层防护：① 桥接服务每 `heartbeatMs` 毫秒向扩展发一次 ping 心跳，让连接保持活跃（电脑未真正休眠时基本不再掉线）；② 扩展在页面重新可见（`visibilitychange`）或网络恢复（`online`）时**立即重连**，不必再等定时器。若你机器息屏会进入真正的休眠（而非仅关显示器），连接仍会断，但开屏后会立刻自动恢复，属正常现象。可在 `config.json` 调小 `bridge.heartbeatMs` 让心跳更密（如 10000）。
