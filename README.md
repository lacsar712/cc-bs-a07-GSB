# 桥梁应变班交台

测量员上报跨段编号与微应变读数，后台工人用 `FOR UPDATE SKIP LOCKED` 认领待处理队列，按 **80～220 με** 判定 **合格** 或 **越界**。

测量员还可在**封锁日历**专页按跨段挂起止时刻：服务器时刻落在封锁窗内的报送一律挡回，窗外才收。封锁判断只吃 PostgreSQL 服务器时刻（`now()`），不采信浏览器本机时间；挡回与挡回记录在同一条 SQL、同一事务内完成，缺一边即整体失败。


## 技术栈

| 层 | 选型 |
|----|------|
| 接口 | Python Sanic + psycopg（异步连接池） |
| 工人 | `worker.py`（psycopg 同步，`FOR UPDATE SKIP LOCKED`） |
| 页面 | Mithril.js + Vite，nginx 反代 `/api` |
| 数据库 | PostgreSQL 16 |

## 端口

| 服务 | 地址 |
|------|------|
| 页面 | http://localhost:3198 |
| 接口 | http://localhost:8198 |
| PostgreSQL | localhost:54398（库名 `bridgestrain`） |

## 账号

| 用户 | 密码 | 权限 |
|------|------|------|
| surveyor | surv123456 | 测量员，可提交读数 |
| reviewer | rev123456 | 复核员，只读列表 |

## 启动

```bash
cd projects/19-bridge-strain-shift
docker compose up --build
```

健康检查：`GET http://localhost:8198/api/health` → `{"status":"ok","service":"bridge-strain-shift"}`

## 封锁日历

顶栏「封锁日历」进入专页，含**跨段选择 + 起止时刻**挂表单元、**封锁时段表**、**封锁挡回记录**与服务器时刻。

| 能力 | 测量员 surveyor | 复核员 reviewer |
|------|----------------|----------------|
| 挂 / 改 / 删封锁时段 | ✅ | ❌（后台 403） |
| 查看时段表、挡回记录、服务器时刻 | ✅ | ✅ |
| 提交读数 | ✅ | ❌ |

- 窗内报送：界面按服务器数据把提交按钮置为「封锁中」并亮横幅说明**封锁窗外才收**；即便绕过界面强提，后台仍返回 **409**，且 `strain_readings` 不产生任何行。
- 原子性：`POST /api/readings` 用单条 `INSERT ... SELECT ... WHERE now() 落窗` 写 `blockade_rejections`，与拦截判定同一事务；挡回记录写不进去则整个请求 500，报送绝不放行（已用触发器故障注入验证）。
- 服务器时刻：`GET /api/server-time` 与 `GET /api/blockades` 返回的 `server_time` 均来自 PostgreSQL `now()`。

接口：

| 方法与路径 | 说明 |
|-----------|------|
| `GET /api/server-time` | 服务器当前时刻 |
| `GET /api/blockades` | 时段（含 `active`）、最近 200 条挡回记录、`server_time`、`can_edit` |
| `POST /api/blockades` | 挂时段（body：`span_code`、`starts_at`、`ends_at`，均须带时区偏移） |
| `PATCH /api/blockades/{id}` | 改时段（字段任意组合，结束须晚于起始，否则 400） |
| `DELETE /api/blockades/{id}` | 删时段；挡回记录保留，`blockade_id` 置空 |

新增表：`span_blockades`（封锁时段）、`blockade_rejections`（挡回记录，含窗区间与判定用服务器时刻）。

## 种子数据

| 跨段 | 微应变 | 结论 |
|------|--------|------|
| 跨中S1 | 150 με | 合格 |
| 支座S2 | 40 με | 越界 |

## 本地开发（可选）

```bash
cd backend && pip install -r requirements.txt
python -m sanic api.app --host=0.0.0.0 --port=8000 --single-process
python worker.py
cd frontend && npm install && npm run dev
```

接口进程默认监听容器内 **8000**，对外映射 **8198**。
