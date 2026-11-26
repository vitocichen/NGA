# NGA 阅读器

把 NGA 帖子做成无限滚动的桌面阅读器，支持只看楼主、按时间筛选，并可用大模型总结楼主观点。

## 功能

- NGA 原版风格排版，引用、楼中楼、表情、图片完整显示
- 无限滚动，不用翻页；默认最新在下，也可最新在上 / 从头看
- 刷新 / 自动刷新，新楼层高亮
- 只看楼主、按时间筛选（近 1 小时、今天、昨天、自定义）、跳到楼层
- AI 分析：总结观点、观点变化、预判与计划、自由提问，结论标注来源楼层可点击跳转
- AI 服务商：Cursor、OpenCode Go、DeepSeek、通义千问、Kimi、智谱、硅基流动、OpenRouter、OpenAI、本地 Ollama、任意 OpenAI 兼容接口
- A 股行情（侧栏顶部切换）：市场概况（放量 / 缩量、涨跌分布、主力净流入、昨日涨停表现）、四大指数、今天的成交节奏、行业 / 概念板块排行与成分股、自选分组、搜索看个股分时，盘中 3 秒刷新

不需要 NGA 账号，以游客身份访问。

## A 股行情

不需要账号。行情、分时来自腾讯财经（新浪、东方财富备用）；涨跌分布、主力净流入、昨日涨停表现、近 60 日成交额、板块来自东方财富（约 1 分钟刷新一次，东财按 IP 限制请求次数，被限制时暂停 2 分钟并先显示上次的数据）。板块搜索用程序自带的板块名单（`web/boards_seed.json`，来自东财行情中心菜单，每 7 天在后台更新），支持名称和拼音首字母。

- 两市成交总额 = 上证指数（沪市全市场）+ 深证综指（深市全市场），不含北交所
- 较前一日同期：今天到现在的成交额对比昨天到同一时刻（盘中按本分钟已过秒数折算），多为放量、少为缩量
- 预测成交总额：近几个交易日每分钟的成交占比 + 剩余时段贝叶斯收缩，开盘初期不会因单日高开低开剧烈失真；后面的百分比是对比近 60 日平均
- 量比（板块、个股、指数）：当前每分钟成交量 ÷ 近 5 日同时段平均，≥1.2 标放量，≤0.8 标缩量
- 自选分组保存在本机浏览器配置里；开盘前显示上一交易日复盘，午休、收盘后自动降低刷新频率

算法和口径参考 [ashare-volpulse](https://github.com/LostMoonkin/ashare-volpulse)（MIT）。仅供参考，不构成投资建议。

## 直接使用（推荐）

到 Releases 下载 `NGAReader.zip`，解压后双击 `NGAReader.exe`。不需要安装 Python。

需要 Windows 10/11，以及 Edge 或 Chrome 浏览器。

zip 里的 `源码/` 是完整源码，可以随意修改：

- 只改界面：直接编辑 `_internal/web/` 下的文件，重启程序即生效
- 改后端或想重新打包：进入 `源码/`，按下面「从源码运行」「打包」操作

## 从源码运行（Windows / Mac）

需要 Python 3 和 Chrome / Edge 浏览器（没有时用系统默认浏览器打开）。启动脚本会自动安装依赖。

| 系统 | 双击 |
|---|---|
| Windows | `启动_windows.bat` |
| Mac | `启动_mac.command` |

### Mac 使用

1. 没有 Python 时到 [python.org](https://www.python.org/downloads/macos/) 安装 Python 3
2. 双击 `启动_mac.command`。如果提示“没有权限”或“无法打开”：
   - 打开「终端」，输入 `chmod +x ` （末尾有空格），把 `启动_mac.command` 拖进终端窗口，回车
   - 再在访达里**右键 → 打开**（第一次需要这样绕过“未知开发者”提示）
3. 第一次会自动创建运行环境 `.venv` 并安装依赖，之后打开都很快

打包好的 `NGAReader.exe` 只支持 Windows，Mac 请用源码运行。

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

第三方组件：

| 组件 | 用途 | 许可证 |
|---|---|---|
| [marked](https://github.com/markedjs/marked)（`web/marked.min.js`） | AI 回复的 Markdown 渲染 | MIT |
| [Apache ECharts](https://echarts.apache.org/)（`web/echarts.min.js`） | A 股行情图表 | Apache-2.0 |
| [ashare-volpulse](https://github.com/LostMoonkin/ashare-volpulse) | 成交额同比、全天预测的算法与口径（移植到 `ashare.py`、`web/vol.js`） | MIT，Copyright (c) 2026 lostmoonkin@lishui |
