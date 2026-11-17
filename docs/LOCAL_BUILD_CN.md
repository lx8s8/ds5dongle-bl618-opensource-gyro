# macOS 本地编译

Apple Silicon Mac 可以直接编译完整固件，不需要容器。2026-11-14 已在本机实际完成 LCTech616 / FS 及私下 HID 诊断固件编译。信海 BL616 此次沿用此前正常使用、且已验证可运行的 `lctech616 / fs` 配置。

## 首次准备

需要 Xcode Command Line Tools、Git、Python 3。安装只写入仓库同级的 `.build-deps/` 和 `bouffalo_sdk/`，不改 shell 配置，不依赖 Homebrew：

```sh
bash scripts/setup_macos.sh
```

脚本校验下载归档的 SHA256，准备 GNU Make 4.4.1、CMake 3.31.10、官方 XuanTie v2.10.2 macOS ARM64 工具链，以及依赖文件中固定提交的 DS5 SDK。已有 SDK 提交不匹配时停止，避免覆盖本地修改。网络需要代理时，在执行前设置自己的 `HTTPS_PROXY`、`HTTP_PROXY`。

`DS5_BUILD_DEPS` 可以指定共用工具目录，`BL_SDK_BASE` 可以指定 SDK。独立工作树可用这两个变量复用已安装环境。

SDK 的固件后处理工具为 x86_64 程序，这台 Mac 已能运行；其他 Apple Silicon Mac 需要 Rosetta。工具链和依赖不进入 Git。

## 日常使用

在项目目录执行：

```sh
bash scripts/build_local.sh build     # 默认 LCTech616 / HS，增量编译
bash scripts/build_local.sh package   # 先增量编译，再生成 dist/ 刷机 ZIP
bash scripts/build_local.sh rebuild   # 清理后完整编译
bash scripts/build_local.sh check     # 主机检查；另需 PATH 中可用的 Node.js
```

`BOARD_TYPE=aim61`、`BOARD_TYPE=m0sdock` 和 `USB_SPEED=fs` 可切换构建目标；`BUILD_JOBS` 控制并行度。切换板型、USB 速度、SDK、编译器或构建配置时重新配置构建。普通 C 源码和头文件修改通过 CMake 依赖关系增量重编，不使用 `strip` 清除中间文件。

主固件位于 `firmware/lctech616/ds5dongle-lctech616.bin`。完整刷机包位于 `dist/`，包含网页、文档、分区、Boot2 和校验和。未提交的源码构建会在 ZIP 名称中加 `-dirty`，并在 `build-info.json` 标明；编译产生的便利刷机配置不计入源码修改。包内记录实际编译器对应的工具链归档，未知自定义编译器的归档字段留空。

ELF 和已有镜像的摘要不变时复用后处理结果；需要重新生成时，先从 ELF 导出原始 BIN，再执行 SDK 后处理，防止重复追加调试数据。构建失败会清除增量状态，下次重新配置。

本机实测（包含必要的固件后处理，不含首次下载依赖）：

| 操作 | 耗时 | 结果 |
| --- | --- | --- |
| 完整构建 | 约 25 秒 | 314 个 C 目标文件 |
| 修改单个 C 源文件后重编 | 约 16 秒 | 只重编 1 个 C 目标文件，再链接和后处理 |
| 无改动重复构建 | 约 0.5 秒 | 不编译、不重复后处理，固件 SHA256 一致 |
| 已有 BIN 被意外改动 | 约 11 秒 | 从 ELF 重建，恢复到原固件 SHA256 |

主机 15 组 C 逻辑测试、ASan/UBSan、FS/HS 描述符、网页协议和 12 项打包测试通过。实际切换到 HS、再切回 FS 均自动清理并成功构建，最终保留 FS 产物。耗时是本次机器的测量值，其他机器和修改范围会不同。

## 与 GitHub 构建的关系

GitHub 继续使用固定的 Linux XuanTie v2.6.1。本地使用官方提供的 macOS v2.10.2，两者共享相同 SDK 提交，编译器版本不同，因此不能要求二进制一致。本机编译成功表示编译与打包通过，本机工具链产物仍需实际刷写验证蓝牙、鼠标和音频。

本地编译不会自动烧录。真机调试仍先备份 Flash，再只更新 `0x10000` 的主程序并回读校验，保留板上分区、配对信息和配置。本地 G2.1T 诊断身份产物已在当前信海 BL616 / Edge / FS / macOS 验证启动、蓝牙输入、静止校准、鼠标基本输出及 Fn 四档绑定，见 [真机追加记录](HARDWARE_RESULT_2026-11-14_CN.md#g21t-本地构建验收)。正式 USB 身份的本地产物尚未刷写，音频和触觉也不包含在这次诊断版验收中。
