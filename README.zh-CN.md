# GeoMirror

> 让浏览器画像与当前出口 IP 保持一致：地理位置、时区、语言、`Accept-Language` —— 全自动、覆盖每个普通网页。

GeoMirror 是一个 Chrome Manifest V3 扩展，适合使用代理、VPN、远程桌面、跨区出口节点的人。它解决的问题不是“换 IP”，而是“换了 IP 之后，浏览器仍然暴露出另一个地区的环境”。

[English](./README.md) · [隐私政策](./PRIVACY.md) · [技术说明](./docs/TECHNICAL.md)

---

## Motivation：只换 IP 远远不够

最近 Claude / Anthropic 的封号风波让很多人意识到一个现实问题：平台的风控如果机械地依赖地址、地区、登录环境等信号，就可能非常粗暴。很多用户反馈过，只是换了 IP、旅行、使用 VPN、或者浏览器环境和 IP 地区不一致，就可能触发账号限制甚至封禁。

Anthropic（Claude 的母公司）把这类粗糙的位置/地址启发式信号变成账号损失风险，这种做法当然令人愤怒。但愤怒解决不了实际问题。我们能做的是把自己的浏览器环境整理得更一致，减少无谓的风险信号。

最常见的问题是：多数人只换了 **IP 地址**，但没有同步更换浏览器暴露出来的其他信息。

- `navigator.geolocation` 仍然可能暴露真实物理位置。
- `Date.prototype.getTimezoneOffset()` 仍然暴露本机时区。
- `Intl.DateTimeFormat().resolvedOptions().timeZone` 仍然暴露系统时区。
- `navigator.language` / `navigator.languages` 仍然暴露本机语言。
- HTTP `Accept-Language` 请求头仍然暴露另一个语言环境。

这些信号一旦互相矛盾，就会形成非常典型的“代理/VPN/异常环境”画像。GeoMirror 的目标就是把这条链补齐。

## 使用前后有什么变化

### 使用前：只换 IP，浏览器画像仍然分裂

```mermaid
flowchart LR
  IP["出口 IP<br/>Tokyo, JP"]:::good
  GEO["navigator.geolocation<br/>Shanghai, CN"]:::bad
  TZ["Timezone<br/>Asia/Shanghai"]:::bad
  LANG["Language<br/>zh-CN"]:::bad
  AL["Accept-Language<br/>zh-CN,zh"]:::bad
  SITE["网站 / 风控系统<br/>看到互相矛盾的信号"]:::warn

  IP --> SITE
  GEO --> SITE
  TZ --> SITE
  LANG --> SITE
  AL --> SITE

  classDef good fill:#e6ffed,stroke:#2ea44f,color:#111;
  classDef bad fill:#ffeef0,stroke:#d73a49,color:#111;
  classDef warn fill:#fff5b1,stroke:#9a6700,color:#111;
```

### 使用后：浏览器画像跟随出口 IP

```mermaid
flowchart LR
  IP["出口 IP<br/>Tokyo, JP"]:::good
  GM["GeoMirror<br/>本地计算一致画像"]:::core
  GEO["navigator.geolocation<br/>Tokyo 附近住宅坐标"]:::good
  TZ["Timezone<br/>Asia/Tokyo"]:::good
  LANG["Language<br/>ja-JP / ja"]:::good
  AL["Accept-Language<br/>ja-JP,ja;q=0.9,..."]:::good
  SITE["网站 / 风控系统<br/>看到更一致的地区画像"]:::good

  IP --> GM
  GM --> GEO --> SITE
  GM --> TZ --> SITE
  GM --> LANG --> SITE
  GM --> AL --> SITE

  classDef good fill:#e6ffed,stroke:#2ea44f,color:#111;
  classDef core fill:#ddf4ff,stroke:#0969da,color:#111;
```

### 覆盖了哪些信号

| 信号 | 使用前常见状态 | 使用 GeoMirror 后 |
| --- | --- | --- |
| 出口 IP | 代理/VPN 节点地区 | 不改变 IP，只读取当前出口 IP |
| HTML5 定位 | 真实设备位置或系统位置 | 出口 IP 附近住宅感坐标 |
| 定位权限 | 可能显示未授权/真实状态 | 对 geolocation 查询返回 `granted` |
| Date 时区 offset | 本机时区 | 出口 IP 对应 IANA 时区，含 DST |
| Intl 时区 | 本机系统时区 | 出口 IP 对应时区 |
| navigator 语言 | 本机语言 | 根据国家码 + 时区推断 |
| Intl 默认 locale | 本机 locale | 与推断语言一致 |
| Accept-Language | 本机请求头语言 | 与推断语言一致 |

