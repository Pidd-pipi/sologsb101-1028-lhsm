# 录音棚场次与 Take 标记台（gbstudiotake）

面向录音棚制作人、录音师与棚务统筹的本地化棚务台账：按录音项目登记曲目，为每首曲目安排录制场次与参与乐手，逐条标记 Take 的起止时间码、问题标签与可用性评级，再把优选片段汇总成剪接清单，并为不满意的段落排补录计划。

核心动作：**建项目与曲目 → 排场次与乐手 → 逐 Take 标记 → 汇总优选 Take → 排补录并导出场次记录表**。

棚务统筹会同时开多个标签页处理同一场录制。场次 / Take / 优选的保存均走**修订保存（乐观锁）**：保存前比对打开编辑框时的已读版本，版本落后则整笔回滚、不写新版本，并在弹窗中三方并列「已读值 / 我的输入 / 数据库最新值」，用户输入原样保留；**Take 时间码或棚号一变，引用它的优选立即在同一事务内失效并重算来源快照，复核确认前不进入剪接清单**。旧版本数据升级到结构 v2 时自动补齐修订版本号并进「修订复核区」（`/review`）集中确认，原有页面照常可用。

纯前端单页应用（React 18 + TypeScript + Ant Design + Vite + Zustand + React Router + Dexie），**无后端、无数据库服务、无 API 服务**，全部数据保存在浏览器本地（IndexedDB），刷新或重启浏览器后仍然存在。

---

## 一、Docker 一键启动（推荐）

```bash
# 1. 首次启动先复制环境变量模板
cp .env.example .env

# 2. 构建并启动
docker compose up -d --build
```

启动完成后访问：**http://localhost:22828**

常用命令：

```bash
docker compose ps                 # 查看服务状态（healthy 表示就绪）
docker compose logs -f frontend   # 查看 nginx 日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 代码改动后重新构建
```

> 端口可在 `.env` 中通过 `FRONTEND_PORT` 修改；容器名固定为 `${COMPOSE_PROJECT_NAME:-gbstudiotake}-frontend`。
> 容器无状态：不连接数据库、不挂载命名卷，数据全部在浏览器本地，迁移设备请使用应用内「导出整库备份 / 导入备份」。

---

## 二、技术栈

| 分类 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | React 18（函数组件 + Hooks） | 全部页面使用函数组件与自定义 hooks |
| 语言 | TypeScript（`strict: true`，无 `any`） | `npm run build` 内含 `tsc --noEmit` 类型检查 |
| UI 组件库 | Ant Design 5（含 `@ant-design/icons`） | 表格、卡片、Modal、Form、Segmented、Badge 交互 |
| 构建工具 | Vite 5 | 开发服务器端口 22828 |
| 状态管理 | Zustand 4 | `projectStore` / `sessionStore` / `takeStore` / `pickStore` |
| 路由 | React Router 6（`createBrowserRouter` + 懒加载） | nginx 侧配合 `try_files` 做 SPA fallback |
| 本地存储 | Dexie 4（IndexedDB 封装） | 库名 `gbstudiotake-db`，结构版本号 `version(2)` 与 upgrade 迁移（旧数据补修订号并进复核区） |
| 并发控制 | 行级 `editVersion` 乐观锁 | 场次 / Take / 优选保存前比对已读版本，冲突回滚并三方并列差异；同一 IndexedDB 事务内级联失效优选 |
| 容器化 | Docker 多阶段构建：`node:20-alpine` → `nginx:alpine` | 构建阶段执行类型检查与打包，运行阶段仅托管静态产物 |

---

## 三、本地开发方式

```bash
cd frontend
npm install
npm run dev        # 开发服务器 http://localhost:22828
npm run build      # 类型检查 + 生产构建，产物在 frontend/dist
npm run preview    # 本地预览构建产物（http://localhost:22828）
```

---

## 四、页面与路由

