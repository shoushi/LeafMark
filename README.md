# LeafMark

LeafMark 是一个本地优先的桌面 Markdown 编辑器 MVP。文档始终保存在用户选择的工作区中，应用只通过受限的 Electron IPC 访问文件。

## 已实现

- 打开本地工作区并递归发现 Markdown 文件
- 多标签页、快速搜索、文档大纲、深浅主题和专注模式
- 所见即所得、源码、阅读三种模式
- GFM 表格、任务列表、代码块、链接和图片渲染
- 自动保存、手动保存、SHA-256 外部变更冲突检测
- 临时文件写入、崩溃保护基础、外部文件监听
- 创建 Markdown 文件、最近工作区和安全外链
- Renderer 沙箱、Context Isolation、CSP 和白名单 IPC
- 图片粘贴/拖放到工作区 `attachments/`，自动插入 Markdown 引用
- 保存前历史快照、历史恢复和行级三方冲突合并
- Markdown/HTML 导出

## 开发

需要 Node.js 20+ 和 pnpm。

```bash
pnpm install
pnpm dev
```

如果 PowerShell 提示找不到 `pnpm`，当前环境可以直接用已安装依赖运行：

```powershell
npm run dev
```

或者仅为当前 PowerShell 会话补充 pnpm 路径：

```powershell
$env:Path = "C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback;$env:Path"
pnpm dev
```

生产构建：

```bash
pnpm typecheck
pnpm build
pnpm package
```

Windows 当前可直接使用 `release/LeafMark-0.2.0-win-x64-portable.zip`：解压到任意目录后双击 `LeafMark.exe`。这是免安装版本，不会写入注册表；如需桌面快捷方式可右键创建快捷方式。

NSIS `.exe` 安装器需要额外下载 Windows 打包工具；在无法访问 GitHub Release 的网络环境中，优先使用上述 portable ZIP。

如 Electron 下载受网络限制，可设置镜像：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
$env:electron_config_cache="$PWD\.electron-cache"
pnpm rebuild electron
```

## 数据安全边界

- 所有文件操作必须位于当前工作区内。
- 保存时比较打开文件时的内容哈希，外部修改后拒绝覆盖。
- 删除 API 使用系统回收站；当前界面尚未暴露批量删除。
- WYSIWYG 使用 HTML 到 Markdown 的简化转换。复杂或自定义 Markdown 语法应切换到源码模式编辑；生产版需要继续完善块级无损序列化。

## 后续阶段

- CodeMirror 6 源码编辑器与 Milkdown/ProseMirror 无损编辑内核
- SQLite FTS5 增量索引、Mermaid、KaTeX
- Windows/macOS/Linux 签名与自动更新
