# G2.1 体感固件与 DS5 控制中心

本版本基于上游公开 v3.18 源码，增加 G2.1 陀螺仪功能与本地控制中心。它不包含上游 v3.24 发布附件中的全部后续功能。

## 新增与整合

- 测试页采用手柄总览＋固定六标签布局：摇杆测试、震动扳机、触控体感、灯光音频、轮询率、其他；切换时保留布局与参数，解除震动／扳机测试。
- 手柄可视化测试：按键、摇杆轨迹、扳机、触摸板、体感、震动、灯光和自适应扳机测试。
- 完整接收器设置、普通按键映射、配置导入导出。
- 四套体感配置：鼠标或右摇杆输出，可识别手柄按键与组合、按住启用、长按、按一下开启／再按关闭、Fn 档位绑定。
- 独立 XY 速度、反转、ADS、加速、平滑、死区、幂曲线预览与 CSV 导出。
- GitHub Releases 检查与下载；更新页默认包含公开测试版。
- Windows 和 macOS 本地工具，无需部署服务器或安装 Python，需已安装桌面 Chrome／Edge。

## 下载选择

| 附件 | 用途 |
| --- | --- |
| `DS5-Control-Center-windows-amd64.zip` | Windows x64，解压后运行其中的 `.exe`，保留同目录所有文件 |
| `DS5-Control-Center-macos-arm64.zip` | Apple Silicon Mac，解压后运行 `.app` |
| `DS5-Control-Center-macos-x86_64.zip` | Intel Mac，解压后运行 `.app` |
| `DS5-Control-Center-portable.zip` | 网页与启动器源文件，需 Python 3 |
| `ds5dongle-<板型>-<fs/hs>-<提交号>.zip` | 匹配板型和 USB 速度的固件、刷机文件、网页、说明和构建来源 |
| `SHA256SUMS` | 全部附件 ZIP 的 SHA256 校验值；各固件包内另有文件校验表 |

固件提供 LCTech BL616、Ai-M61 和 Sipeed M0S Dock 三种板型，各有 FS／HS 两个版本。默认选择与自己硬件对应的 FS 包。Release 固件使用标准 USB 身份；Mac HID 诊断身份需要按仓库说明单独构建。

## 验证范围与使用说明

GitHub Actions 在发布前检查主机逻辑、协议、描述符和打包，并编译六组固件及三个桌面包。之前在 LCTech FS 诊断固件与 DualSense Edge 上已验收 L2 体感启停、方向、四档切换、右杆报告、保存去重与断电保留；本次全部构建组合尚未逐一完成硬件验收，新增网页能力也仍需实际使用确认。

桌面工具尚未做 Apple Developer ID 签名／公证或 Windows Authenticode 签名。控制中心的本地连接、配置与测试无需外网，查询 Releases 需联网。不要直接双击网页 `index.html`。

更新页提供附件下载，当前没有网页刷写或 OTA。刷写前导出配置并核对板型，依照包内说明操作；体感默认关闭。

完整说明见仓库 `docs/CONTROL_CENTER_CN.md`、`docs/CI_CN.md` 和 `docs/HARDWARE_RESULT_2026-11-14_CN.md`。
