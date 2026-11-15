# DS5 蓝牙接收器与体感配置工具

基于 BL616／BL618，将 DualSense 或 DualSense Edge 手柄通过蓝牙连接到电脑，USB 端保留对应的索尼手柄身份。配置、体感映射和宏由接收器执行，保存后无需常驻配置软件。

## 已实现功能

- **手柄透传**：摇杆、按键、扳机、触摸板、体感和电量输入，以及震动、自适应扳机、灯光和音频输出。
- **陀螺仪映射**：四套独立配置，可输出鼠标或右摇杆；可设置转动轴、灵敏度、反转、曲线、死区、平滑和瞄准倍率。支持按住启用、按一下开关、组合键和 Edge Fn 切档。
- **按键映射**：两套映射配置，支持手柄、键盘、鼠标输出与按键屏蔽。
- **设备宏**：16 个槽位，每宏最多 640 步，支持手柄键、键盘、鼠标按钮及滚轮；可录制手柄按键、编辑步骤、导入导出，并设置单次、重复、按住循环或按一下开关。支持组合键、长按、双击、三击及分档绑定。
- **中文配置与测试**：手柄可视化、摇杆与扳机、震动、触控体感、灯光、音频和输入频率测试；提供曲线、静止校准和诊断导出。
- **配置保存**：接收器设置、四档体感、映射和宏可保存到设备；静止校准仅对标识及工厂标定匹配的手柄恢复。
- **更新下载**：查询本项目及上游的 GitHub 发布版本，按板型和 USB 速度筛选、下载附件；目前不提供网页直接刷机。
- **连接修复**：修复蓝牙断连时连接对象重复释放、Edge 配置预取过早就绪，以及键鼠输出排队和 USB 缓冲复用问题。

## 下载与使用

1. 从 [发布页面](https://github.com/lx8s8/ds5dongle-bl618-opensource-gyro/releases) 下载对应系统的控制中心，以及匹配开发板的固件包。LCTech BL616 通常选择 `lctech616-fs`。
2. 按固件包内说明烧录。已有本项目固件的接收器更新时，按说明只更新主程序。
3. 解压并打开控制中心，使用桌面 Chrome 或 Edge 连接接收器；手柄首次配对时，同时长按 **PS + 创建键**，直到灯条闪烁。
4. 设置需要的体感、映射或宏并保存到设备。四档体感出厂默认关闭，日常游戏无需一直打开网页。

Windows、苹果芯片 Mac 和英特尔 Mac 均提供独立应用包，无需安装 Python，也不需要服务器。源码启动方式见 [控制中心说明](docs/CONTROL_CENTER_CN.md)。

## 支持的开发板

| 开发板 | 芯片 | USB 接入 |
| --- | --- | --- |
| LCTech BL616（默认） | BL616 | 原生 Type-C |
| Ai-M61-32S-Kit | BL618 | GPIO37 接 D−、GPIO38 接 D+，并共地；板载 Type-C 为串口 |
| Sipeed M0S Dock | BL616 | 原生 Type-C |

三种开发板均提供全速（FS）和高速（HS）构建，固件包需与板型对应。

## 当前状态

当前发布为 **G2.4RC4 预发布版**。主机测试、模拟网页和跨平台构建已通过；新增宏、连接修复及 macOS 键鼠兼容性仍需真机和游戏验收。

双固件切换目前是实验原型，尚未完成真机启动验收，普通固件包不会自动安装双固件管理器。

本项目基于上游公开 v3.18 源码。

## 详细文档

- [控制中心、宏与本地运行](docs/CONTROL_CENTER_CN.md)
- [体感配置与快捷键](docs/GYRO_CN.md)
- [本地编译](docs/LOCAL_BUILD_CN.md) · [自动构建与发布](docs/CI_CN.md)
- [版本说明](docs/RELEASE_NOTES_CN.md) · [真机测试记录](docs/HARDWARE_RESULT_2026-11-14_CN.md)
- [双固件实验方案](docs/DUAL_FIRMWARE_CN.md)

## 来源与许可

基于 [sqlCRT/ds5dongle-bl618-opensource](https://github.com/sqlCRT/ds5dongle-bl618-opensource) 开发，原项目移植自 [awalol/DS5Dongle](https://github.com/awalol/DS5Dongle)，部分模块参考并适配 [NiceTimeJob/DS5DongleRE](https://github.com/NiceTimeJob/DS5DongleRE)。代码采用 [GPL-3.0 许可证](LICENSE)，来源说明见 [NOTICE](NOTICE)。

本项目非索尼官方项目；DualSense、DualSense Edge 和 PlayStation 为其各自权利人的商标。
