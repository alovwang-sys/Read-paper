# 本机安装结果

2026-10-23，macOS arm64 的 `/Applications/Papertrail.app` 已从0.1.14替换为 **0.1.15**，并实际打开。

- 使用本轮最终安装包；安装前后ASAR校验一致：`41c82fe62b5f49f7c893821d7f625a6477848ee13ddfae8b9604f48b335fc4e9`。包与源码摘要见[build.json](build.json)。
- 旧程序已移入本机废纸篓；另将旧app与完整userData备份到用户私有 `Papertrail-Backups/2026-10-23_190146`。备份清单和原始安装日志保存在该目录，未提交仓库。
- 同一应用名、bundle ID `io.github.alovwang-sys.papertrail`、`papertrail://app/` 与userData目录保持。替换程序前后92个用户数据文件逐一hash一致；启动后加密模型设置逐字节保持一致，未读取密钥。
- 原生界面实际出现既有研究、论文最近打开项、紧凑会话列表、原有问题和回答、统一聊天输入；进程路径确认为已安装的 `/Applications/Papertrail.app/Contents/MacOS/Papertrail`。
- 打包桌面重启恢复用例在隔离数据中完成，正常退出、草稿／历史／原文操作恢复见README。真实安装打开后用户开始操作，因此没有再次退出其窗口或拍摄用户资料；本仓库截图均为合成资料的受控验收。

这是一轮本机体验安装。没有发布远端Release或执行远端合并。未配置发行者签名／公证，沿用此前本机预览基线，没有修改系统安全设置。真实模型对本轮简要提示的质量未重测。
