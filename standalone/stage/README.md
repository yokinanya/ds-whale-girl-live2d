# 独立 OBS 舞台

通过提供本目录和仓库 `assets` 的 HTTP 服务访问 `/overlay?token=...`，例如独立后端 `createOverlayServer({ stageDir, assetsDir })` 返回的 `overlayUrl`。OBS 浏览器源开启透明背景，尺寸由浏览器源决定；需要支持 WebGL。不能用 `file://` 直接打开。无需 DSH 服务、外部 CDN 或网络资源。

服务必须将 `/overlay` 映射到 `index.html`，将 `/stage/` 映射到本目录，`/assets/` 映射到仓库的 `assets/`，并提供同源 SSE `/events?token=...`。舞台读取 URL 中的 token 并编码后传给 SSE；EventSource 自动重连。不要公开包含 token 的 URL。

## 事件接口

SSE 使用默认 `message` 事件，每条 `data` 为 JSON：

```json
{"type":"performance","text":"你好！","motion":"splash","expression":"开心兴奋"}
```

`text`、`motion`、`expression` 至少提供一个；可以单独发送或组合。校验通过后各字段分别生效，不保证动作、表情与排队文本同时出现。任一字段无效会拒绝整条事件：

- `text`：字符串，最多 500 个 Unicode 码点，超过即拒绝。使用纯文本渲染而非 HTML。非空文本按接收顺序排队，每条展示 5 秒；等待队列最多 10 条（不含当前显示），满时丢弃最旧的等待文本。等待满 30 秒的文本在轮到展示时丢弃，避免展示过时信息；当前文本展示期不受该期限影响。空字符串立即清空当前文本和等待队列。长文字在气泡区域裁切。
- `motion`：`idle`、`aidale`、`selfie`、`selfieQuick`、`ketchup`、`openLid`、`bubble`、`splash` 之一；`null` 表示不播放。动作以强制优先级覆盖当前动作，异步加载按接收顺序处理，不等待上个动作完成。
- `expression`：`null` 重置，或使用下列标识之一的字符串；省略表示保持原状态，空字符串无效。单一表情持续到下次切换或重置，也包括道具类表达式，不能叠加多个。不会修改动作本身的参数；动作本身可能包含表情，重置不保证动作瞬间恢复为默认脸。

表情标识来源是 `/assets/model/manifest.json` 的 `expressions` 对象键；控制台可直接读取 `whaleStage.expressions`（冻结数组，启动即有），也可读取 manifest。当前可用标识：

```text
love、兔兔贴纸、单边马尾、双手比耶、吐舌、吐魂、呆呆眼、哭、喵喵手~喵~动画、圆眼镜、墨镜、头箍、巴菲、开心兴奋、心跳、悲伤、情绪花花、感叹号、手机换色、挤、撤回、方眼镜、星星眼、晕晕、椭圆眼镜、橡皮、流汗、深色桌布、点菜按下、爱心眼、猫猫贴纸、生气、画笔、脸红、蛋包饭、蝴蝶结贴纸、调皮、闭眼口水、问号、阴暗、魔爪、魔爪换色、鲸鱼、鲸鱼放桌上
```

模型没有注册 expression 文件。舞台参考 `assets/pet.js`，在 `beforeModelUpdate` 按 manifest 的 `Add` 参数叠加表情，过滤 CDI 中不存在的参数，每帧由框架恢复底层参数，避免累积；不提供桌宠的淡入淡出或其他 rig。模型和表情数据加载期间保留最新表情，加载失败在控制台报告，文本和动作不受表情资源失败影响。标识是与当前模型匹配的固定目录；模型资源更新后需同步修改舞台目录和测试。表情或动作可能受模型参数范围和动作影响，视觉效果不保证完全相同。

手动测试：

```js
whaleStage.expressions
whaleStage.perform({ type: 'performance', text: '你好！', motion: 'splash', expression: '哭' })
whaleStage.perform({ type: 'performance', expression: null })
```

`perform` 同步返回校验是否通过，不代表资源加载或播放成功；错误查看浏览器控制台。模型按资源画布等比缩放，留有顶部气泡空间，特定动作可能超出模型画布。验证：在仓库根目录运行 `node --test standalone/stage/stage.test.js`。OBS 实际显示依赖其浏览器版本、WebGL 驱动和浏览器源画布尺寸。
