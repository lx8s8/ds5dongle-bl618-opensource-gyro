# macOS 键鼠接口诊断

本整合分支保留可选的私下 USB 诊断身份；普通构建仍使用原有的 DualSense / Edge USB 身份，六版本 CI 发布矩阵保持不变。

当前 Mac 的 `AppleGameControllerPersonality` 按 `054c:0df2` 匹配到了手柄接口和新增键鼠接口。G2.1 修复了鼠标 HID 枚举，但原身份下仍未观察到鼠标移动；G2.1T 诊断身份改由通用 HID 驱动接管后，鼠标及 L2 门控已通过本次人工验收。编译器差异及正式身份方案仍需后续对照，详见 [真机记录](HARDWARE_RESULT_2026-11-14_CN.md)。

在 macOS 已配置本地编译环境后，可显式构建诊断身份：

```sh
USB_DIAGNOSTIC=1 bash scripts/build_local.sh build
USB_DIAGNOSTIC=1 bash scripts/build_local.sh package
```

去掉环境变量后重新构建即恢复普通身份。构建状态包含此选项，切换时重新配置。诊断包名称包含 `hid-test`，`build-info.json` 标记 `private-hid-test`；不能把它作为标准包对外发布。

诊断身份 `1209:0001` 为私下测试保留值，不具有唯一性，不用于制造或销售产品。诊断构建只改 USB 识别和测试名称，蓝牙识别、HID 报告格式及体感运算不变。控制中心同时允许选择标准和诊断接收器。仅更新主程序，保留完整 Flash 备份；测试身份下的原生手柄和音频/触觉兼容性不据此判定通过。
