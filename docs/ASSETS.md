# 素材与生成记录

## 角色、场景与照片

- Mira 为本项目原创的 26 岁成年旅行摄影师；角色外观和咖啡馆由项目内的 Three.js 几何模型构成，不使用外部人物模型或真人肖像。
- `public/images/lighthouse.svg` 为本项目手工编写的原创灯塔海岸插画，表现剧情中的纪念照片；`lighthouse.png` 为同一插画的栅格版本。图形由代码制作，无图片生成服务或第三方图片下载。
- PNG 再生成命令：安装 CairoSVG 后执行 `python -m cairosvg public/images/lighthouse.svg -o public/images/lighthouse.png`。既有 PNG 可直接使用，无需运行此命令。
- 界面图标来自 Lucide，使用其 ISC 许可证。

## 预录语音

- `public/audio/*.mp3` 为本项目原创中文台词的合成语音；声音为 Microsoft Edge 在线语音的 `zh-CN-XiaoxiaoNeural`，通过开源 `edge-tts` 7.3.1 工具生成，语速为 `-8%`。
- `public/audio/manifest.json` 按精确台词映射本地 MP3。演示运行时仅播放仓库内文件，不连接 Microsoft，不需要私人 API 密钥。真实模型产生的新台词使用配置的 TTS 服务或浏览器语音合成。
- `edge-tts` 是 LGPL-3.0 开源客户端，不代表 Microsoft 对此应用的授权或背书；Microsoft 的服务使用条件与合成音频的使用权适用其当时的条款。现有声音用于候选实验演示；商业化前应换为拥有明确商用授权的 TTS 服务或自行录制。
- 再生成需要联网、Python 以及 `python -m pip install edge-tts==7.3.1`，随后在仓库根目录执行 `node scripts/generate-audio.mjs`。生成器从 `server/story.mjs` 的 `ALL_MOCK_LINES` 读取台词，按 SHA-256 摘要命名，已存在的音频不会重复请求。使用 `MIRA_AUDIO_PYTHON` 可以指定 Python 路径。
- 更新台词后需要重新生成语音映射；不应将不同文本映射到旧的录音，以免字幕与声音不一致。

## 依赖来源

- Three.js: https://threejs.org/ ，MIT。
- Lucide: https://lucide.dev/ ，ISC。
- edge-tts: https://github.com/rany2/edge-tts ，LGPL-3.0。
- 没有使用商业电影片段、角色贴图或第三方照片。

## 扩展素材

- `public/video` 中的 WebM、MP4、封面与透明雨线层由本项目 Three.js 场景及灯塔插画生成；旁白复用上述项目中文音频，不是外部生成模型产物。再生成命令与编解码约束见 [SCENE.md](SCENE.md)。
- `public/vad` 来自 `@ricky0123/vad-web` 的 Silero V5、工作线程及 `onnxruntime-web` 的 WASM，启动/构建脚本从锁定 npm 依赖准备同源资源。相关许可证随资源保留，详见 [AUDIO.md](AUDIO.md)。
- `public/audio/timing.json` 是基于实测音频时长和 pinyin-pro 的估算元音时间线，不是供应商返回的精确音素对齐。
