# NGA 阅读器

把 NGA 帖子做成无限滚动的桌面阅读器，支持只看楼主、按时间筛选，并可用大模型总结楼主观点。

## 功能

- NGA 原版风格排版，引用、楼中楼、表情、图片完整显示
- 无限滚动，不用翻页；默认最新在下，也可最新在上 / 从头看
- 刷新 / 自动刷新，新楼层高亮
- 只看楼主、按时间筛选（近 1 小时、今天、昨天、自定义）、跳到楼层
- AI 分析：总结观点、观点变化、预判与计划、自由提问，结论标注来源楼层可点击跳转
- AI 服务商：Cursor、OpenCode Go、DeepSeek、通义千问、Kimi、智谱、硅基流动、OpenRouter、OpenAI、本地 Ollama、任意 OpenAI 兼容接口

不需要 NGA 账号，以游客身份访问。

## 直接使用（推荐）

到 Releases 下载 `NGAReader.zip`，解压后双击 `NGAReader.exe`。不需要安装 Python。

需要 Windows 10/11，以及 Edge 或 Chrome 浏览器。

zip 里的 `源码/` 是完整源码，可以随意修改：

- 只改界面：直接编辑 `_internal/web/` 下的文件，重启程序即生效
- 改后端或想重新打包：进入 `源码/`，按下面「从源码运行」「打包」操作

## 从源码运行

```bash
pip install -r requirements.txt
```

双击 `启动.vbs`（无命令行窗口）或运行 `pythonw app.py`。

## 打包

```bash
python build.py
```

产物在 `dist/NGAReader/` 和 `dist/NGAReader.zip`，不会包含 `data/`。

## AI 分析

左侧栏「AI 分析 → 设置」选择服务商，填入自己的 API Key。Key 只保存在本机 `data/ai.json`，消耗的是自己的额度。

- 论坛内容作为资料传给模型，提示词要求忽略其中的指令；OpenAI 兼容接口不传任何工具
- Cursor 以本地 Agent 运行：不给任何工具、空工作目录、不加载本机规则和插件
- OpenCode Go 官方定位是给编程 Agent 使用，用于论坛总结存在被限制的风险

## 数据目录

`data/` 保存 API Key、浏览器配置、昵称缓存、AI 缓存和日志，已在 `.gitignore` 中排除，**不要分享这个目录**。

## 许可证

[MIT](LICENSE)：可以自由使用、修改、分发，保留版权声明即可。