## 它具体做了什么

GeoMirror 会检测当前可见的 **出口 IP**，根据这个 IP 派生出一个合理的浏览器画像，然后在 Chrome 本地应用：

1. 伪装 HTML5 地理位置：`navigator.geolocation`
2. 伪装地理位置权限：`navigator.permissions.query({ name: "geolocation" })`
3. 伪装 JS 时区 offset：`Date.prototype.getTimezoneOffset()`
4. 伪装 Intl 默认时区：`Intl.DateTimeFormat().resolvedOptions().timeZone`
5. 伪装浏览器语言：`navigator.language` / `navigator.languages`
6. 伪装 Intl 默认 locale：`Intl.DateTimeFormat` / `Intl.NumberFormat` / `Intl.Collator`
7. 伪装 HTTP 语言请求头：`Accept-Language`

目标很简单：如果你的 IP 看起来在东京，浏览器就不应该还像上海、洛杉矶或柏林。

## 隐私模型

GeoMirror 是 local-first、可审计的：

- 不需要账号。
- 没有 telemetry。
- 没有 analytics。
- 不读取网页正文内容。
- 没有远程配置。
- 设置和计算结果只保存在 `chrome.storage.local`。

需要说清楚的一点：GeoMirror 不是“零联网”扩展。要做到一键匹配当前出口 IP，它必须通过 Chrome 的网络栈请求 manifest 中明确列出的公共 IP/地图接口。这些请求只用于：

- 检测出口 IP 的位置；
- 查询出口 IP 附近住宅道路；
- 为弹窗显示做反地理编码。

它不会上传页面内容或浏览历史。完整数据流见 [隐私政策](./PRIVACY.md) 和 [技术说明](./docs/TECHNICAL.md)。

## 工作原理

```mermaid
flowchart TD
  A["代理 / VPN / 远程出口"] --> B["网站看到的出口 IP"]
  B --> C["background.js<br/>检测 IP 地理位置 + 时区"]
  C --> D["lib/geo.js<br/>选择附近住宅道路坐标"]
  C --> E["lib/locale.js<br/>国家码 + 时区推断语言"]
  D --> F["chrome.storage.local<br/>保存 override"]
  E --> F
  F --> G["content-bridge.js<br/>隔离世界读取 storage"]
  G --> H["DOM data-geomirror<br/>传递 JSON payload"]
  H --> I["content-inject.js<br/>MAIN world @ document_start"]
  I --> J["页面看到一致的<br/>定位 / 时区 / 语言 / 请求头"]
```

技术链路：

1. `background.js` 通过多个 provider 检测当前出口 IP。
2. `lib/providers.js` 统一解析 IP、国家码、经纬度、ISP、IANA 时区等字段。
3. `lib/geo.js` 使用 OpenStreetMap / Overpass 在附近选择住宅感坐标。
4. `lib/locale.js` 根据国家码 + 时区推断 locale bundle。
5. `background.js` 把 override 存入 `chrome.storage.local`，并安装动态 `Accept-Language` 规则。
6. `content-bridge.js` 在 isolated world 中读取 extension storage，把 payload 写入 DOM 属性。
7. `content-inject.js` 在 MAIN world 的 `document_start` 阶段读取 payload，并覆盖页面可见 API。

## 安装

### 方式 A：加载未打包扩展

1. 下载或克隆本仓库。
2. 打开 `chrome://extensions`。
3. 开启右上角 **开发者模式**。
4. 点击 **加载已解压的扩展程序**。
5. 选择 `geomirror` 文件夹。
6. 固定 GeoMirror，打开弹窗，点击 **Refresh**。

### 方式 B：Chrome 应用商店

计划后续上架。在此之前请使用未打包扩展。

## 验证效果

打开检测页面，检查这些值：

```js
navigator.language
navigator.languages
Intl.DateTimeFormat().resolvedOptions()
new Date().getTimezoneOffset()
navigator.geolocation.getCurrentPosition(console.log, console.error)
```

再打开 DevTools → Network → 请求头，确认 `Accept-Language` 与伪装后的语言一致。

可用检测页面：

- https://browserleaks.com/geo
- https://browserleaks.com/javascript
- https://browserleaks.com/headers

