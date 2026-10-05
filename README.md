# Skill Studio

> 多 Agent 本地 Skill 统筹工具：一个 Skill 仓库，按规则分发到 Claude Code、Codex、Cursor、WorkBuddy 等 49 个 Agent。

Skill Studio 扫描你机器上散落在各个 IDE、项目与全局目录中的 AI Agent Skills，提供冲突检测、可视化编辑、版本快照、回收站、GitHub 备份与相似 Skill 聚合，并以「仓库 → 规则 → 软链接」的方式把 Skill 分发到各个 Agent。

---

## 🌟 核心功能

- **统一分发模型**：Skill 仓库是唯一来源；每个 IDE 一条规则（全部仓库 Skill / 仅全局集 / 关闭，可额外包含或排除），先预览变更、再一键应用。详见下文。
- **项目级 Skill**：为项目选择 Skill（`.skills-profile.json`），以软链接（或 Antigravity 物理副本）同步到项目目录。
- **冲突与漂移检测**：同名不同源的 Skill、与仓库不一致的物理副本。
- **版本快照与回收站**：编辑前自动快照，可 Diff / 回滚；删除进回收站（7 天）。
- **GitHub 备份同步**：关联个人仓库，上传 / 拉取 Skills。
- **市场与更新**：搜索安装 Skill，检查上游更新。
- **相似 Skill 检测、分类与健康度报告**。

## 🔀 分发模型

配置保存在 `~/.config/skill-studio/distribution.json`（首次运行时从旧版配置自动迁移）：

| 概念 | 含义 |
|---|---|
| Skill 仓库 | 「自定义路径」中设置的目录（未设置时为 `~/.agents/skills`）。只有仓库里的 Skill 会被分发。 |
| IDE 规则 | `全部仓库 Skill` / `仅全局集` / `关闭`，外加 `include` / `exclude`。**未设置规则的 IDE 完全不碰。** |
| 全局集 | 「仅全局集」模式的 IDE 接收的 Skill 列表。 |
| 分发计划 | 规则与磁盘的差异：新增、重新指向、移除、冲突、旧版遗留。修改规则不动磁盘，点击「应用」才执行。 |

安全约定：
- 只创建 / 移除**指向仓库的软链接**；真实目录、其它工具创建的链接永不改动。
- 旧版本创建的交叉链接（指向项目私有 Skill、其它 Agent 目录或已悬空）只在勾选「同时清理」时处理。
- 扫描是只读的；Skill 详情里的保存、批量挂载等操作只应用所涉及 Skill / IDE 的变更。

## 🔒 安全模型

服务只监听 `127.0.0.1`，并且：
- 每次启动生成随机会话 token，页面以 `SameSite=Strict` cookie 携带；所有 `/api` 与 `/ws` 请求必须带 token。
- 拒绝非本机 `Host`（防 DNS 重绑定）与非本机 `Origin`（防跨站请求）；不启用 CORS。
- 外部命令（git / npx）以参数数组调用，不经过 shell。
- 客户端传来的路径一律校验：只对扫描到的 Skill、已注册项目、服务端创建的临时目录操作。
- GitHub token 只写不读（接口不返回），配置文件权限 `0600`。

## 🚀 快速开始

运行环境：Node.js ≥ 20

```bash
npm install
npm run build
npm start
```

启动后自动打开浏览器，默认地址 `http://localhost:3456`（端口被占用时依次尝试 3457–3460）。

## 🛠 开发

```bash
npm run dev        # 后端 tsx watch + Vite 前端（http://localhost:5173）
npm run typecheck  # 前后端类型检查
npm test           # vitest 回归测试（在临时 HOME 沙箱中运行，不触碰真实目录）
npm run build      # 类型检查 + 构建
```

开发模式下 Vite 代理会从 `~/.config/skill-studio/port` 与 `session-token` 读取后端端口和会话 token。

## 📂 目录结构

- `server/` — Fastify 后端
  - `scanner/` 扫描、项目发现、分类、相似度、健康度
  - `distribution/` 分发模型（期望状态、plan / apply 调和器）
  - `projects/` 项目 Skill 同步
  - `routes/` HTTP 接口；`security/` 请求守卫；`sync/` GitHub 备份；`updater/` 上游更新
- `web/` — React + Vite + Tailwind 前端（前端类型直接复用 `server/types.ts`）
- `tests/` — vitest 回归测试
- `bin/` — CLI 入口

## 🗂 本地数据

| 路径 | 内容 |
|---|---|
| `~/.config/skill-studio/ide-settings.json` | 仓库路径、GitHub token、代理（0600） |
| `~/.config/skill-studio/distribution.json` | 分发规则 |
| `~/.config/skill-studio/credentials.json` | GitHub 备份仓库凭据（0600） |
| `~/.config/skill-studio/{projects,excluded-projects}.json` | 手动添加 / 隐藏的项目 |
| `~/.skill-studio/versions/`、`~/.skill-studio/trash/` | 版本快照、回收站 |
| `<项目>/.skills-profile.json` | 项目 Skill 配置 |

## ⚙️ 环境变量

- `PORT`：起始端口（默认 3456）
- `SKILL_STUDIO_NO_OPEN=1`：启动时不自动打开浏览器
- `SKILL_HUB_EXTRA_PATHS`：额外扫描的 Skill 目录（`:` 或 `,` 分隔）

## 📄 许可证

MIT License
