# 开发工作台

供日常工作使用的 Chrome / Edge Manifest V3 浏览器扩展。基于 `cookie-workbench` 的 Vue 3、Vite 8、TypeScript、Element Plus、SCSS 和 pnpm 工程方式，提供今日待办弹窗与 17 个开发工具。

输入、结果、草稿、历史、请求集合、文件附件、二维码 Logo、待办和全局设置都保存在当前浏览器的 **IndexedDB**。无需账号，不接入云端存储或遥测；字体、脚本和依赖随插件打包，断网也能使用本地工具。HTTP / WebSocket 仅在主动发送或连接时访问填写的目标地址。

## 安装与使用

从 [GitHub Releases](https://github.com/awaity/dev-workbench/releases) 直接下载 ZIP，无需克隆仓库或自行构建。推荐使用 v1.3.0。

| 版本           | 下载                                                                                                        | 主要功能                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| v1.3.0（推荐） | [下载 ZIP](https://github.com/awaity/dev-workbench/releases/download/v1.3.0/dev-workbench-1.3.0-chrome.zip) | 今日待办弹窗、Markdown 导出、工作台新页面入口 |
| v1.2.0         | [下载 ZIP](https://github.com/awaity/dev-workbench/releases/download/v1.2.0/dev-workbench-1.2.0-chrome.zip) | 自动清理历史与无引用附件，默认保留 30 天      |
| v1.1.0         | [下载 ZIP](https://github.com/awaity/dev-workbench/releases/download/v1.1.0/dev-workbench-1.1.0-chrome.zip) | 新图标、form-data 与多文件、cURL、请求集合    |
| v1.0.0         | [下载 ZIP](https://github.com/awaity/dev-workbench/releases/download/v1.0.0/dev-workbench-1.0.0-chrome.zip) | 首版 17 个本地开发工具                        |

历史版本为原始安装包归档，文件版本以 ZIP 中的 manifest 为准；仓库提交历史从当前 v1.3.0 源码快照开始。

- ZIP：`.output/dev-workbench-1.3.0-chrome.zip`，根目录包含 `manifest.json`。
- 同内容的解压目录：`.output/chrome-mv3/`。
- Chrome 打开 `chrome://extensions`，Edge 打开 `edge://extensions`。使用已验证可用的 ZIP 加载方式直接导入；同时提供相同内容的扩展目录。
- 点击扩展图标打开今日待办弹窗；底部“打开开发工作台”直接创建新的工作台标签页。浏览器扩展详情中的“扩展程序选项”进入全局设置。
- 左侧选择工具，`Ctrl / ⌘ + K` 搜索，星标收藏常用工具。右侧历史支持搜索、恢复和删除；“历史”按钮可以收起面板。

浏览器验证脚本实际加载的是完整 MV3 扩展目录，不将普通网页预览作为扩展验收。ZIP 与该目录由同一次构建产生。

## 功能

### 今日待办

参考 Todoist 的清爽任务列表，沿用开发工作台的 W 图标与深蓝色。弹窗宽 440 px，期望高 580 px；浏览器可用高度较小时收缩任务滚动区，始终保留底部工作台入口。独立的 `popup.html` 不加载代码编辑器或加密工具。

- 新增、编辑、删除、勾选完成和恢复；支持最多 200 字的名称、2000 字的多行备注、三档优先级与可清空的日期。Enter 保存名称，Ctrl / ⌘ + Enter 保存备注；中文输入法确认候选字时不提交。
- “今日”显示今天及之前仍未完成的任务，以及今天完成的任务；过期待办继续显示。未来任务与未安排日期的任务在“全部”查看；“已完成”可查看和恢复历史完成项。
- 按本地日历日期分组，跨午夜自动更新。今日进度以当前今日视图的未完成数与今天完成数计算。
- “导出 MD”可选择当前视图或全部待办，下载 UTF-8 Markdown；包含 `- [ ]` / `- [x]`、日期、优先级和备注。仅导出已保存的任务。
- 任务保存后立即写入本机 IndexedDB，关闭弹窗后保留；多个扩展页面自动刷新。沿用全局浅色 / 深色 / 跟随系统设置。
- 待办最多 10000 条，不参与工具历史的 30 天自动清理。全局 JSON 备份包含待办，“清除全部数据”也会清除待办。

### 开发工具

| 分组        | 工具与能力                                                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 开发        | HTTP：常用与自定义方法、查询参数/请求头、form-data 多文件、binary、raw 五种格式、URL 编码表单、Bearer / Basic / API Key、变量、cURL、本地请求集合、响应预览/下载、超时/取消与历史恢复 |
| 开发        | WebSocket：ws / wss、子协议、连接/断开、发送文本、接收文本/二进制预览、日志复制下载、草稿和历史                                                                                       |
| JSON        | 本地校验、格式化、压缩、转义/反转义、文件导入导出、代码搜索、语法高亮、折叠与树视图                                                                                                   |
| JSON 编辑器 | 代码与树同步，编辑任意节点、增加对象字段或数组元素、删除节点；支持根节点和特殊字段名                                                                                                  |
| JSONPath    | 根路径、子属性、递归、通配、切片和过滤表达式；结果与匹配路径；CSP 兼容解释执行                                                                                                        |
| 国密 SM4    | CBC / ECB、PKCS#7 / 无填充、UTF-8 / Hex 密钥和 IV、Hex / Base64 密文、随机密钥和 IV                                                                                                   |
| 国密 SM2    | 密钥对生成、C1C3C2 / C1C2C3、Hex / Base64 密文、公钥加密/私钥解密、完整性校验                                                                                                         |
| MD5         | 32 / 16 位、大小写、原文校验、本地逐行字典匹配、数字范围匹配（可前补零、可取消）                                                                                                      |
| Base64      | 中文与 Emoji 的 UTF-8 编解码、标准 / URL 安全格式、严格输入校验                                                                                                                       |
| SHA         | SHA1 / 224 / 256 / 384 / 512、HMAC、大小写输出                                                                                                                                        |
| RSA         | 2048 / 3072 / 4096 位密钥生成；PEM；PKCS#1 v1.5 / OAEP-SHA1 / OAEP-SHA256；加解密                                                                                                     |
| AES         | 128 / 192 / 256 位密钥、CBC / ECB、PKCS#7 / 无填充、Hex / Base64                                                                                                                      |
| DES         | DES / Triple DES、CBC / ECB、PKCS#7 / 无填充、Hex / Base64                                                                                                                            |
| JWT         | Header / Payload / 签名解析、iat / nbf / exp 时间、过期提示、可选 HS256 验签                                                                                                          |
| Bcrypt      | 自动随机盐、工作因子 4–16、哈希生成、原文校验、超出 72 字节时拒绝截断                                                                                                                 |
| URL         | URL 组件 / 整体地址编解码、表单空格与 `+` 互转                                                                                                                                        |
| 二维码      | 文本/网址、128–2048 px、纠错等级、码点与背景配色、码点/定位点样式、本地 Logo、PNG / SVG 下载、名称与历史恢复                                                                          |

## HTTP 使用说明

1. 选择方法、填写 URL。在查询参数或请求头页签逐项编辑，支持重复名称、启停、描述和批量文本编辑。URL 已有参数可一键提取到表格。
2. 请求体支持 `none`、`form-data`、`x-www-form-urlencoded`、`raw`、`binary`。`raw` 可选 JSON / Text / XML / HTML / JavaScript，自动设置对应 Content-Type，手动请求头优先。
3. `form-data` 行可切换 Text / File；File 支持一次选择多个文件，以同名字段发送。浏览器自动产生 multipart boundary；手动填写的 Content-Type 会移除并提示。`binary` 将文件原始字节直接作为请求体。
4. 变量使用 `{{name}}`，作用于当前请求的 URL、参数、请求头、鉴权和文本请求体。支持变量递归，缺失、重复或循环时在发送前报错。变量随草稿、历史和集合保存。
5. 集合支持命名、分组、搜索、恢复、覆盖保存、另存与删除；集合保存配置，历史保存此次请求与响应。文件字节存入 IndexedDB，刷新、重开、恢复历史、恢复集合及备份导入后仍可发送。
6. cURL 使用 POSIX / Bash 语法，支持常见 `-X`、`-H`、`-d`、`--data-raw`、`--data-urlencode`、`-F`、`--form-string`、`--data-binary`、`-u`、`-G`、`-L` 等。仅解析文本，未知或不能正确转换的选项明确报错；导入本地路径后需要重新选择文件，导出文件名需要改成实际路径。
7. 响应支持 Pretty / Raw、响应头、JSON 树和常见位图预览。二进制显示 Base64，下载还原原始字节。HTML / SVG 不作为活动网页执行。关闭“自动跟随重定向”会终止跳转，浏览器不能读取被阻止跳转的原始响应。

本版覆盖日常 HTTP 调试流程；尚未包含 Postman 的脚本执行、集合批量运行、GraphQL 专用编辑器、OAuth 流程或客户端证书管理。

## 全局设置与数据

支持浅色 / 深色 / 跟随系统、默认工具、JSON 缩进、新 HTTP 请求默认超时、新二维码默认尺寸、草稿自动保存、历史开关和总保留数量（10–2000 条），以及数据管理中的自动清理。修改默认超时或二维码尺寸只影响新草稿；恢复的历史保留原配置。

数据库名 `dev-workbench`，版本 3，有 `settings`、`drafts`、`history`、`requests`、`attachments`、`todos` 六个对象仓库；升级自动保留版本 1 / 2 的数据。工具界面变化后约 250 ms 自动保存草稿；切换工具时刷新草稿。待办在点击添加 / 保存或按回车后写入；未提交的编辑内容在关闭弹窗时丢弃。已有扩展数据不写入 `localStorage` 或 `chrome.storage`。

“导出本地备份”包含待办、设置、工具输入/结果、密钥、接口鉴权信息、历史、Logo、请求集合和附件字节。版本 3 备份以 Base64 保存文件，兼容导入版本 1 / 2。“导入备份”验证版本、工具与待办数据、重复 ID、附件大小与引用完整性，然后在一个事务中替换现有数据；不合法备份不会部分覆盖。旧版备份未包含待办，导入时保留现有待办；版本 3 备份会替换待办，空清单表示清空，缺失该字段则拒绝导入。备份是明文 JSON，请自行保管。关闭自动保存并保存设置会删除现有工具草稿；关闭历史记录不会删除已有历史。可以独立清空历史、清理未引用附件，或清除全部数据。附件清理会保留草稿、历史和集合中的所有引用（包括停用字段），以及一分钟内新上传的附件。

自动清理默认开启，保留 **30 天**，可在「全局设置 → 数据管理」修改为 1–3650 天或关闭。按创建时间清理超过期限的历史记录，以及超过相同期限且不再被草稿、历史或请求集合引用的附件。恰好处于期限边界的记录仍保留；待办、草稿、请求集合和仍被引用的文件不会因年龄而删除。历史数量上限与天数规则同时生效。

扩展后台每天检查一次，即使工作台标签页关闭也会运行；打开工作台、保存设置和导入备份时立即应用规则。浏览器关闭时不运行，重启后补做检查；关闭开关会移除后台定时任务。「按已保存规则清理」可立即执行当前规则。「清理未引用附件」是独立的手动操作，只给新上传附件保留一分钟宽限，不受自动保留天数限制。

旧设置及旧版备份缺少自动清理配置时，使用默认开启、保留 30 天的规则。清理配置随备份导出和恢复；导入时也会按备份中的配置处理过期数据。

数据属于当前扩展及浏览器配置。卸载、清除浏览器扩展数据、更换浏览器配置、改变解压安装目录（可能改变开发版扩展 ID）时，应先导出备份。

## 兼容约定

- MD5 是摘要，无法直接逆向“解密”。这里的 MD5 解密是**本地候选匹配**，不会上传摘要；每次最多 100,000 行候选或 1,000,001 个数字，任务可取消。
- Base64 / URL 是编码。JWT 的解码不代表签名可信，未验签结果会明确标记。验签当前支持 HS256，其他算法可解析。
- 对称密码的明文采用 UTF-8；密钥/IV 可选择 UTF-8 或 Hex，密文可选 Hex / Base64。AES / SM4 的块为 16 字节，DES 的块为 8 字节。无填充时明文须为整块。CBC / ECB 不提供消息认证；这些工具用于开发调试和系统兼容。
- SM2 公钥、密文带 `04` 未压缩点前缀，私钥 64 位 Hex。旧库的临时密钥随机源在适配层中替换为 `crypto.getRandomValues`，有测试验证。
- RSA 公钥支持 SPKI / PKCS#1，私钥支持未加密 PKCS#1 / PKCS#8。OAEP 的 MGF1 哈希与选定哈希相同。RSA 只适合短文本，超过密钥/填充容量会报错。
- HTTP / WebSocket 遵循浏览器网络与证书策略。HTTP 不允许手动设置 Host、Cookie 等受限请求头，Cookie 使用单独开关。WebSocket 浏览器 API 无法添加任意握手头。开发网页预览仍受 CORS 约束，扩展使用声明的 HTTP(S) 主机权限。
- HTTP 响应最多读取 5 MB，截断时会明确提示；单文件最大 20 MB，单次请求附件总计最多 50 MB；JSON 文件最大 5 MB，备份最大 200 MB；WebSocket 保留最近 500 条日志，每条显示最多 100,000 字符；离开 WebSocket 工具即断开连接。
- JSON 按标准 JavaScript 数值精度解析，大整数应作为字符串保存。JSONPath 使用安全解释器，不能运行任意 JavaScript。
- 二维码是静态码，内容直接写入二维码；Logo 限 PNG / JPG / WebP、2 MB、4096 px，上传后自动启用 H 纠错。更改配置后需重新生成才可下载。长文本容量取决于纠错等级，过长会提示。

## 本地开发

需要 Node.js 22.13+ 和 pnpm 11.23.0。

```bash
pnpm install --frozen-lockfile
pnpm dev
pnpm check
pnpm zip
```

`pnpm dev` 提供网页预览，`/popup.html` 预览待办，`/index.html` 预览工作台；预览与扩展是不同来源，IndexedDB 数据相互独立。`pnpm build` 输出 `dist`。`pnpm zip` 构建后生成可安装目录与 ZIP，包内不包含测试数据、开发依赖或源码映射。

代码规范沿用参考项目：两空格、分号、单引号、SCSS；ESLint / Stylelint / Prettier 配置保持一致，公开类型和命名函数使用标准中文 JSDoc（用途、`@param`、`@returns`，按需 `@throws`）。`lint:conventions` 检查文档覆盖和原生交互标签，表单、按钮、文件选择等统一使用 Element Plus。

```text
src/components/  CodeMirror、JSON 树、参数列表、文件选择与 multipart 编辑器
src/tools/       17 个工具的分类面板和设置页
src/popup/       今日待办弹窗、任务行与独立样式
src/lib/         模型、IndexedDB、加密、编码、JSONPath、HTTP、cURL
src/workers/     可取消的密码学任务
src/background.ts  每日自动清理任务
public/          MV3 清单、本地图标、依赖许可
tests/           标准向量、互操作、存储事务和边界测试
scripts/         打包、图标、第三方许可与真实扩展验证
```

## 验证

```bash
pnpm check
pnpm exec playwright install chromium
pnpm exec playwright install-deps chromium
pnpm test:e2e
pnpm test:e2e:cleanup
pnpm test:e2e:popup
```

可通过 `CHROMIUM_PATH` 指定已安装的 Chromium，通过 `EXTENSION_PATH` 指定待测扩展目录。系统缺少动态库时，可安装 Playwright 对应系统依赖，或通过 `LD_LIBRARY_PATH` 指向已准备好的库目录。

单元测试包含 AES / SM4 与 Node/OpenSSL 对照、RSA 跨实现对照、SM2 两种顺序/篡改检测/随机源验证、摘要标准向量、Bcrypt、JWT、严格编码校验、JSONPath、multipart 实际序列化、binary 字节完整性、变量/cURL 边界、IndexedDB 升级与原子备份、附件引用和历史上限。

浏览器测试在临时配置中加载真实 MV3 扩展，使用本机 HTTP / WebSocket 测试服务；检查全部工具、CSP、草稿重载、二维码 PNG 的独立扫码解码、Logo/SVG、备份、设置、离线和移动布局。截图、报告与下载样本位于忽略版本控制的 `artifacts/`，不会打包到扩展。

HTTP 交互参考：<https://learning.postman.com/docs/sending-requests/create-requests/parameters/>。

功能参考：<https://33tool.com/sm4/>、<https://www.json.cn/jsononline/>、<https://cli.im/text>。实现为独立本地插件，不依赖这些网站的接口。

自动清理验收通过真实 chrome.alarms 事件触发后台维护，覆盖默认 30 天、自定义期限、关闭与重开、草稿/集合引用保护、标签页全部关闭后的清理。报告与设置截图位于 artifacts/auto-cleanup-report.json、artifacts/auto-cleanup-settings.png。后台使用 alarms 权限定时唤醒，数据仍仅保存在 IndexedDB。
