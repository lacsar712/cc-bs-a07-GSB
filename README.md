# 桥梁应变班交台

测量员上报跨段编号与微应变读数，后台工人用 `FOR UPDATE SKIP LOCKED` 认领待处理队列，按 **80～220 με** 判定 **合格** 或 **越界**。

## 跨段日历封锁

- 测量员在顶栏「封锁日历」专页为跨段挂起止时刻（时段表），落在封锁窗内的报送一律挡回，并说明**仅封锁窗外才接收报送**。
- 挡回记录与真正拦住捆在**同一次库写入**（同一事务）：命中封锁窗时，该事务只落 `blockade_rejections` 挡回记录、不落 `strain_readings` 读数，少一边即整体失败。
- 封锁判定一律吃**数据库服务器时刻**（SQL `now()`），浏览器本机时间不参与判定；页面上的服务器时刻钟与"生效中"状态均由后端算出。
- 提交页面对生效中封锁的跨段会亮红警示并禁用提交，后台同时照样拦截，两边一致。
- 复核员可看封锁日历与挡回记录，不能挂、改、删封锁（接口层 403）。
- 验收：把当前时刻盖进封锁窗再报 → `409` 挡回且留挡回记录；挪开（删除）该窗后再报 → `201` 入队。

## 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/blockades` | 服务器时刻 + 封锁时段表 + 挡回记录（登录即可看） |
| POST | `/api/blockades` | 挂封锁窗（仅测量员），起止须为带时区 ISO 8601 且 结束>开始 |
| DELETE | `/api/blockades/{id}` | 挪开封锁窗（仅测量员） |
| GET | `/api/spans` | 已知跨段清单（读数 ∪ 封锁窗），供跨段选择 |
| POST | `/api/readings` | 提交读数；命中封锁窗 → `409` + 同事务落挡回记录 |

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
| surveyor | surv123456 | 测量员，可提交读数、挂/删封锁时段 |
| reviewer | rev123456 | 复核员，只读列表、封锁日历与挡回记录 |

## 启动

```bash
cd projects/19-bridge-strain-shift
docker compose up --build
```

健康检查：`GET http://localhost:8198/api/health` → `{"status":"ok","service":"bridge-strain-shift"}`

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
