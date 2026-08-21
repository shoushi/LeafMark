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
- CodeMirror 6 源码编辑器，支持源码模式下的快捷键、选区和图片附件插入
- Mermaid 图表和 KaTeX 行内/块级公式渲染（渲染失败时保留源码提示）
- SQLite 持久化增量搜索索引；运行时提供 FTS5 时使用 FTS5，标准 sql.js WASM 缺少扩展时自动降级为 SQLite 内容索引

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

- Milkdown/ProseMirror 无损块级编辑内核（当前 WYSIWYG 仍使用受限 HTML → Markdown 序列化）
- Windows/macOS/Linux 代码签名、发布渠道和自动更新
- 将 SQLite FTS5 放入自定义 WASM 构建，减少中文搜索的全表候选扫描
