import os
from datetime import datetime, timedelta, timezone

import jwt
from passlib.context import CryptContext
from sanic import Sanic
from sanic.response import json as sanic_json

from db import create_pool, ensure_schema, seed_if_empty

SECRET = os.environ.get("JWT_SECRET", "bridge-strain-dev-secret")
pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")

USERS = {
    "surveyor": {"role": "writer", "password_hash": pwd.hash("surv123456")},
    "reviewer": {"role": "reader", "password_hash": pwd.hash("rev123456")},
}

app = Sanic("bridge-strain-shift")


def _auth_header(request) -> str | None:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:].strip()
    return None


def _decode_user(token: str | None) -> dict | None:
    if not token:
        return None
    try:
        payload = jwt.decode(token, SECRET, algorithms=["HS256"])
    except jwt.InvalidTokenError:
        return None
    sub = payload.get("sub")
    if sub not in USERS:
        return None
    return {"username": sub, "role": payload.get("role")}


def _require_user(request) -> dict:
    user = _decode_user(_auth_header(request))
    if not user:
        return None
    return user


def _iso(dt) -> str | None:
    if dt is None:
        return None
    return dt.isoformat()


def _fmt(dt) -> str:
    """封锁窗时刻的人类可读格式（含时区偏移）。"""
    return dt.isoformat(sep=" ", timespec="seconds")


def _parse_ts(value):
    """解析 ISO 8601 时刻，必须带时区；非法或缺时区返回 None。"""
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        dt = datetime.fromisoformat(value.strip())
    except ValueError:
        return None
    if dt.tzinfo is None:
        return None
    return dt


@app.before_server_start
async def setup(_app, _loop):
    pool = await create_pool()
    _app.ctx.pool = pool
    await ensure_schema(pool)
    await seed_if_empty(pool)


@app.after_server_stop
async def teardown(_app, _loop):
    pool = _app.ctx.pool
    if pool:
        await pool.close()


@app.get("/api/health")
async def health(_request):
    return sanic_json({"status": "ok", "service": "bridge-strain-shift"})


@app.post("/api/auth/login")
async def login(request):
    body = request.json or {}
    username = str(body.get("username", "")).strip()
    password = str(body.get("password", ""))
    user = USERS.get(username)
    if not user or not pwd.verify(password, user["password_hash"]):
        return sanic_json({"detail": "用户名或密码错误"}, status=401)
    exp = datetime.now(timezone.utc) + timedelta(hours=8)
    token = jwt.encode(
        {"sub": username, "role": user["role"], "exp": exp},
        SECRET,
        algorithm="HS256",
    )
    return sanic_json(
        {"access_token": token, "username": username, "role": user["role"]}
    )


