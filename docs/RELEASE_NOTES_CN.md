# G2.4RC5：控制中心改版、网页直刷、更新检测与双固件维护

基于上游公开 v3.18，选择性适配 NiceTimeJob/DS5DongleRE R3.28 的代码和设计，来源及 GPL 声明见 NOTICE。本版本不等于合入 sqlCRT v3.24 的全部修复。

- **修复 Windows 原生打包**：使用 Python `zipfile` 替代 Windows Runner 上可能因权限生成空包的 `tar.exe -a -c -f`，并在打包流程及单元测试中校验 ZIP 非空及可执行文件完整性。
- **网页端 Web Serial ISP 直刷**：新增内嵌 EFlash Loader 的浏览器串口烧录引擎（BL616/618 BootROM ISP 55AA 握手、Flash JEDEC 探测、4 KiB 扇区擦除、2 KiB 分块编程与 SHA-256 校验），支持直接拖入 GitHub 发布固件 ZIP 或 `.bin` 在网页完成单固件刷写。
- **在线版本检测与一键下载更新**：控制中心支持自动或手动检查 GitHub Releases 最新版本，按当前识别的板型与 FS/HS 速度模式智能推荐固件包，支持一键拉取进网页刷机页或直接下载控制中心/固件 ZIP。
- **双固件槽位管理与 4 MiB 整片备份/恢复**：补齐 `0xF2` 双固件槽位状态读取、A/B 槽下次启动切换、将固件包中 `fw_main.bin` 单独刷入指定槽位（`0x10000` / `0x190000`）或从零部署双固件，并支持 4 MiB 整片 Flash 镜像回读备份与恢复。
- **控制中心界面与体感设置体验精简重构**：参考 RKLAB `dstester` / `bl616/#config` / `webflasher` 的清爽卡片与留白风格重排六大页签；体感页引入场景预设（标准微瞄、守望先锋/Apex、战术射击、高灵敏度、纯右摇杆）与基础/进阶参数分层折叠，支持 X/Y 同步调节；按键映射与宏编辑页升级筛选药丸与紧凑双栏工作台。
- **延续 G2.4RC4 宏与稳定性修复**：保留 16 槽设备端宏（最多 640 步）、16 条组合键触发绑定、键鼠队列合并、Edge 12 项配置预取重试及手动静止校准保存恢复。

Windows x64、Mac Apple Silicon、Mac Intel 请选择对应 DS5-Control-Center 应用 ZIP，无需安装 Python；source.zip 供源码运行。固件请选择匹配板型的 FS／HS ZIP，包内附来源及哈希。

本版本为预发布。主机测试、模拟网页和编译检查不代替真机：Web Serial 烧录与双固件槽位操作前建议先执行“备份 4 MiB 镜像”并导出配置；操作说明见 docs/CONTROL_CENTER_CN.md 与 docs/DUAL_FIRMWARE_CN.md。
