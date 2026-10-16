# Forge 重建子进程继承了不适用的 Node 参数

日期：2026-10-17，Asia/Shanghai。root_cause：`process_invocation`。

本次只验收新桌面包；保留正在合并的业务改动、既有 `out/` 和其他 agent 的任务，不修改依赖版本、安装脚本策略或 Forge 配置。2026-10-16T17:19:25Z 快照：HEAD 为 `68583443be5b9d5a03a3a9f980d0028a24c6cc04`，主 agent 正在整合 main 的桌面分发功能与研究会话功能。接手时没有本任务有权停止的既存后台进程；本任务仅管理自己的构建命令。

```text
调用 / 任务              共享状态 / 耦合                    最后改动锚点
主 agent                 最终 dist、合并中的业务源码          本次交接消息 / 上述 HEAD
本任务 package           Forge → fork(remote-rebuild.js)      已安装 Forge 8.0.1
桌面 UI 验收 agent        独立 HOME/userData，消费新 /tmp 包    本次交接消息
```

## 故障基线

原包装调用亲手复现 `exit 1`，完整末尾见 [package-baseline.log](package-baseline.log)：

```sh
node --input-type=module -e 'import { api } from "@electron-forge/core"; await api.package({dir:process.cwd(),outDir:"/tmp/read-paper-project-package-20261017",interactive:false});'
```

```text
Error: Rebuilder failed with exit code: 1
    at ChildProcess.<anonymous> (.../@electron-forge/core-utils/dist/rebuild.js:58:40)
Node.js v24.21.0
```

不改动安装文件，按 Forge 原参数直接 fork `remote-rebuild.js` 并继承 stderr，得到 [rebuild-child.log](rebuild-child.log)：

```text
Error [ERR_INPUT_TYPE_NOT_ALLOWED]: --input-type can only be used with string input via --eval, --print, or STDIN
  code: 'ERR_INPUT_TYPE_NOT_ALLOWED'
Node.js v24.21.0
child exit 1
```

`@electron-forge/core-utils/dist/rebuild.js` 的 `cp.fork()` 未指定 `execArgv`，因此继承父进程的 `--input-type=module`；子进程入口为 `.js` 文件，Node 在加载 rebuilder 前就拒绝执行。这个错误签名不证明 native 依赖构建失败，也与 `electron/path.txt` 缺失不是同一问题。

## 最小修正与实际结果

只调整本次验收调用，使用动态 import，去掉不适用于文件子进程的父进程参数：

```sh
node -e 'import("@electron-forge/core").then(({api})=>api.package({dir:process.cwd(),outDir:"/tmp/read-paper-project-package-20261017",interactive:false})).catch(error=>{console.error(error);process.exitCode=1});'
```

```text
exit 0
stdout / stderr: empty (interactive:false)
```

新可执行文件为 `/tmp/read-paper-project-package-20261017/Papertrail-darwin-arm64/Papertrail.app/Contents/MacOS/Papertrail`，权限 `100755`。`app.asar` 实际存在（107939192 bytes），枚举确认包含 `/server/projects.mjs`、`agents.mjs` 及三家 runtime。未跳过生产依赖重建；没有执行安装脚本、修改 npm 永久策略或替换依赖。原 `out/` 未改动。包使用主 agent 已成功构建的最新 dist，真实桌面交互验证由桌面 UI agent 接续，打包成功本身不代表模型请求已通过。

## 退路与防复发

没有业务源码、依赖或环境配置需要回退；本任务新增内容仅为独立 `/tmp` 包和故障记录。需要移除本任务产物时仅删除该明确目录及本记录增量，保留其他 agent 的改动。后续继续使用项目 `desktop:package` 脚本或普通文件入口；通过 Node eval 包装会 fork 的构建器时，不传递 `--input-type`。

本项目当前 `process_invocation` 类已登记事件 1 条，全局次数未知；无全局 PMB 工具，以本记录和项目 PMB 为最小替代。没有修改角色定义，没有提交、发布或移动 Git refs。