@app.get("/api/readings")
async def list_readings(request):
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id, span_code, microstrain, verdict, reason, status,
                       created_by, created_at, processed_at
                FROM strain_readings
                ORDER BY id DESC
                """
            )
            rows = await cur.fetchall()
    out = []
    for r in rows:
        out.append(
            {
                "id": r["id"],
                "span_code": r["span_code"],
                "microstrain": r["microstrain"],
                "verdict": r["verdict"],
                "reason": r["reason"],
                "status": r["status"],
                "created_by": r["created_by"],
                "created_at": _iso(r["created_at"]),
                "processed_at": _iso(r["processed_at"]),
            }
        )
    return sanic_json(out)


@app.post("/api/readings")
async def create_reading(request):
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    if user["role"] != "writer":
        return sanic_json({"detail": "仅测量员可提交应变读数"}, status=403)
    body = request.json or {}
    span_code = str(body.get("span_code", "")).strip()
    if not span_code:
        return sanic_json({"detail": "跨段编号不能为空"}, status=400)
    try:
        microstrain = float(body.get("microstrain"))
    except (TypeError, ValueError):
        return sanic_json({"detail": "微应变必须是数字"}, status=400)

    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            # 封锁判定吃数据库服务器时刻（now()），与挡回记录捆在同一事务写入：
            # 命中封锁窗 → 同一 commit 里只落挡回记录、不落读数，两边少一边即整体失败。
            await cur.execute(
                """
                SELECT id, starts_at, ends_at
                FROM span_blockades
                WHERE span_code = %s AND starts_at <= now() AND now() < ends_at
                ORDER BY starts_at DESC, id DESC
                LIMIT 1
                """,
                (span_code,),
            )
            block = await cur.fetchone()
            if block:
                reason = (
                    f"跨段 {span_code} 当前处于封锁时段"
                    f"（{_fmt(block['starts_at'])} 至 {_fmt(block['ends_at'])}），"
                    "仅封锁窗外才接收报送"
                )
                await cur.execute(
                    """
                    INSERT INTO blockade_rejections
                        (span_code, microstrain, blockade_id,
                         window_starts_at, window_ends_at,
                         reason, attempted_by, attempted_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, now())
                    """,
                    (
                        span_code,
                        microstrain,
                        block["id"],
                        block["starts_at"],
                        block["ends_at"],
                        reason,
                        user["username"],
                    ),
                )
                await conn.commit()
                return sanic_json(
                    {
                        "detail": reason,
                        "blocked": True,
                        "blockade": {
                            "id": block["id"],
                            "starts_at": _iso(block["starts_at"]),
                            "ends_at": _iso(block["ends_at"]),
                        },
                    },
                    status=409,
                )
            await cur.execute(
                """
                INSERT INTO strain_readings (span_code, microstrain, status, created_by, created_at)
                VALUES (%s, %s, 'pending', %s, now())
                RETURNING id, span_code, microstrain, verdict, reason, status,
                          created_by, created_at, processed_at
                """,
                (span_code, microstrain, user["username"]),
            )
            row = await cur.fetchone()
        await conn.commit()

    return sanic_json(
        {
            "id": row["id"],
            "span_code": row["span_code"],
            "microstrain": row["microstrain"],
            "verdict": row["verdict"],
            "reason": row["reason"],
            "status": row["status"],
            "created_by": row["created_by"],
            "created_at": _iso(row["created_at"]),
            "processed_at": None,
            "message": "已入队，后台工人将认领并判定",
        },
        status=201,
    )


def _blockade_json(r) -> dict:
    return {
        "id": r["id"],
        "span_code": r["span_code"],
        "starts_at": _iso(r["starts_at"]),
        "ends_at": _iso(r["ends_at"]),
        "note": r["note"],
        "created_by": r["created_by"],
        "created_at": _iso(r["created_at"]),
        "phase": r["phase"],
        "active": r["phase"] == "生效中",
    }


def _rejection_json(r) -> dict:
    return {
        "id": r["id"],
        "span_code": r["span_code"],
        "microstrain": r["microstrain"],
        "blockade_id": r["blockade_id"],
        "window_starts_at": _iso(r["window_starts_at"]),
        "window_ends_at": _iso(r["window_ends_at"]),
        "reason": r["reason"],
        "attempted_by": r["attempted_by"],
        "attempted_at": _iso(r["attempted_at"]),
    }


@app.get("/api/blockades")
async def list_blockades(request):
    """封锁日历：时段表 + 挡回记录。生效状态由数据库服务器时刻算出，复核员只读可看。"""
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT now() AS server_now")
            server_now = (await cur.fetchone())["server_now"]
            await cur.execute(
                """
                SELECT id, span_code, starts_at, ends_at, note, created_by, created_at,
                       CASE WHEN now() < starts_at THEN '未开始'
                            WHEN now() >= ends_at THEN '已结束'
                            ELSE '生效中' END AS phase
                FROM span_blockades
                ORDER BY starts_at DESC, id DESC
                """
            )
            blockades = [_blockade_json(r) for r in await cur.fetchall()]
            await cur.execute(
                """
                SELECT id, span_code, microstrain, blockade_id,
                       window_starts_at, window_ends_at,
                       reason, attempted_by, attempted_at
                FROM blockade_rejections
                ORDER BY id DESC
                """
            )
            rejections = [_rejection_json(r) for r in await cur.fetchall()]
    return sanic_json(
        {
            "server_now": _iso(server_now),
            "blockades": blockades,
            "rejections": rejections,
        }
    )


@app.post("/api/blockades")
async def create_blockade(request):
    """测量员为跨段挂封锁起止时刻。"""
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    if user["role"] != "writer":
        return sanic_json({"detail": "仅测量员可挂封锁时段"}, status=403)
    body = request.json or {}
    span_code = str(body.get("span_code", "")).strip()
    if not span_code:
        return sanic_json({"detail": "跨段编号不能为空"}, status=400)
    starts_at = _parse_ts(body.get("starts_at"))
    ends_at = _parse_ts(body.get("ends_at"))
    if starts_at is None or ends_at is None:
        return sanic_json(
            {"detail": "起止时刻必须是带时区的 ISO 8601 时间"}, status=400
        )
    if ends_at <= starts_at:
        return sanic_json({"detail": "结束时刻必须晚于开始时刻"}, status=400)
    note = str(body.get("note", "")).strip()

    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO span_blockades
                    (span_code, starts_at, ends_at, note, created_by, created_at)
                VALUES (%s, %s, %s, %s, %s, now())
                RETURNING id, span_code, starts_at, ends_at, note, created_by, created_at,
                          CASE WHEN now() < starts_at THEN '未开始'
                               WHEN now() >= ends_at THEN '已结束'
                               ELSE '生效中' END AS phase
                """,
                (span_code, starts_at, ends_at, note, user["username"]),
            )
            row = await cur.fetchone()
        await conn.commit()
    return sanic_json(_blockade_json(row), status=201)


@app.delete("/api/blockades/<blockade_id:int>")
async def delete_blockade(request, blockade_id: int):
    """测量员挪开（删除）封锁时段；挡回记录里已快照窗时刻，不受影响。"""
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    if user["role"] != "writer":
        return sanic_json({"detail": "仅测量员可调整封锁时段"}, status=403)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "DELETE FROM span_blockades WHERE id = %s RETURNING id",
                (blockade_id,),
            )
            row = await cur.fetchone()
        await conn.commit()
    if not row:
        return sanic_json({"detail": "封锁时段不存在"}, status=404)
    return sanic_json({"deleted": row["id"]})


@app.get("/api/spans")
async def list_spans(request):
    """已知跨段编号（读数与封锁时段的并集），供跨段选择。"""
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT DISTINCT span_code FROM (
                    SELECT span_code FROM strain_readings
                    UNION
                    SELECT span_code FROM span_blockades
                ) t
                ORDER BY span_code
                """
            )
            rows = await cur.fetchall()
    return sanic_json([r["span_code"] for r in rows])
