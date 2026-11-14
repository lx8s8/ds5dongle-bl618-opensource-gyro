# PS5 体感取轴与映射对照

本次对照源码：

- [SDL 的 PS5 输入结构与工厂标定](https://github.com/libsdl-org/SDL/blob/main/src/joystick/hidapi/SDL_hidapi_ps5.c)：去掉报告 ID 后，陀螺仪三轴位于 15/17/19，加速度位于 21/23/25，传感器时钟位于 27。当前固件的解析位置一致，不能凭输出幅度小就交换报文字节。
- [DS4Windows 的 DualSense 读取](https://github.com/ds4windowsapp/DS4Windows/blob/main/DS4Windows/DS4Library/InputDevices/DualSenseDevice.cs) 与 [DS4Sixaxis](https://github.com/ds4windowsapp/DS4Windows/blob/main/DS4Windows/DS4Library/DS4Sixaxis.cs)：分别取 Pitch、Yaw、Roll，执行工厂标定与零偏处理，再转换输出方向。[MouseCursor](https://github.com/ds4windowsapp/DS4Windows/blob/main/DS4Windows/DS4Control/MouseCursor.cs) 在本地 Yaw/Roll 两种水平输入之间选择，不会把侧倾自动当作 Yaw。
- [JoyShockMapper 的取轴与姿态空间](https://github.com/Electronicks/JoyShockMapper/blob/master/JoyShockMapper/src/main.cpp#L441)：Local 模式明确选轴；Player/World 模式另用重力方向投影得到转向或侧倾输入。它不是简单把两轴相加。[GamepadMotionHelpers](https://github.com/JibbSmart/GamepadMotionHelpers/blob/main/GamepadMotion.hpp#L1169) 提供传感器融合、重力估计和 Player Space 计算。
- [JoyShockMapper 的右杆输出](https://github.com/Electronicks/JoyShockMapper/blob/master/JoyShockMapper/src/JoyShock.cpp#L1511)：先计算目标角速度，再按游戏满杆转速、逆响应曲线和径向死区转换为虚拟摇杆。该路径也适用于输出虚拟 Xbox 摇杆，不能与按倾斜角度控制摇杆的 Motion Stick 路径混为一谈。

## 本轮记录能说明什么

用户提供的第二份 CSV 有 108 条 Feature 遥测，覆盖 10.881 秒，其中 33 条映射开启、原生配置均为 1。工厂标定标志有效，手动零偏标志未启用。

| 记录项 | 结果 |
| --- | --- |
| Yaw 峰值 | 42.80 °/s |
| Roll 峰值 | 169.96 °/s |
| 水平滤波与 Yaw 的相关系数 | 0.99889 |
| 水平滤波与 Roll 的相关系数 | -0.90910 |
| 原记录右杆 X | 94–162，约 ±27% |
| 该记录参数 | Yaw、水平不反转、X/Y 倍率 2、满杆 360 °/s、游戏死区补偿 10% |

录像中可见明显左右侧倾，数据中的 Roll 分量也远大于 Yaw。仅取 Yaw 会遗漏较大的侧倾分量；其余轴的附带运动也可能与用户感受到的整体动作不同步。此前反复按 Yaw 引导用户测试不合适。这里没有证据支持再用增加滤波来修正取轴选择。

用同一批角速度计算“Roll＋水平反转”的单轴选择、二维径向稳态响应，预测水平峰值约 94%。这是不含未采样高频数据和滤波过程的稳态对照，不是实际 USB 回放，也不能代替方向、延迟和手感验收。CSV 的 `stick_x/y` 来自 Feature 状态，不是主机收到的 USB 输入。

配置 1 最初只在 RAM 中改了取轴和反转，随后 USB 断开；重新回读为 Yaw、未反转且未保存标志为 0，原对照条件已经丢失。第二次只改同样两项并保存，再通过网页重新读取确认 Roll、水平反转、倍率 2。用户随后反馈上下左右和幅度基本正常，另反馈接近 90° 时有中心吸附感，继续单独定位。

## 角速度与角度的区别

当前右杆映射使用角速度。转到 90° 后停住，角速度归零，输出应当回中；快速转过较小角度也可能产生较大右杆输出。它不表示累计转角。

如果要求转到某个角度后持续保持偏杆，需要独立的角度／Motion Stick 控制方式和中立姿态定义。若要求改变持握角度时仍保持相同转向手势，则需要经过验证的重力估计及 Player/World Space 投影。当前固件只有本地 Yaw/Roll，尚未实现上述模式，不能把两个标签改名后称作已实现。

新一份诊断记录含 15005 条实际 USB 输入、3522 条绘制回调及 600 条 Feature 状态。L2 连续按住约 19.947 秒，右杆 X 覆盖 0–254。唯一持续约 298ms 的二维中位段位于按下 L2 初始门控阶段；另有约 87ms 的水平近中位，对应选中 Roll 的角速度约 ±0.7 °/s。没有观察到持续积压或强 Roll 与右杆反向。它支持输出在该段按选定角速度响应，但不能据此否定用户的吸附感；需要区分持续运动时回中与保持偏转姿势时回中。

将诊断中的原始传感器数据送入未改动的 `src/gyro.c` 做离线 C 回放，门控之后比较 9798 个有效样本。水平输出误差中位数及第 95 百分位均为 0 个计数，最大 23；垂直为 1、1、9。USB 采样会遗漏蓝牙处理样本，工厂比例由 Feature 遥测拟合，实体摇杆中位也只作近似，因此快速变化点不能要求逐点完全相等。这支持当前输出大体符合所选角速度算法，不能测量实体手到传感器的延迟，也不能据此宣布游戏手感通过。

本轮 L2 按住期间最大 USB 到达间隔约 26.8ms，最大绘制间隔约 24.7ms；未见秒级浏览器积压。较长的约 183ms 到达间隔发生在 L2 松开时。手动零偏标志仍未启用，不把这份记录记为已完成本次开机校准。

## 配置工具修正

新连接默认编辑当前生效配置；仍可主动编辑其他档。编辑档与生效档不同时明确提示，手动重新读取保留用户选择的编辑档。补充 Yaw/Roll 的动作说明，减少在配置 3 编辑而误认为作用于 Fn+△ 配置 1 的情况。该网页修正不更改固件协议和 Sony USB 身份。

摇杆页增加可选的 FPS 视角模拟，输入取自主机实际收到的右杆，模拟参数取自生效档。用来区分“右杆回中，视角停在新位置”和“停手后视角继续追赶”；不以模拟代替真实游戏验收。没有修改固件或新增角度保持模式。
