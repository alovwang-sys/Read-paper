# 原文旁助手合入前的桌面 CI 回归

2026-10-19，基线 `7c60239`，PR #19 合入验收。root_cause: `dependency-assets-and-ui-test-contract`。本项目同签名历史次数未知，全局次数未知；PMB 使用项目本地记录。

## 故障基线

[CI 39151853414](https://github.com/alovwang-sys/Read-paper/actions/runs/39151853414) 的 Checks 成功，三个 Desktop 平台失败，Required checks 失败。本机已有 arm64 包同样含 23 项 protobuf 依赖测试目录或文件。

- 三平台产物白名单收到 `/node_modules/@protobufjs/*/tests`；原规则只排除 `.test/.spec` 文件，没有排除普通 `tests/index.js` 和数据目录。
- 三平台 reader-images 仍在主窗格内寻找已移入 body portal 的区域预览，后续仍调用已移除的“问 AI／加入当前对话”。
- Windows 新增 inline-ai 用例未产生文本选区。归档 trace 没有截图或 DOM 快照，不能据此声称字体或窗口尺寸是已证实根因；原脚本只按整个 span 边界拖动，缺少可见区域、命中与焦点确认。

## 最小修复

- 在 Forge 既有 ignore 中排除任意层级的 `tests/docs` 目录；不增加清理 hook，保留依赖运行文件和许可证。Packager 的递归复制会对依赖普通子目录应用该过滤器。
- reader-images 使用实际 portal 和显式摘录、就地提问、转右侧、选择 Codex、明确添加材料的路径，保留原图片字节、来源和正常重启断言。
- inline-ai 保留真实鼠标拖选，先激活页面、滚动并等待命中稳定，用可见字符几何定位两端；断言焦点、阅读器内可见范围、实际命中与选区归属，附几何诊断附件。不放宽超时，也不改用程序选区。

## 已执行验证

```text
npm run test:desktop
tests 27 / pass 27 / fail 0 / exit 0
npm run desktop:package
Packaging for arm64 on darwin / exit 0
Packaged test/docs directories: 0; Pi runtime and protobuf runtime/license preserved.
定向桌面 reader-images + inline-ai：2 passed (13.0s)，exit 0
```

本机完整打包桌面回归随后 exit 0：`16 passed (1.9m)`，没有跳过。最新远端三平台结果按 PR checks 核对；定向通过不能替代 Windows、Intel 或全部门禁。合并前要求全部通过，不删除或绕过失败检查。

## 退路与防复发

回退这些修复可恢复到 `7c60239` 的打包规则和测试；不涉及用户数据、模型设置或已安装应用。依赖增加时检查实际 asar 的运行文件、许可证和无测试目录断言；UI 宿主或入口改变时同步浏览器与打包桌面路径。原生交互依赖实际可见坐标及命中证据，不能只使用名义 viewport。

## 续验：Intel 目录读取时机

提交 `a4beb29` 的 [CI 39181476243](https://github.com/alovwang-sys/Read-paper/actions/runs/39181476243) 中 Checks 完整浏览器 `163 passed`，Windows 与 arm64 桌面通过；Intel `15 passed / 1 failed`，失败发生在目录重试后的 `expect.poll(() => readFile(cardFile))`，错误为 ENOENT。

`server/project-files.mjs:228–229` 将旧文件移入暂存后再落地新文件，期间目标路径短暂不存在；清单提交、清理完成后才返回成功。因此测试在保存完成前读路径，不能将一次 ENOENT 直接当作最终失败。两处轮询仅对 ENOENT 返回未就绪值继续等待；其他错误仍抛出，最终正文、UI 保存成功、PDF 未重写和外部冲突保护断言保留。不修改生产事务，也不增加超时。

`npm run check` exit 0；打包桌面 `research-directory.spec.ts` 定向验证 exit 0：`2 passed (11.8s)`。新提交仍须重新等待完整 CI，不能用前一提交的平台结果替代。
