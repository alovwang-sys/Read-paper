# 来源收录浏览器验证简报

2026-10-17，工作树 `source-intake/Read-paper`，独立 Vite 端口 5184。

专项执行 `playwright test --config /tmp/source-intake.playwright.config.mjs source-intake.spec.ts knowledge-flow.spec.ts`：12/12 通过（46.2 秒），包括本轮 6 场景与旧知识链路 6 场景。随后集成负责人完成全量 91 项回归，全部通过，见[最终验收](README.md)。临时配置沿用现有 Playwright 配置的单 worker、1440×900 默认视口，仅将来源改为 5184，避免误连另一工作树的开发服务。

另运行 `playwright test --config /tmp/source-intake.playwright.config.mjs workbench.spec.ts --grep '延迟 PDF 导入'`：1/1 通过（3.1 秒），确认导入提交研究绑定与切换研究后的目标工作区保持。

全量回归曾发现测试注入方式受 Vite HMR 影响：应用加载带时间戳的 workspace 模块，测试裸 import 产生未加载的另一实例。最终测试改为实际点击 AI 标签、在输入区发送问题，由 mock `/api/ai/chat` 返回固定流式回答；状态读取恢复日志或 IndexedDB，完全移除业务单例动态 import。此后重启开发服务并运行上述 12 项通过。

| 场景 | 已验证行为 |
| --- | --- |
| AI 来源预览 | 显式链接显示来源项；中央预览不增加文档和研究关联；1440×900、1280×800、1024×800 均保留右侧回答及未发送输入；主区返回可恢复 |
| 直接收录 | 后台保存并获取 PDF，不强制预览或替换主区；实际 PDF 字节保存、解析、渲染；刷新后仍可本地阅读；不自动添加 AI 上下文 |
| 全文失败及补齐 | PDF 404、返回 HTML 登录页均保留条目和原摘要；手动补 PDF 沿用原 ID、研究关联和发现记录；刷新后可阅读 |
| 链接与跨研究 | 元数据 503 时也可保存链接；两研究复用同一实体；备注和 AI 发现记录隔离，刷新与研究切换后仍在 |
| 刷新中断 | 正在获取时刷新，保留资料并显示已中断，可重试并取得原摘要 |
| 迟到响应 | 手改标题、作者不被迟到元数据覆盖，未手改年份可补齐；手动补充的 PDF 不被后到网络 PDF 替换，刷新后保持 |

全部截图均检查页面无横向溢出。测试监听页面未捕获异常与 console error，未发现非预期错误；404/503 来源接口产生的预期资源错误单独排除。

截图：

- `source-preview-1440.png`、`source-preview-1280.png`、`source-preview-1024.png`：三尺寸中央预览与右侧 AI。
- `source-readable-1280.png`：自动获取 PDF 后本地阅读。
- `source-no-fulltext-1440.png`：下载失败状态与补充全文入口。
- `source-abstract-retained-1440.png`：失败后作者摘要、补全文和研究收录记录均在。
- `source-supplemented-1024.png`：手动补齐后窄屏并列阅读与 AI。

验证边界：来源解析与 PDF 请求均由 Playwright `page.route` 提供确定性响应；PDF 是项目自制研究样例经 pdf-lib 修改元数据形成独立 hash 的有效文件。此处证明工作台交互、保存、失败恢复和 PDF 阅读路径，不代表真实文献检索、出版社下载或真实模型调用已经通过。真实联网与桌面转发由集成负责人另行记录。
