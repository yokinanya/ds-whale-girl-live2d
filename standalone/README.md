# 鲸鱼娘 OBS 独立程序

本目录是独立于 DSH 的直播互动程序。控制台运行在本机，OBS 使用透明浏览器源；B 站弹幕需要另外运行本地 [blivechat](https://github.com/xfgryujk/blivechat)。程序不向 B 站发送弹幕，模型回复仅显示在画面气泡中。

## 授权

代码许可、模型素材及第三方运行时许可不同，详见上级 [NOTICE](../NOTICE.md)、[PROVENANCE](../PROVENANCE.md) 和 [AUTHORS](../AUTHORS.md)。当前鲸鱼娘角色和模型仅可用于符合现有非商业许可的场景，使用及分发需保留署名；Live2D Cubism Core 也适用其专有许可。收费、带货、广告等商业直播不能仅凭本项目代码的 MIT 许可使用该模型。

## 开发与 Windows 打包

在本目录执行 `npm install`、`npm start`；构建 Windows 安装包使用 `npm run dist:win`。打包时需要下载 Electron 与构建工具，在 Linux 交叉构建 NSIS 安装包还需要 Wine；也可执行 `npx electron-builder --win zip --x64 --publish never` 构建免安装包。软件依赖网络、上游 blivechat 及用户提供的 OpenAI 兼容服务；会将选中的弹幕发送至模型服务商，可能产生费用。

先启动本地 blivechat 服务并确认可访问，在本程序填写服务地址、直播间房间号或直播开放平台身份码、模型服务地址、模型名和 API 密钥，保存后点击「连接弹幕」。身份码仅用于本次连接，不会保存。复制 OBS 浏览器源地址并添加为 OBS 浏览器源。当前适配上游聊天转发 `/api/chat` 协议，不需要安装 blivechat 插件；该协议是否能在目标服务版本和接入方式下正常接收弹幕仍需真实联调。

配置和加密密钥保存在 Electron 用户数据目录，密钥依赖系统安全存储，安全存储不可用时不会明文保存。OBS 地址只读且带随机访问令牌，切勿公开分享；重新启动程序会更换令牌，需更新 OBS 浏览器源地址。

## 验证限制

目前仍是开发中的原型：尚需在真实 Windows、OBS、blivechat 和可用模型服务上进行端到端联调；在完成该验证之前不能声称安装包或直播连接已在真机通过。上游接口和 B 站接入要求可能变动，若连接失败应检查 blivechat 版本、直播房间状态，不要将已连接转发服务误认为已确认接收到直播弹幕。自动化测试使用模拟弹幕和模型服务，不能保证真实环境可用。

Electron 控制台和 Chromium 浏览器源已在 Linux 测试模型加载及手动气泡；Windows 免安装 ZIP 尚未在 Windows 中运行，且构建产物不跟随代码提交；Linux 构建 NSIS 安装包由于缺少 Wine 未完成。
