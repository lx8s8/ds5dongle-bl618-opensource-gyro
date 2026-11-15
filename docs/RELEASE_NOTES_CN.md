# G2.4RC7：双固件引导与管理器 USB 修复、通用按住 R2 俯仰测试偏置

基于上游公开 v3.18，选择性适配 NiceTimeJob/DS5DongleRE R3.28 的代码和设计，来源及 GPL 声明见 NOTICE。本版本不等于合入 sqlCRT v3.24 的全部修复。

- **双固件引导与切换管理器修复（LCTech BL616 FS 实验版）**：
  - 修复 `boot/manager/main.c` 中 `image_ok()` 在写回式 D-Cache 下把栈上缓冲区与 SHA 上下文传给 `SEC_ENG` 硬件 DMA 导致的 SHA-256 校验恒失败问题（改为 `.noncacheable` 32 字节对齐缓冲），解决双固件刷入后开机无论单击切换还是超时自启都失败并直接跌入管理器的问题。
  - 在 `boot/manager/defconfig` 增加 `CONFIG_PMP_NOT_INIT=y` 并在 `boot()` 跳转前禁用 L1 D-Cache / I-Cache，避免 `boot/manager` 锁死 PMP 或带着脏缓存把控制权交给槽位应用。
  - 修复 `boot/manager/usb_manager.c`：将 `status`/`pending` 移入 `USB_NOCACHE_RAM_SECTION`、改用 Full-Speed `bcdUSB = 0x0110`、显式清除 `DEV_CTL` LPM 位（bit 25/26）、补充 63 字节 Dummy Input 报告（ID `0x71`）并注册 Interrupt IN 端点 `0x81`（同时保留 Feature ID `0x70`），解决 Windows `hidusb` / WebHID 找不到管理设备的问题。
- **控制中心双固件与上游自动下载完善**：
  - 本地代理 `/api/download`（Windows / macOS 原生启动器与 Python `launcher.py`）新增允许从受信任仓库拉取 `ds5-boot-manager-*.bin` 启动管理器镜像（并正确返回 `application/octet-stream`）。
  - 在“双固件切换与维护”的安装与分槽更新面板新增一键自动下载按钮：可直接自动获取并校验最新 LCTech 616 启动管理器 `.bin`、最新体感固件 ZIP 与上游原版最新 LCTech 616 发布包（`sqlCRT/ds5dongle-bl618-opensource`，支持包内 FS/HS 变体切换与“一键下载全套”），Release 列表亦支持将启动管理器直接填入双固件安装区；优化“连接启动管理器”未选中设备时的操作指引。
- **通用按住 R2 下压偏置（单机离线测试用）**：在启用陀螺仪映射且勾选“开火测试下压偏置”（`GYRO_FIRE_BIAS`）时，按下 R2 超过扳机阈值（或数字 R2 键）可叠加可调垂直下压角速度（`0–63.5 °/s`，步进 `0.5 °/s`，默认 `0` 关闭）与渐入时间（`0–3150 ms`，步进 `50 ms`），固件与网页均仅提供通用测试参数，不内置任何武器或游戏预设。
- **包含 G2.4RC6 全部特性**：保留重力融合 `Player Space` 玩家空间、`GYRO_AUTO_BIAS` 自动温漂学习、`GYRO_ADAPTIVE_SMOOTH` 自适应微瞄滤波、右摇杆视角校准向导、本地方案库/撤销/差异预览、手柄测试实时轮询率与 36 扇区摇杆圆度统计、诊断离线回放、Windows `.exe` 系统代理与浏览器回退下载、Web Serial ISP 烧录及 16 槽设备宏。

Windows x64、Mac Apple Silicon、Mac Intel 请选择对应 DS5-Control-Center 应用 ZIP，无需安装 Python；source.zip 供源码运行。固件请选择匹配板型的 FS／HS ZIP，包内附来源及哈希。

本版本为预发布。主机测试、模拟网页和编译检查不代替真机：Web Serial 烧录与双固件槽位操作前建议先执行“备份 4 MiB 镜像”并导出配置；操作说明见 docs/CONTROL_CENTER_CN.md 与 docs/DUAL_FIRMWARE_CN.md。
