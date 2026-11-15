# G2.4RC9：双固件管理与恢复改进

本版本为 RC 预发布。双固件启动管理器暂用 pid.codes 的 `1209:0001` 私下测试身份，不具有全球唯一性，仅用于私人测试，不能随设备销售或分发。已提交正式 PID 申请，获准后将更新管理器和控制中心。

- 修复启动管理器固件校验期间 USB 设备消失的问题，并调整启动按键窗口和应用跳转流程。
- 新增无安装前原始备份时，使用完整固件包清除用户数据并恢复单固件的入口；保留接收器 factory 分区，配对和设置需要重新配置。
- 调整浏览器串口读取分块和节奏，并改善管理器连接与切换的状态提示。
- 在一台 LCTech 616 上使用 macOS Chrome 完成网页安装、体感／上游双向切换、软件进入管理器、备份下载及清除数据恢复验证。Windows、其他浏览器和硬件、自动下载、原版配置软件以及断电恢复尚未完成本次真机验收。
- 安装与恢复前请保存整片 4 MiB 备份；其中包含配对和设备数据，请勿公开分享。

## G2.4RC8：控制中心一键自升级、手柄总览按键文字居中修复

基于上游公开 v3.18，选择性适配 NiceTimeJob/DS5DongleRE R3.28 的代码和设计，来源及 GPL 声明见 NOTICE。本版本不等于合入 sqlCRT v3.24 的全部修复。

- **DS5 控制中心一键自升级（macOS / Windows / 源码版）**：
  - 本地服务 `/api/local` 现暴露控制中心版本（如 `v3.18-g2.4-rc8`）、平台压缩包名称与可写状态；“固件与更新”页新增“DS5 控制中心客户端”检测卡片，自动比对匹配平台的最新 Release。
  - 新增受相同 Origin + Session Token + GitHub SHA256 双重校验保护的 `/api/self-update` 接口：macOS `.app` 原生版通过 `ditto` 校验解包并原子替换重启，Windows `.exe` 通过安全卸载等待脚本替换目录并重启，解压版源码通过安全 ZIP 解包（防符号链接与路径穿越）更新并重启。
- **手柄测试总览 SVG 按键文字居中修复**：为 `#controllerVisual svg text` 补充 `text-anchor: middle` 与 `dominant-baseline: central` 并将各按键 `<text>` 坐标对齐至几何中心，解决图标内文字整体偏右的问题。
- **包含 G2.4RC7 全部修复**：含 LCTech BL616 双固件启动管理器 D-Cache/PMP 移交与 USB/WebHID `0x70`/`0x71`+LPM 修复、双固件安装/分槽一键自动下载（启动管理器 `.bin` / 体感 / 上游原版 `sqlCRT`）、通用按住 R2 俯仰测试偏置及此前全部特性。

Windows x64、Mac Apple Silicon、Mac Intel 请选择对应 DS5-Control-Center 应用 ZIP，无需安装 Python；source.zip 供源码运行。固件请选择匹配板型的 FS／HS ZIP，包内附来源及哈希。

本版本为预发布。主机测试、模拟网页和编译检查不代替真机：Web Serial 烧录与双固件槽位操作前建议先执行“备份 4 MiB 镜像”并导出配置；操作说明见 docs/CONTROL_CENTER_CN.md 与 docs/DUAL_FIRMWARE_CN.md。
