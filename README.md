# 雨停之前 · Before the Rain

**在线演示（AWS 新加坡）：[打开 Before the Rain](https://before-the-rain.nk7ygsy23jcxm.ap-southeast-1.cs.amazonlightsail.com/)**

**公开源码：[hyhylong/before-the-rain](https://github.com/hyhylong/before-the-rain)**

默认无需密钥，打开即可体验。作业录屏：[artifacts/demo.mp4](artifacts/demo.mp4)（4 分 35 秒，含中文声音）。

在线版本已接入 DeepSeek `deepseek-flash`，在设置中选择“实时连接”即可体验真实对话；演示模式仍可离线复现剧情。模型密钥仅保存在服务端，本地运行默认不需要密钥。

一个移动端优先的实时角色互动 MVP。暴雨过后，你在即将打烊的咖啡馆遇到原创成年角色 Mira：26 岁的旅行摄影师，琥珀色雨衣、银色星星发夹。她的相机里有一张灯塔照片，今晚的等待也有一个迟迟没有说出口的原因。

没有聊天消息列表。角色、环境、语音和当前字幕共同组成体验。

## 启动

需要 **Node.js 22.12+、npm**。在项目根目录执行一条命令：

```bash
./start.sh
```

首次自动安装锁定依赖，此后直接启动。打开 **http://localhost:4173**。端口占用时执行 `PORT=4174 ./start.sh`。不需要数据库、账户、私人密钥或在线素材服务。

其他命令：

```bash
npm run dev        # 强制开发模式，修改即时更新
npm run build      # 生成 dist；npm start 会优先提供构建产物
npm run check      # 单元/API 测试与生产构建
npx playwright install chromium
npm run test:e2e   # 浏览器交互、取消、媒体、手机布局测试
npm run demo:record # 浏览器录制并合成本地角色语音；需要 ffmpeg
```

演示录屏位于 `artifacts/demo.mp4`；画面预览位于 `artifacts/screenshots/`。录屏生成脚本复现真实的界面操作，不使用伪造模型响应。浏览器测试中的麦克风替身用于验证回调生命周期，并不代表完成了实体麦克风验收。

## AWS 部署

提供生产 Docker 镜像和 AWS Lightsail 容器服务部署脚本，默认部署到新加坡 `ap-southeast-1`，由同一服务提供前端、Express API 与本地素材，并使用 AWS 提供的 HTTPS 域名。登录 AWS 后执行：

```bash
./scripts/deploy-aws.sh
```

脚本使用当前已提交的源码构建 `linux/amd64` 镜像，推送私有 ECR 仓库，再创建或更新 Lightsail 容器部署。部署输出包含公开演示地址；不需要配置模型密钥即可评审。认证、权限、费用与清理步骤见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

云端容器的本地磁盘是临时盘；单次会话可连续互动，但实例替换或重新部署后，服务端会话和留影缓存可能丢失。浏览器会话导出仍可保存记录。需要跨部署持久化时应接入外部存储。

## 体验与验收

| 题目要求 | 实现与体验路径 |
| --- | --- |
| 场景为主体、移动端 | 全屏 Three.js 咖啡馆；390px、320px 与桌面适配；仅呈现当前字幕 |
| 待机、倾听、思考、说话 | 瞬态状态标识、头部倾斜、视线、嘴部动画和语音波形 |
| 多轮文字交流 | 输入任意文字，或选择回应；服务端维持会话与故事节点 |
| 麦克风输入 | 点击麦克风开始，再次点击结束；优先浏览器 SpeechRecognition，备用 MediaRecorder → 服务端 STT |
| 中文语音回复 | 默认 35 段本地 MP3，与精确台词映射；真实台词走可配置 TTS 或浏览器声音 |
| 语音打断 | 说话时点击麦克风、停止按钮或发送新文字，立即停止旧音频并取消未执行指令 |
| 3 种以上情绪 | 好奇、犹豫、温柔、想念，对应眼睛、眉毛、头部和嘴形变化 |
| 2 种以上动作 | 点头、望向窗外、举照片、挥手；有呼吸与眨眼 |
| 环境变化 | 提到雨停、出发等内容，窗外由雨夜过渡为雨后的淡色天空 |
| 对话驱动视觉事件 | 提到照片或相机才举起灯塔照片，触发快门闪光和可关闭的照片窗口 |
| 多模态能力 | 原创 Three.js 角色动画、带旁白的 WebM/MP4 剧情、透明雨线合成、场景留影，以及可配置的生成式图片/视频 |
| 失败恢复 | 设置 → 下次连接 → 断线/超时演练，发送后可原内容重试；语音失效降级字幕；图片失败可重载 |
| 无密钥体验 | 默认 Mock 提供完整分支、本地中文声音、照片和天气变化，运行时无需外部请求 |

可选扩展已经补充接入：设置中开启自然语音、逐句回应与剧情演出；左上/手机右上相机与胶片按钮用于留影和视频；会话详情提供完整/单轮回放、导入导出、事件与诊断。全部 **29 条扩展的逐项实现状态与验证边界**见 [docs/EXTENSIONS.md](docs/EXTENSIONS.md)。回声处理、人物连续性和语义质量检测仍存在明确限制，不将这些标成完整验收。

建议约 3–5 分钟的顺序：打招呼 → 问她等谁 → 看相机 → 聊妹妹 → 热饮/旅行 → 陪伴 → 等雨停。中途可自由打断或跳转。Mock 是状态与关键词驱动的有限剧情，不是开放域语言模型；它保证离线评审可复现。

## 系统结构

```text
React / useExperience + useExtensions（字幕、回放、恢复、媒体任务）
  ├─ TurnScope（单调 turnId、AbortController、资源清理）
  ├─ SpeechPlayer（本地 MP3 / 流式 TTS、真实 RMS、估算音素）
  ├─ Silero V5 / SpeechRecognition / MediaRecorder
  ├─ MiraScene（配置、动作仲裁、情绪混合、天气）
  └─ VideoStage（旁白与字幕统一时钟、透明视频、失败恢复）
        ↕ NDJSON / HTTP JSON / multipart / audio stream
Express
  ├─ app.mjs（流式会话、逐句 ACK、取消、超时）
  ├─ protocol.mjs（Zod 角色与场景协议）
  ├─ story.mjs（可复现的 Mock 剧情）
  ├─ session-store.mjs（会话持久化）
  ├─ media.mjs（参考图创作、任务、缓存、检测）
  └─ providers.mjs / metrics.mjs（Provider 适配与观测）
```

`npm start` 同时提供前后端：有 `dist` 时提供构建结果，否则通过 Vite 中间件提供开发页面。会话保留最近 12 条历史，上限 500 个；启动入口将状态原子写入 `.data/sessions`，服务重启后可恢复。媒体缓存位于该目录的 `media/`。设置 `SCENE_DATA_DIR` 可以替换位置。浏览器 localStorage 保存已播放片段和界面状态，损坏记录或存储额度不足不会阻止继续交流。持久化目录与凭证不进入源码包。

## 打断与时间线

默认保留**明确点击麦克风的打断方式**，无需长期占用麦克风。可在设置中开启自然语音：本地 Silero V5 自动检测发言，候选声音先压低角色音量，结合持续时间和识别文字区分附和与实质发言。请求浏览器回声消除并过滤已识别的回放台词；复杂外放环境不能保证不误判。

1. 用户点击麦克风或提交新输入，先递增本地 epoch。
2. AbortController 中止旧请求；停止 Audio 与浏览器 TTS；关闭旧媒体窗口；清理录音、计时器、嘴部状态。
3. 切入倾听或思考。麦克风输入来自真实识别结果，最终文本进入相同的请求通道。
4. 所有网络完成、音频完成、录音回调和字幕帧均核对 epoch。旧轮回调无法推进画面。
5. 服务端独立比较单调 turnId 并取消上一轮 Provider。流式回复只在客户端确认当前句后提交该句剧情状态，未确认的照片、天气等不会提前推进。
6. 每个完整且校验通过的句子立即进入播放队列，无需等待整轮生成。客户端发出 ACK 后执行该句指令；视频用自身声画时间线，结束后继续角色语音。被打断后，剩余指令失效。
7. 断流最多进行三次有限恢复查询；刷新后可点击“继续上次”。从最后已开始的一句重新播放，不宣称按音频采样无缝续播。

预录音频按实际播放时间推进字幕，浏览器 TTS 优先使用 boundary 事件。嘴形结合真实 WebAudio RMS 与拼音元音 AA/EE/OO 时间线；时间戳按音频时长估算，**不是强制对齐的精确音素**。浏览器 TTS 不提供可分析音频流时无法提取真实振幅。音频网络首包与实际播放延迟分别记录，见 [docs/AUDIO.md](docs/AUDIO.md)。

## 场景指令

默认 `POST /api/turn/stream` 输入 `{sessionId, turnId, message, mode, fault}`，以 NDJSON 发出 `line`、`final` 或 `error`。播放前 `POST /api/session/ack` 提交 `{sessionId, turnId, lineIndex}`；只允许顺序确认，同一句重复确认幂等。关闭逐句回应后使用兼容的 `POST /api/turn` 完整 JSON 接口。示例完整回复：

```json
{
  "turnId": 7,
  "replyId": "server-generated-id",
  "chapter": "口袋里的灯塔",
  "lines": [{
    "text": "那我给你看一张放在雨衣口袋里的照片。",
    "emotion": "curious",
    "gesture": "showPhoto",
    "effect": "shutter",
    "media": "photo"
  }],
  "choices": ["你在等妹妹吗？"],
  "state": {"turnCount": 2, "trust": 2, "photoShown": true, "backstoryKnown": false, "scene": "rain", "ended": false}
}
```

枚举：`emotion = curious | guarded | warm | melancholy`，`gesture = idle | nod | lookAway | showPhoto | wave`，`scene = rain | clearing`，`effect = shutter | lightning`，`video = memory | rain`。`scene/effect/media/video` 可省略。客户端只执行受控指令，不执行模型生成代码或任意资源地址。

## 真实模型与语音

将 `.env.example` 复制为 `.env` 并填写独立的服务端凭证，然后重启。**本项目不会读取或使用 Codex CLI 的认证文件。**

```dotenv
SCENE_API_KEY=your-provider-key
SCENE_API_BASE_URL=https://api.openai.com/v1
SCENE_MODEL=gpt-4.1-mini
SCENE_VOICE_API_KEY=your-voice-provider-key
SCENE_VOICE_BASE_URL=https://api.openai.com/v1
```

文本模型使用兼容的 `chat/completions` SSE/JSON 接口；STT 与 TTS 使用 `audio/transcriptions`、`audio/speech`。可分别选择 Provider 和模型。填写文本凭证后，设置里的“实时连接”可选。模型输出经增量 JSON 解析与 Zod 校验。完整 JSON 模式格式错误重试一次；流式输出已发句子后发生错误会停止并明确反馈。默认上游超时 20 秒，客户端兜底 25 秒。

DeepSeek 可使用以下服务端配置（模型名按 [DeepSeek 官方文档](https://api-docs.deepseek.com/)）：

```dotenv
SCENE_API_KEY=your-deepseek-api-key
SCENE_API_BASE_URL=https://api.deepseek.com
SCENE_MODEL=deepseek-flash
SCENE_THINKING=disabled
```

`SCENE_THINKING=disabled` 显式关闭思考，以减少实时角色互动的首句等待；未设置时不向其他供应商发送该参数。密钥只放在被 Git 忽略的 `.env` 或服务端环境变量中。DeepSeek 用于文本对话；语音继续使用本地声音、浏览器 TTS 或独立语音供应商。AWS 发布脚本会将上述文本配置注入服务端容器环境，不打入镜像，也不写入公开部署元数据。

生成媒体独立配置 `SCENE_IMAGE_API_KEY`（默认 `gpt-image-2`，可设置 `SCENE_IMAGE_BASE_URL/SCENE_IMAGE_MODEL`），图片使用当前角色 PNG 参考图。视频必须同时设置 `SCENE_VIDEO_API_KEY`、`SCENE_VIDEO_BASE_URL`、`SCENE_VIDEO_MODEL`，接口需兼容异步 `/videos` 创建、状态查询及 `/content` 下载合约。**不默认调用已退役的 OpenAI 视频接口，也不会自动选取 Sora 模型。** 供应商使用其他合约时需修改服务端适配器。

连接后设置中可选择“AI 创作”，并选择开启“剧情节点创作”：照片/雨停等节点使用当前对话、天气与截图请求新影像，等待时保留角色动画。未开启时只由相机/胶片按钮发起。任务支持进度、取消、缓存和重试；PNG 解析、尺寸、透明度及近空白检查可以发现基础失败，不能判断语义或身份连续性。未配置凭证时明确使用留影与本地回放。

浏览器 SpeechRecognition 的可用性、语言识别和网络服务由浏览器决定。未支持时需要配置 STT；未配置时清晰反馈并保留文字输入。麦克风要求 HTTPS 或 localhost；远程 HTTP 页面不能保证录音。预录 MP3 让默认回复声音不依赖 SpeechSynthesis 的中文声音安装情况。

## 技术选择与限制

- React + Vite + Express：一个进程启动，前后端职责清楚，取消流程容易检查。
- 原创程序化 Three.js 角色：能在同一套模型上连续表现表情与动作，不引入未经授权的真人或角色素材。当前美术属于风格化 MVP，不能与专业 Live2D/VRM 建模质量等同。
- 逐句 JSON 指令可以边生成边表演；MP3 流式 TTS 优先使用 MediaSource，浏览器不支持时完整下载后播放。没有端到端全双工语音模型。
- 自然语音依赖本地 VAD、浏览器识别或服务端 STT；附和与回声鉴别属于规则及浏览器能力，尚未做实体设备声学验收。
- ACK 发生在执行句子前，若浏览器在确认后立即崩溃，恢复会重新播放最后确认的一句，无法做到事务性的“已经听见”。完整 JSON 兼容模式仍在交付整轮时提交状态。
- 会话与缓存为单机文件持久化，不支持跨节点共享；导入的会话建立新服务端 ID，历史内容用于本地回放，新的 Mock 交流从新故事状态开始。
- DeepSeek 文本模型已实际验证完整和流式回复；语音与生成媒体供应商尚未完成真实在线验收。错误、格式、超时与取消继续通过可控 HTTP 替身验证。实体手机和真实麦克风仍需要用户验收。
- WebGL 不可用时降级插画和文字。视频需浏览器支持对应编解码，内置 Chromium 使用 WebM；外部生成 MP4 不保证所有 Chromium 构建均可播放，失败保留原场景。
- 参考图和身份提示不能保证生成角色一致；基础空白检测不能检测畸形、服装或语义错误。真实图片/视频 Provider 仅通过合约替身测试，未使用私人凭证在线验收。

## 验证与演示

自动化验证记录见 `docs/VALIDATION.md`。测试覆盖输入校验、内容驱动场景、连续输入、取消、断开连接、错误重试、真实 Provider 格式错误和超时，以及浏览器实际音频/媒体生命周期。录屏说明见 `artifacts/DEMO.md`。

主要第三方依赖与素材来源见 [docs/ASSETS.md](docs/ASSETS.md)。本地合成语音来自 Microsoft Edge Xiaoxiao，生成工具为 edge-tts；运行时只播放已保存文件。代码与自制插画未使用外部人物资产。

## 投入与后续两周

实现日期：2026-10-27。时间记录、AI 参与方式及验证边界见 [AI_USAGE.md](AI_USAGE.md)。这是 AI 辅助实现，用户尚未完成真实设备验收，不将自动化操作表述为人工验证。

| 时间 | 演进方向 |
| --- | --- |
| 第 1–3 天 | 手机/耳机/蓝牙设备实测，真实 STT/TTS 与生成服务联调，弱网基线 |
| 第 4–6 天 | 对接带音素时间戳的语音，替换估算对齐，精修角色建模与表演 |
| 第 7–9 天 | 用实际声学数据调整回声与附和阈值，补充多人声和噪声验收 |
| 第 10–12 天 | 生成身份一致性评分、视频逐帧质量检测、缓存预算与权限管理 |
| 第 13–14 天 | 跨设备回归、可访问性、监控告警与反馈修正 |
