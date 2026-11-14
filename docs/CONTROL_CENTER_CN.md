# DS5 控制中心：本地运行与桌面打包

更新：2026-11-14。控制台是本地静态网页，通过 WebHID 直连接收器。无需账号、数据库或远端服务器；连接硬件需要桌面 Chrome / Edge，Safari / Firefox 不支持此接入方式。

## 打开方式

- 普通用户：下载对应系统的 `DS5-Control-Center-windows-amd64.zip`、`DS5-Control-Center-macos-arm64.zip` 或 `DS5-Control-Center-macos-x86_64.zip`，解压后双击 `.exe`／`.app`。这是原生绿色程序，网页嵌入程序，不需要安装 Python、Rust、Node 或额外运行库；仍需已安装桌面 Chrome／Edge。底部“退出本地工具”关闭服务。
- 源码用户：`DS5-Control-Center-source.zip` 包含网页与源码启动器。已有 Python 3 时，macOS 双击 `启动控制中心.command`，Windows 双击 `启动控制中心.cmd`；也可执行 `python3 desktop/launcher.py`。旧版的 `portable.zip` 指这个源码包，现已改名以免混淆。
- 网页可独立使用：在 `web/` 目录运行 `python3 -m http.server 8765 --bind 127.0.0.1`，访问 `http://127.0.0.1:8765/`。不要直接双击 `index.html`，模块加载与硬件权限需要合适的来源。

本地启动器只监听 `127.0.0.1`，仅公开随包网页；浏览器向 GitHub 查询更新，不上传配置、输入报告或配对信息。同一接收器同时保持一个已连接的配置客户端；同页内的 Feature 请求统一排队。无网络时仍可设置接收器、导入导出配置与测试手柄，Release 检查需联网。若默认端口被占用，启动器会选空闲端口，新的来源需要重新授权 HID。

测试页为双栏布局，左侧手柄总览与扳机行程常驻，右侧六个标签切换测试内容；不会通过锚点跳转整页。

## 功能与保存范围

| 页面 | 能力 |
| --- | --- |
| 手柄测试 | 手柄 SVG 按键图、摇杆位置与轨迹、扳机百分比、双点触摸、陀螺仪和加速度、重力方向预览、浏览器输入频率、校准、真实鼠标轨迹及诊断导出 |
| 接收器配置 | 当前开源固件已有的设备身份、频率、唤醒/隐身、空闲断连、灯光、音频/触觉、触摸板设置；RAM 应用、保存、保存重启、JSON 导入导出 |
| 陀螺仪映射 | 四套配置、任意手柄按键或组合、按住/切换/按住暂停/长按、Edge Fn 档绑定、快捷动作；鼠标与右杆速度、独立 XY、反转、ADS、加速、平滑、死区和幂曲线；响应图及曲线 CSV |
| 按键映射 | 接收器原有两档 × 31 项，手柄/键盘/鼠标目标，组合修饰键、双键输出、屏蔽，导入导出和逐档保存 |
| 固件与更新 | 自动查询公开 GitHub Releases、板型/FS/HS 筛选、更新说明、附件下载及 GitHub 提供的摘要；本项目与上游原版分开选择 |

体感“应用”只写当前编辑档和全局，体感“保存到设备”提交全部四档草稿与全局。接收器和普通映射有独立的保存按钮与 JSON 文件，互不静默覆盖。手柄图点击普通按键可定位映射行，Fn/背键可定位体感启用按键。

四种启用模式中，“按一下开启 / 再按关闭”是按键边沿切换；“按住启用”仅在所选条件成立时启用。长按延时可叠加在按住模式。普通按键支持任一个或全部组合，扳机与按钮条件是 AND。可绑定的“任意按键”指固件可识别的手柄输入，不能让未运行的电脑键盘状态凭空进入接收器。

曲线是现有固件算法的单轴稳态预览：鼠标显示 counts/s，右杆显示归一化输出；分别绘制 XY 与 ADS。二维死区、平滑的时间响应及游戏内转向还受实际输入和游戏设置影响。当前曲线使用幂指数等固件参数，不提供任意自由控制点曲线、Player Space、Flick Stick 或超出当前协议的路由。

G2.3 修正右杆输出：游戏死区补偿按二维向量幅度处理，避免微小的另一轴噪声也被单独抬到最低输出；微动死区采用起动／回落滞回，进入静止区立即回中；大幅转动减少滤波，明显反向清除旧方向历史。零点校准仍需手柄静止完成，参数不能替代校准。Yaw／Roll 是不同的物理转动轴，反转只改变方向，不改变转动轴。