| 路由 | 模块 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/projects` | 录音项目与曲目台账 | Project、Song | 新建/编辑/删除项目与曲目（删除确认与级联）、按状态与委托方筛选、卡片回显曲目数 / 场次数 / 已优选 Take 数、筛选同步 URL query |
| `/sessions` | 场次安排与参与乐手 | Session、Song | 按日期与棚号排期、**同棚号同时段冲突真实拦截并列出占用场次**、乐手席位统计、增删改 |
| `/takes` | Take 标记台 | Take、Session | 录入起止时间码（校验先后、重叠提示）、同场次 Take 号自动递增、问题标签与评级、**表格多选批量改评级**、时间码区间筛选 |
| `/picks` | 优选 Take 汇总 | Pick、Take | 从「可用」条次中挑选、**拖拽卡片 + 上下移调整剪接顺序（乐观锁）**、自动生成剪接清单（仅含已确认优选）与合计时长、备注编辑、失效优选一键「重算并确认」 |
| `/review` | 修订复核区 | Session、Take、Pick | **旧数据升级与级联失效数据集中复核**，逐条 / 批量确认（确认同样走乐观锁），并列失效快照与最新 Take |
| `/retakes` | 补录计划与导出 | Retake 及全部模型 | 由问题 Take 一键生成补录、状态流转与完成联动曲目状态、场次记录表导出、本地库版本查看与整库导入导出 |

---

## 五、目录结构

```
sologsb101-1028/
├── README.md
├── docker-compose.yml
├── .env / .env.example
├── .gitignore
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files SPA fallback + gzip
    ├── .dockerignore
    ├── index.html / vite.config.ts / tsconfig.json / package.json
    ├── public/favicon.svg
    └── src/
        ├── main.tsx  App.tsx  vite-env.d.ts
        ├── types/              # project.ts song.ts session.ts take.ts pick.ts retake.ts filter.ts revision.ts
        ├── stores/             # projectStore sessionStore takeStore pickStore
        ├── components/common/  # TakeBadge.tsx FilterBar.tsx StatBadge.tsx EmptyPanel.tsx ReviewStateTag.tsx RevisionConflictAlert.tsx
        ├── hooks/              # useTakeFilter.ts useIdbTable.ts
        ├── utils/              # timecode.ts db.ts export.ts concurrency.ts seed.ts uuid.ts
        ├── pages/              # ProjectList SessionPlan TakeBoard PickSummary ReviewBoard RetakePlan
        ├── styles/main.css
        ├── router/index.tsx    # 路由表（懒加载页面 + App 布局）
        ├── router/routes.ts    # 叶子模块：路径常量与导航配置，切断 App ⇄ router 循环依赖
        └── utils/revision.ts   # 叶子模块：行结构修订号，切断 utils/db ⇄ utils/seed 循环依赖
```

---

## 六、数据存储说明

- **IndexedDB 库名**：`gbstudiotake-db`（Dexie 封装），结构版本号 `version(2)`：v1→v2 的 `upgrade()` 为历史场次 / Take / 优选补齐 `editVersion` / `reviewState` / `reviewReason`，旧数据一律进「待复核」，并为优选按当时的 Take / 场次补齐来源快照（`srcStartTc` / `srcEndTc` / `srcRoomNo` / `srcSessionId`）。
- **分表存储**：`projects` 项目、`songs` 曲目、`sessions` 场次、`takes` 条次、`picks` 优选、`retakes` 补录，共 6 张表；每行带 `revision` / `createdAt` / `updatedAt`；场次 / Take / 优选另带 `editVersion`（乐观锁版本）/ `reviewState`（已确认 / 待复核）/ `reviewReason`。
- **修订保存（乐观并发控制）**：`saveSessionRevision` / `saveTakeRevision` / `savePickRevision` / `reorderPicksRevision` 均在 IndexedDB 事务内重读当前行，`editVersion` 与已读版本不一致即抛 `RevisionConflictError`（携带逐字段三方差异），整笔回滚、不写新版本；确认复核（`confirmXxxRevision`）同样校验版本。
- **优选失效重算**：Take 起止时间码变化、跨场次移动到不同棚号、或场次棚号变化，都会在保存事务内把受影响优选立即置「待复核」并刷新来源快照；剪接清单、优选覆盖率与场次记录表只统计「已确认」优选，确认（`/review` 或优选页内联）后才重新纳入。
- **首屏自动播种**：`utils/db.ts` 的 `initDatabase()` 在 `projects` 表为空时调用 `seedDatabase()`，灌入互相引用的三层演示数据（项目 → 曲目 → 场次 → Take → 优选 / 补录），保证 5 个页面首次打开都有内容；播种幂等，清空后重进会重新播种。
- **时间码规则**：格式 `HH:MM:SS:FF`，帧率 25 帧；`utils/timecode.ts` 提供互转、时长汇总、重叠检测与 Take 号自动递增。
- **无后端**：没有 API 服务、没有数据库容器；容器本身无状态，不挂载任何卷。
- **级联规则**：删除项目级联删除其曲目、场次、Take、优选与补录；删除场次级联删除其 Take 与对应优选。
