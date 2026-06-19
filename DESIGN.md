# Design System: Skill Studio (极客技能中心)
**Project ID:** local-skill-studio-v3

## 1. Visual Theme & Atmosphere
本设计系统专为 **Skill Studio** 开发者工具量身定制。
其核心氛围为 **“Geist 极简与高对比度”**：
- **深色美学**：采用极深邃的底色 (#000000) 与卡片深灰色 (#0a0a0a)，为开发者营造沉浸、低疲劳的暗色极客环境。
- **高对比度**：去除多余的颜色点缀，将颜色保留为传递状态（成功、高危、警告），大量留白，突出主体内容，打造 Premium 体验。

---

## 2. Color Palette & Roles
- **背景一级 (Background-100)**: `#000000`。用于整个应用的大背景。
- **背景二级 (Background-200)**: `#0a0a0a`。用于悬浮交互、次要侧边栏。
- **背景三级 (Background-300)**: `#1c1c1c`。用于活动 Tab 选中项或主要选中区域。
- **边框 400 (Border-400)**: `#333333`。默认状态的边框。
- **边框 500 (Border-500)**: `#444444`。悬停状态的边框。
- **次要文字 (Gray-900)**: `#888888`。二级字色、辅助说明。
- **首要文字 (Gray-1000)**: `#ffffff`。核心标签、加粗重点与主要文本。
- **翡翠绿 (Emerald Health)**: `#0070f3` (Geist 专用高亮蓝，表示正常或状态就绪) 以及绿标状态。
- **熔岩红 (Lava Danger)**: `#e00000`。用于高危安全漏洞提示、删除按钮等。

---

## 3. Typography Rules
- **字体族 (Font Family)**: 选用现代非衬线字体 `Geist Sans` 或 `system-ui, -apple-system`。
- **字重控制 (Weight Hierarchy)**:
  - 标题使用 **Bold (700)**，结合 Geist 高对比字色。
  - 正文使用 **Medium (500)**，代码和部分标识符使用 `Geist Mono` 或 `monospace`。

---

## 4. Component Stylings
- **Buttons (按钮)**:
  - **首要按钮 (Primary)**：纯白背景，纯黑文字（`bg-white text-black`）；悬浮时微带缩放与高亮。
  - **次要按钮 (Secondary)**：暗色背景，浅灰框线，悬浮时框线转亮。
  - **形状**：紧凑圆角 corners (`rounded`，弧度 6px)，微交互弹性过渡 (`transition-all`)。
- **Cards/Containers (卡片/容器)**:
  - 极细暗灰边框（`border border-slate-800`），配合扁平无阴影设计。

---

## 5. Layout Principles
- **极致呼吸感 (Spacious Whitespace)**：布局在横向和纵向间距上均使用 `space-y-6` / `gap-6`，保证复杂的技术数据和 Skill 卡片之间有清晰可辨的结构。
- **极细边框线分割 (Divider Rules)**：卡片内与模块间的分割使用极细线，拒绝粗厚线条，维持页面的精致度。