## 设置项

- **Location spoof**：启用/关闭地理位置伪装。
- **Timezone spoof**：启用/关闭 `Date` 和 `Intl.DateTimeFormat` 时区伪装。
- **Language spoof**：启用/关闭 `navigator.language(s)`、Intl locale、`Accept-Language`。
- **Accuracy (m)**：上报给页面的定位精度，默认 30 米。
- **Refresh (min)**：重新检测出口 IP 的间隔。
- **ipinfo.io token（可选）**：有 token 时可提升 fallback 稳定性。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `storage` | 本地保存设置与计算出的 override。 |
| `alarms` | 定时刷新出口 IP。 |
| `declarativeNetRequest` | 设置 outgoing `Accept-Language` 请求头，不读取页面流量。 |
| `<all_urls>` 内容脚本 | 在普通网页脚本运行前 patch 浏览器 API。 |
| `host_permissions` | 请求 manifest 中列出的 IP / 地理位置 / Overpass / 反地理编码 provider。 |

## 如果你不想安装这个扩展

可以把下面这段提示词复制给自己的 Agent，让它为你生成一个本地版本：

```text
请构建一个 Chrome Manifest V3 扩展，用于让浏览器可见的地区画像与当前出口 IP 保持一致。

要求：
1. 通过 Chrome 网络栈检测浏览器当前可见出口 IP，使用多个 IP geolocation provider 做 fallback。
2. 保留 provider 返回的国家码、城市/地区/国家、经纬度、ISP、IANA timezone。
3. 不要直接使用 IP 中心点；优先用 OpenStreetMap Overpass 查询附近 highway=residential 住宅道路，并选择一个合理坐标；失败时使用安全 jitter fallback。
4. 根据国家码 + timezone 推断 locale bundle，包括 navigator.language、navigator.languages、Accept-Language。
5. 所有设置和计算出的 override 只存 chrome.storage.local。不要 telemetry，不要 analytics，不要账号系统，不要远程配置，不要收集网页内容。
6. 使用两个 content script：
   - isolated-world bridge：读取 chrome.storage，把 JSON payload 发布到 DOM；
   - MAIN-world injector：document_start 执行，patch 页面可见 API。
7. patch 以下内容：
   - navigator.geolocation.getCurrentPosition / watchPosition / clearWatch
   - navigator.permissions.query 的 geolocation 结果
   - Date.prototype.getTimezoneOffset，要求使用调用者 Date 实例，并支持 DST-aware IANA timezone
   - Intl.DateTimeFormat 默认 timezone 和 resolvedOptions().timeZone
   - navigator.language 和 navigator.languages
   - Intl.DateTimeFormat / Intl.NumberFormat / Intl.Collator 默认 locale
8. 使用 chrome.declarativeNetRequest 在 language spoof 开启时设置 outgoing Accept-Language header。
9. 添加 popup，提供 location/timezone/language 开关、accuracy、refresh interval、可选 ipinfo token、手动刷新。
10. 添加测试，覆盖 timezone DST offset、locale 推断、provider parsing、manifest 注入顺序。
11. 写清楚隐私模型：无 telemetry，不读取页面内容，只本地存储；外部请求仅用于出口 IP / 地理位置匹配。
```

## 局限

- GeoMirror 提升的是信号一致性，不是完整反指纹系统。
- IP 地理位置本身是近似值。
- 语言推断是启发式的，因为 IP provider 不知道用户真实语言。
- Chrome 扩展无法注入 `chrome://`、Chrome 商店等特权页面。
- 平台可能使用浏览器 JS 和请求头以外的其他风控信号。

## 开发

项目结构：

```text
geomirror/
├── manifest.json
├── background.js
├── content-bridge.js
├── content-inject.js
├── docs/
│   └── TECHNICAL.md
├── lib/
│   ├── geo.js
│   ├── locale.js
│   ├── providers.js
│   └── timezone.js
├── popup.html
├── popup.css
├── popup.js
├── test/
│   └── run-tests.js
└── icons/
```

检查命令：

```bash
node test/run-tests.js
node --check background.js
node --check content-inject.js
node --check content-bridge.js
node --check lib/providers.js
node --check lib/locale.js
node --check lib/timezone.js
node --check popup.js
```

改动后，在 `chrome://extensions` 点击扩展卡片上的刷新图标重新加载。

## 许可证

[MIT](./LICENSE)