震动默认测试 1 秒；停止按钮、离开测试页、页面转后台或主动断开时解除震动/扳机测试。灯光和音频测试会真的修改手柄当下状态，持久设置请在接收器配置页操作。浏览器/系统崩溃无法保证最后一条解除指令送达，此时拔插接收器恢复。

## 两条固件来源

本项目仍基于上游公开 v3.18 源码并增加 G2 体感功能。2026-11-14 核查：上游 `v3.24`、`v3.22`、`v3.21` 等标签都指向 `f7e36e1fb13151a7e9d376fe2f74f29cca104185`，公开主分支对应 v3.18。v3.24 的发布附件包含后续功能，不能把标签下旧源码当作这些功能的实现，也不能把本项目版本改名为 v3.24 来表示已同步。

来源：[上游 Release](https://github.com/sqlCRT/ds5dongle-bl618-opensource/releases/tag/v3.24)、[对应公开提交](https://github.com/sqlCRT/ds5dongle-bl618-opensource/commit/f7e36e1fb13151a7e9d376fe2f74f29cca104185)、[公开标签 API](https://api.github.com/repos/sqlCRT/ds5dongle-bl618-opensource/tags)。

作者已在 [Issue #10 的回复](https://github.com/sqlCRT/ds5dongle-bl618-opensource/issues/10#issuecomment-5742496052) 说明：后续二进制文件继续发布，源码因正式接收器产品开发而暂缓更新。2026-11-14 核查其公开仓库、分支、项目说明及相关 Fork，未找到作者迁移后的 v3.24 公开源码。`chunqian/ds5dongle-bl618-opensource` 和 `infinitytom/ds5dongle-switch-pro` 有各自新增代码，均是基于公开基线的独立开发，不能直接视作上游 v3.24。

上游原版没有本项目新增的体感报告，刷回后当前 G2 配置工具可能无法连接。更新页默认本项目仓库并包含公开测试版；没有公开 Release 时会明确显示暂无版本，并给出 Actions。草稿不可由匿名 API 读取；不会假造最新版本。上游未标 FS/HS 的包不推断 USB 速度，以附件说明为准。页面提供下载，暂不执行网页刷写或 OTA。

## 桌面构建

打包源文件（仍需 Python）：

```sh
python3 scripts/package_control_center.py
```

构建原生应用，在对应系统上运行（仅开发机需要 Python 3、Rustup 和系统编译工具，成品不需要）：

```sh
rustup toolchain install 1.100.0 --profile minimal
python3 scripts/package_control_center.py --native
python3 tests/test_native_launcher.py
```

Windows 使用 `python`，开发机需 Visual Studio C++ Build Tools。Rust 工具链版本固定在 `desktop/native/rust-toolchain.toml`，没有第三方 Cargo 依赖。网页编译进二进制，Windows 静态链接 CRT；无需随包携带 Python 或浏览器。打包会附带项目及 Rust 标准库许可。产物在 `dist/control-center/`。

macOS 应用尚未做 Apple Developer ID 签名和公证；Windows 应用尚未做 Authenticode 签名。跨系统产物由 `Control center` Actions 在 Windows、macOS Apple Silicon 和 Intel 运行器分别构建，并逐个平台实际启动原生服务、校验内嵌网页、来源限制及退出。ZIP 名称包含架构。

## Tauri 是否可行

可以，但需要 Rust 原生 HID 接入，不能只给此网页套一层窗口。Tauri 的 Windows 使用 WebView2，macOS 使用 WKWebView；后者不提供本工具依赖的 WebHID。完整方案应把枚举、足长 Feature、命令排队、输入流、关闭恢复等移到受限的原生 `hidapi` 桥接，前端复用当前协议/表单/可视化，并做两端真机验收。串口刷写还需独立实现 BootROM 协议和恢复流程。

本轮交付选择本地服务 + 已安装 Chrome/Edge，直接复用已验证的 WebHID 链路；未把空 Tauri 壳宣称为完整硬件客户端。

参考：[Tauri WebView](https://v2.tauri.app/reference/webview-versions/)、[WebHID 支持范围](https://developer.mozilla.org/en-US/docs/Web/API/HID)、[GitHub Release API](https://docs.github.com/en/rest/releases/releases)。

界面按 RKLAB 的功能分区和手柄测试交互作参考，自行绘制 SVG、编写页面及协议代码；未引入其品牌、统计脚本、商店内容或私有升级服务。
