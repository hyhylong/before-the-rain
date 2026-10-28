# 语音、自动倾听与口型

## 真实音频驱动

`SpeechPlayer` 将播放的 HTMLAudioElement 接入 Web Audio `AnalyserNode`，每帧读取实际时域样本并计算 RMS。没有使用随机数或正弦波冒充音量。角色嘴部与肩膀动作可以使用这个真实幅度；暂停、取消或静音后立即归零。浏览器不允许创建 AudioContext 时保持原生音频播放，不伪造幅度。

`unlock()` 应从用户手势中调用，以满足移动浏览器的音频策略。`setDucked(true)` 把角色声音暂时降至 15%，允许对短附和先做判断；不取消当前字幕与回复。音量滑块会更新正在播放的片段。

播放中静音会立即更新实际音频元素，字幕继续推进，取消静音可恢复该片段的声音。浏览器 Web Speech 无法可靠修改已开始 utterance 的音量，因此对浏览器 TTS 静音时会取消合成，并从当前进度继续字幕；同一句话不会因取消静音而从头重读。

## 口型时间线的准确性

本地 35 段 MP3 的真实长度经 ffprobe 测量，`pinyin-pro` 将中文映射为 aa/ee/oo/closed 嘴型。音素时间在真实片长中按字符和停顿权重估计，并由实际音频 RMS 对静音部分关嘴。数据源明确标记 `estimated-pinyin`。

**这不是强制对齐得到的逐音素精确时间戳。** 对声画时间要求更高时，Provider 可通过 `SpeechPlayer.play(...,{timing:{durationMs,cues,source}})` 传入真实音素/viseme 时间戳；`cues` 格式为 `{charIndex,startMs,endMs,shape}`。浏览器 TTS 的 `boundary` 事件用于推进实际字符位置，它仍不能提供精确声学分析。

再生成侧车：`node scripts/audio-timing.mjs`。它不会重新请求 TTS。

## 流式播放与指标

真实服务使用 `/api/tts/stream`，支持 MPEG SourceBuffer 的浏览器通过 MediaSource 边接收边追加 MP3，收到首块后无需等待整段下载。未支持该容器时退回完整音频 Blob；浏览器 TTS 和字幕是后续降级途径。

所有读取器、音频、SourceBuffer、对象 URL 和分析节点受同一取消信号管理。迟到网络片段不能重新播放。回调 `onTiming` 分别记录首个网络音频块和实际开始播放的时间；两者不会混为一个“首包延迟”。预录片段也记录实际播放等待时间。

## 自动倾听

使用 `@ricky0123/vad-web` 的 Silero V5 模型与 ONNX Runtime Web，推理在浏览器中进行。模型、AudioWorklet 和 WASM 位于同源 `/vad/`，运行时不加载 CDN。准备资源：`node scripts/prepare-voice.mjs`。

麦克风约束开启浏览器提供的 `echoCancellation`、`noiseSuppression` 与 `autoGainControl`。这些是设备和浏览器能力请求，不意味着所有声学环境下已经通过硬件回声测试。播放文本包含的长段识别结果还会进行回声文本过滤，属于补充启发式。

检测到初始语音时发出 `candidate`，角色声音降低但继续播放。识别到持续至少约 650ms 的实质内容才发出 `interrupt`；“嗯”“对”“好的”等短附和恢复原播放。持续 1.9 秒以上的确认语音即使识别还没返回也会打断。VAD 判定的噪声误触发不提交用户消息。非说话状态检测到声音发出 `listening`。

优先并行使用浏览器 SpeechRecognition 的中间结果；它可能使用浏览器厂商网络服务。不可用时将 VAD 切出的 16kHz WAV 发给已配置的服务端 STT。没有任何识别服务时会说明问题，不把 VAD 检测等同于识别成功。服务端 STT 方案需要语段结束后才有文本，因此对短句的语义打断可能晚于浏览器中间结果方案。

`createAutomaticVoice` 返回 `start()`、`stop()`、`setPlayback(bool)`。每次启停都有独立代数，停止后的模型加载、麦克风授权或识别回调不能恢复旧监听。正常的角色轮次打断无需关闭自动倾听本身。

真实麦克风要求 HTTPS 或 localhost。自动化验证覆盖控制流、回声约束、附和分类、分块播放及取消；实体扬声器、蓝牙设备和各移动浏览器的声学效果仍需实测。

## 浏览器实测

`node scripts/audio-runtime.mjs` 对本地开发服务运行真实 Chromium。测试将现有 MP3 经 ffmpeg 转为假麦克风输入，让同源 Silero V5 模型和 ONNX/WASM 实际推理，确认 `candidate → interrupt → transcript` 回调，并在停止后检查所有麦克风轨道均为 ended。STT 文本由测试接口提供，未把它当作真实供应商识别准确率测试。

同一测试通过真实 MediaSource 解码 MP3，并读取 Web Audio 时域数据，验证播放来源为 `stream`、RMS 幅度非零和口型变化。测试记录独立的首块到达与开始播放时间；本地夹具延迟不能代表线上供应商延迟。服务需先运行 `PORT=4185 NODE_ENV=development node server/index.mjs`，也可用 `AUDIO_TEST_URL` 指定地址。

另以 Chromium 的真实 HTMLAudioElement → Web Audio 音频图验证播放中静音：可听样本 RMS 约 0.089，静音后为 0，取消静音后恢复至约 0.125。单元测试同时检查音量、附和降音量和静音组合，以及浏览器 TTS 取消后字幕继续。

## 依赖与素材

- Silero VAD: https://github.com/snakers4/silero-vad ，MIT。
- vad-web: https://github.com/ricky0123/vad ，ISC。
- ONNX Runtime: https://github.com/microsoft/onnxruntime ，MIT。
- pinyin-pro: https://github.com/zh-lx/pinyin-pro ，MIT。
