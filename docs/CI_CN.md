# GitHub 自动编译与打包

Git 负责保存源码，GitHub Actions 在云端编译。本项目配置位于 [firmware.yml](../.github/workflows/firmware.yml)，不需要把本地 SDK、工具链或固件二进制提交进仓库，也无需额外设置 Secret。

2026-11-14（北京时间），[运行 43458084369](https://github.com/lx8s8/ds5dongle-bl618-opensource-gyro/actions/runs/43458084369) 已实际通过主机检查与全部六个版本的编译、打包，生成六个固件 Artifact 和六个调试 Artifact。默认 LCTech FS 包已下载核对官方 Artifact SHA256、包内校验和、构建来源及刷机文件。真实硬件尚未验收；后续功能建议见 [优化清单](ROADMAP_CN.md)。

## 触发与下载

推送任意分支或标签、提交 Pull Request，都会启动 `Firmware` 工作流。工作流合并到默认分支后，也可在 GitHub **Actions → Firmware → Run workflow** 中选择分支并手动运行。仓库若禁用了 Actions，需要先在仓库设置中启用。

主机检查通过后，并行构建六个版本：

| 板型 | FS（默认兼容版本） | HS（高速版本） |
| --- | --- | --- |
| LCTech BL616 | `firmware-lctech616-fs` | `firmware-lctech616-hs` |
| Ai-M61-32S-Kit | `firmware-aim61-fs` | `firmware-aim61-hs` |
| Sipeed M0S Dock | `firmware-m0sdock-fs` | `firmware-m0sdock-hs` |

进入成功运行页面底部的 **Artifacts**，登录 GitHub 后下载对应包。GitHub 下载包外面有一层 Artifact ZIP；解压后，再解压里面带源码提交号的刷机 ZIP。构建包保留 30 天；`debug-*` 是编译日志、ELF、MAP，保留 14 天，供定位问题。

每个刷机包只包含一种板型和一种 USB 速度：

- `ds5dongle-*.bin`：主固件，HS 版本文件名带 `-hs`。
- `boot2_*.bin`、`partition.bin`、`partition_cfg_4M_nosec.toml`、`flash_prog_cfg.ini`：刷机文件与配置。
- `build-info.json`：源码提交、SDK 提交、编译器和工具链归档校验值。
- `SHA256SUMS`：所有其他包内文件的 SHA256 校验。
- `web/`、`GYRO_CN.md`、`刷机说明.txt`：体感设置工具和使用说明。
- 项目、Opus 和 SDK 的许可证说明。

CI 的成功表示测试、编译和打包通过；实际蓝牙连接、音频并发、FS/HS 枚举和 Edge 背键／切档行为仍需真机验收。体感默认关闭。自动编译不等于网页 OTA，当前固件仍通过串口刷写。

## 版本发布

当某个提交准备好发布后，为它创建 `v` 开头的标签并推送。例如选定版本号后运行：

```sh
git tag v3.18-gyro.1
git push origin v3.18-gyro.1
```

六个版本全部成功后，工作流自动创建带六个刷机包的 **Release 草稿**。检查包和说明后，在 GitHub Releases 中手动发布；测试版可勾选 Pre-release。本次配置不会自行创建版本标签或发布正式版本。

如果该标签已经存在 Release，自动创建会明确失败，避免覆盖已有版本附件；可先检查现有 Release，再决定是否删除草稿重跑或使用新版本标签。普通 Actions 构建和下载不需要写权限，只有标签 Release 作业使用 `contents: write`。

## 固定依赖与本地复现

[dependencies.env](../.github/ci/dependencies.env) 固定 SDK 仓库与完整提交号，以及 Linux x86_64 的 XuanTie v2.6.1 下载地址和 SHA256。工具链下载后先校验再解压，缓存按 SHA256 区分。固件 v3.18 使用旧版 T-Head DSP 指令，升级编译器需要单独验证，不能直接换成普通 RISC-V GCC。

在 Linux x86_64 上安装 GNU Make 4+、CMake、GCC、Python 3、Node.js、curl 和 xz，再执行：

```sh
source .github/ci/dependencies.env
git clone "https://github.com/${SDK_REPOSITORY}.git" ../bouffalo_sdk
git -C ../bouffalo_sdk checkout "$SDK_REF"
bash .github/ci/install-toolchain.sh
# 按安装脚本输出，把工具链的 bin 目录加入 PATH。
make -C tests check
make -C tests sanitize
python3 -m unittest discover -s tests -p 'test_pack*.py' -v
CMAKE_CMD=cmake BOARD_TYPE=lctech616 USB_SPEED=fs bash build_macos.sh build
python3 scripts/package_firmware.py --board lctech616 --usb fs
```

完整包写入 `dist/`。也可用 `BL_SDK_BASE` 指向其他位置的同一 SDK 提交，`BUILD_JOBS` 控制并行度。源码、SDK 和工具链更新应修改依赖锁定文件后重新验证六个版本。

`defconfig` 明确选择现有的 4 MiB 分区表 `firmware/lctech616/partition_cfg_4M_nosec.toml`，三种板型共用该布局，FW 不加密。打包读取本次 `build/build_out` 的文件，并检查构建档位、分区配置、Boot2 唯一性、文件非空、SDK 提交和主固件大小；不从可能含有旧版本的 `firmware/` 目录收集二进制。
