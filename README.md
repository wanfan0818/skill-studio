# Skill Studio

> 多 Agent 本地 Skill 可视化统筹与多端软链接分发管理工具。

Skill Studio 是一款专为 AI 开发者与效率极客设计的本地效率管理工具。它能够一键扫描并管理您机器上散落在各个 IDE、项目或全局目录下的 AI Agent Skills，并提供冲突检测、可视化编辑、双向 GitHub 同步和智能相似 Skill 聚合等功能。

---

## 🌟 核心功能

- **多端统筹分发**：支持一键将本地物理 Skill 挂载到 Claude Code、Cursor、Windsurf 等不同的开发环境中。
- **冲突检测与去重**：自动发现并提示同名冲突的 Skill 副本，防范调用混淆。
- **版本控制与快照**：自动检测 Skill 内容变动并记录轻量级的版本历史，支持随时进行 Diff 对比与回滚。
- **GitHub 自动备份与同步**：支持关联个人的 GitHub 仓库，一键将本地 Skills 上传云端备份，或从云端拉取更新。
- **智能相似性检测**：采用语义相似性算法（如 Jaccard 相似度）自动扫描和提示潜在功能重叠的 Skill，帮助您优化 Skill 库架构。
- **Geist 极简美学**：使用 Geist 暗色设计系统，极简、高对比度的界面视觉。

---

## 🚀 快速开始

### 运行环境
- Node.js ≥ 20

### 安装与启动

1. 在项目目录下，首先运行打包构建：
   ```bash
   npm run build
   ```

2. 启动本地服务：
   ```bash
   npm start
   ```

服务启动后，会自动为您打开浏览器，默认地址为 `http://localhost:3456`。

---

## 📂 目录结构

- `server/` — Fastify 后端（API + WebSocket + 扫描器）
- `web/` — React + Vite 前端（Geist Dark 设计系统）
- `bin/` — CLI 入口与构建脚本
- `README.md` — 说明文档

---

## ⚙️ 可选环境变量

- `PORT`：自定义起始端口（默认 3456）
- `SKILL_STUDIO_NO_OPEN=1`：启动时不自动打开浏览器

## 📄 许可证

MIT License