## 最终包续验：离线使用已校验的官方缓存

首个成功包后，主 agent 给 `server/projects.mjs` 增加了 list/read 整次请求超时，因此需要重新打包。普通动态 import 调用不再触发 rebuilder 错误，但远程下载出现新的环境故障，root_cause：`network_access`。这是另一个错误签名，原始日志见 [package-final-network.log](package-final-network.log)：

```text
TypeError: fetch failed
    at async FetchDownloader.download (.../@electron/get/dist/FetchDownloader.js:46:30)
  [cause]: ConnectTimeoutError: Connect Timeout Error (attempted address: github.com:443, timeout: 10000ms)
    code: 'UND_ERR_CONNECT_TIMEOUT'
```

已安装 `@electron/get` 的 `validateArtifact()` 实现表明：命中 ZIP 缓存后，若调用方没传 `checksums`，仍会绕过缓存下载 `SHASUMS256.txt`；校验请求网络失败后会回退至 ZIP 下载。缓存本身存在并不代表完全离线。前一次成功命令没有额外环境变量，当前进程也无 proxy、Electron cache 或 mirror 变量；没有输出代理凭据或读取无关配置。

实际官方缓存 ZIP：

```text
/Users/amos/Library/Caches/electron/0b1dfe8edb6413a5548f3f263a6041b2edbc8a090672c13442a3752ee61a5c26/electron-v44.8.0-darwin-arm64.zip
SHA256 ccd9ba800d39d403375211d8f8da528469ebae3213cce4ec72b42e4dcc847513
```

这个 SHA256 与已锁定 `electron@44.8.0` npm 包的 `checksums.json` 完全相同。本次先显式比较该值，再仅在 Node 进程内向已加载 Forge 配置对象提供官方 `checksums`；仍由 `@electron/get` 正常验证并解压缓存，Forge 仍执行原有 rebuild。未使用 `unsafelyDisableChecksums`、`electronZipDir`、跳过重建选项，也未修改项目配置、依赖或持久环境。完整成功命令：

```sh
node -e 'const fs=require("node:fs"),crypto=require("node:crypto"); const file="/Users/amos/Library/Caches/electron/0b1dfe8edb6413a5548f3f263a6041b2edbc8a090672c13442a3752ee61a5c26/electron-v44.8.0-darwin-arm64.zip"; const actual=crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"),expected=require("./node_modules/electron/checksums.json")["electron-v44.8.0-darwin-arm64.zip"]; console.log(JSON.stringify({electronVersion:require("./node_modules/electron/package.json").version,file,actual,expected,match:actual===expected}));if(actual!==expected)process.exit(1); const config=require("./forge.config.cjs");config.packagerConfig.download={...config.packagerConfig.download,checksums:require("./node_modules/electron/checksums.json")}; import("@electron-forge/core").then(({api})=>api.package({dir:process.cwd(),outDir:"/tmp/read-paper-project-package-20261017-final",interactive:false})).then(result=>console.log(JSON.stringify({packaged:true,result}))).catch(error=>{console.error(error);process.exitCode=1});'
```

```text
exit 0
{"packaged":true,"result":[{"platform":"darwin","arch":"arm64","packagedPath":"/tmp/read-paper-project-package-20261017-final/Papertrail-darwin-arm64"}]}
```

原始成功输出见 [package-final-cached.log](package-final-cached.log)。最终可执行路径是 `/tmp/read-paper-project-package-20261017-final/Papertrail-darwin-arm64/Papertrail.app/Contents/MacOS/Papertrail`。首次成功包保留，未覆盖用户 `out/` 或已运行应用。最终 `app.asar` 中的项目服务、三家 runtime、桌面主进程 / 协议以及全部 dist assets 均逐文件与当前源码和构建文件比较 SHA256，全部相同；完整结果见 [package-final-hashes.json](package-final-hashes.json)。桌面交互由 UI 验收 agent 接续，本记录不把打包成功充当模型交互证据。
