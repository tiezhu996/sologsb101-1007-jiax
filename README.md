# 尾矿库坝体位移与浸润线监测台（sologsb101-1007）

面向尾矿库安全监测与库区安全管理岗位，按坝体断面布设表面位移、测斜、浸润线与渗压测点，逐次录入观测值并对超阈值测点触发预警与处置跟踪。核心动作：建坝与断面、布测点配阈值、录观测值、算累计位移与日速率、触发预警闭环、记录库水位与干滩长度。

> 纯前端单页应用（SPA）：**无后端 / 无数据库服务 / 无 API**，全部数据保存在浏览器本地 IndexedDB。

## 一、Docker 一键启动（推荐）

在项目根目录（本 README 所在目录）执行：

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22807**

常用运维命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 日志
docker compose down               # 停止并删除容器
docker compose up -d --build      # 改代码后重新构建启动
```

如需更换宿主端口，修改 `.env` 中的 `FRONTEND_PORT` 后重新 `docker compose up -d`。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | React 18.3 | 函数组件 + Hooks |
| 语言 | TypeScript 5.7 | `strict` 严格模式，构建前执行 `tsc --noEmit` |
| UI 组件 | Ant Design 5 | 表格、表单、Modal、Drawer、Tag、Descriptions |
| 状态管理 | Zustand 4.5 | `damStore` / `pointStore` / `alarmStore`（模块级 liveQuery 订阅回流） |
| 路由 | React Router 6.28 | `createBrowserRouter`，nginx `try_files` 回退 |
| 本地持久化 | Dexie 4（IndexedDB） | 版本号 + `upgrade` 迁移 + 幂等播种 |
| 构建 | Vite 6 | 输出 `dist/`，按路由自动分包 |
| 运行 | nginx:alpine | 静态托管 + gzip + SPA 回退 |

## 三、目录结构

```
sologsb101-1007/
├── README.md
├── docker-compose.yml          # 不写 version；顶层 name: gbtaildam
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files $uri $uri/ /index.html + gzip
    ├── .dockerignore
    ├── package.json / tsconfig.json / vite.config.ts / index.html
    ├── public/favicon.svg
    └── src/
        ├── types/              # dam.ts section.ts point.ts observation.ts alarm.ts pool.ts waterPacket.ts jointRisk.ts
        ├── stores/             # damStore.ts pointStore.ts alarmStore.ts reconcileStore.ts
        ├── components/common/  # AlarmTag.ts JointRiskTag.tsx FilterBar.tsx StatBadge.tsx EmptyPanel.tsx
        ├── hooks/              # useAlarmLevel.ts useIdbTable.ts
        ├── pages/              # DamList.tsx PointConfig.tsx ObservationEntry.tsx TrendBoard.tsx AlarmBoard.tsx PoolLog.tsx ReconcileBoard.tsx
        ├── router/index.tsx
        ├── utils/              # threshold.ts db.ts export.ts reconcile.ts
        ├── styles/main.css
        ├── App.tsx
        └── main.tsx
```

## 四、页面与路由

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/dams` | 坝体与断面台账 | Dam、Section | 新建/编辑/删除坝体与断面；按坝型、等别筛选；卡片回显测点数与未闭环预警数 |
| `/points` | 测点布设与阈值配置 | Point、Section | 按断面批量布点；逐点改写初值与阈值（草稿 → 逐条/批量提交）；显示最新累计变化与占阈值比 |
| `/observations` | 位移/浸润线观测录入 | Observation、Point | 选定测点按日期录入读数（自动算累计量与日速率）；实时预警级别预览；一键生成预警单 |
| `/trends` | 累计位移与沉降速率计算 | Observation、Point | 按占阈值比降序排行；仅看越限；抽屉查看历次观测序列；按最新观测生成预警单 |
| `/alarms` | 预警触发与处置闭环 | Alarm、Point、Observation | 按级别（红>橙>黄>蓝）排序；状态流转 待处置→处置中→已闭环；填写处置人与措施 |
| `/pool` | 干滩长度与库水位记录 | Pool、Dam | 按日登记水位/干滩/超高并自动校核；导出 CSV、导出结构版本、重置演示数据 |
| `/reconcile` | 库水位回传包对账与橙色联合风险 | WaterPacket、JointRisk、Pool、Dam | 接收水文站晚到回传包，按坝体与测次时间对账；断点续传、同包幂等；异常测次留待确认；日涨幅合并橙色联合风险并自动解除 |

## 五、数据存储说明

- **IndexedDB 库名**：`gbtaildam`（Dexie 封装，`src/utils/db.ts`）
- **对象表**：`dams`、`sections`、`points`、`observations`、`alarms`、`pools`、`waterpackets`、`jointrisks`
- **数据结构版本**：`DB_VERSION = 3`，含 `version(1)` → `version(2)` → `version(3)` 的索引变更与 `upgrade()` 迁移：v2 补齐 `revision`、回填 `damId`；v3 新增回传包/联合风险两表，旧库水位行补 `source='现场'`
- **首屏自动播种**：`initDatabase()` 中 `if (await db.dams.count() === 0) await seedDatabase()`，播种 2 座坝体 → 4 个断面 → 9 个测点 → 21 条观测 → 6 张预警 → 6 条库水位记录 → 2 个回传包（1 个对账中断、1 个待对账）→ 1 张生效中橙色联合风险的完整父子孙链条；播种幂等
- **localStorage 辅助键**：`gbtaildam:db-version`、`gbtaildam:last-backup-at`、`gbtaildam:ui-prefs`
- 应用为**无状态容器**：数据不落容器磁盘、不使用数据库服务、不挂载命名卷

## 六、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22807
npm run build      # tsc --noEmit && vite build（类型检查 + 生产构建）
npm run preview    # 本地预览构建产物
```

## 七、判定口径

- 累计变化量 `= 读数 − 初值`；日速率 `= |本次读数 − 上次读数| ÷ 间隔天数`
- 比值 `= |累计变化量| ÷ 阈值`；分级：`≥0.70` 蓝、`≥0.85` 黄、`≥1.00` 橙、`≥1.30` 红
- 干滩长度达标下限 `100 m`，安全超高达标下限 `1.5 m`

## 八、回传包对账与橙色联合风险口径

- 水文站库水位晚于现场浸润线观测数小时回传：**回传包只提供水位事实**，监测台管观测与处置，两边按「坝体 + 测次时间」对账。
- **日涨幅** `=（本次库水位 − 上一水位事实）÷ 间隔天数`；`≥ 0.5 m/d` 且该坝存在**未闭环浸润线预警**（待处置/处置中）时，合并开出一张**橙色联合风险单**（幂等键 `damId@触发日期`，同一坝体同一日不重复开单）。
- **解除**：最新库水位较触发水位回落 `≥ 0.5 m`，或被合并预警测点在预警触发日之后有恢复正常（低于蓝级）的新观测，即自动解除；也可人工解除。解除只作用于联合风险单，**不改写原预警、观测与处置**。
- **断点续传**：对账中断后重开，从回传包 `lastConfirmedSeq`（最后确认测次）之后继续；同一包号再送**不重复开单**，只续对。
- **待确认隔离**：单位非 `m`、或同测次出现两个版本（报文内或与现场/他包冲突）→ 测次停在「待确认」，不写水位事实、**观测和处置先不动**；人工裁决（统一单位后采用 / 作废）再从断点继续。
