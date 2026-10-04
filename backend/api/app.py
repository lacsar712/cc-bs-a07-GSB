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


def _require_user(request) -> dict | None:
    return _decode_user(_auth_header(request))


def _iso(dt) -> str | None:
    if dt is None:
        return None
    return dt.isoformat()


def _parse_dt(value, field: str) -> datetime:
    """解析前端传入的时刻，必须带时区；封锁判断只认服务器时钟，入参须为绝对时刻。"""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field}不能为空")
    text = value.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError as exc:
        raise ValueError(f"{field}时间格式无法识别") from exc
    if dt.tzinfo is None or dt.utcoffset() is None:
        raise ValueError(f"{field}必须带时区偏移（如 2026-10-03T10:00:00+08:00）")
    return dt


def _fmt_local(dt: datetime) -> str:
    """把 UTC 时刻按北京时间格式化，用于提示文案。"""
    local = dt.astimezone(timezone(timedelta(hours=8)))
    return local.strftime("%Y-%m-%d %H:%M:%S")


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


@app.get("/api/server-time")
async def server_time(request):
    """供界面校准用的服务器时刻；封锁判断从不采信浏览器本机时间。"""
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT now() AS now_at")
            row = await cur.fetchone()
    return sanic_json({"server_time": _iso(row["now_at"])})


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
            # 封锁判断与挡回记录是同一条 SQL、同一事务：
            # 仅当 now()（PostgreSQL 服务器时刻）落在该跨段某个封锁窗内时，
            # 才向 blockade_rejections 写入一行；写不出行才允许入库报送。
            # 任一环节失败整体回滚，不可能出现“拦了没记”或“记了放行”。
            await cur.execute(
                """
                WITH hit AS (
                    SELECT id AS blockade_id, starts_at, ends_at
                    FROM span_blockades
                    WHERE span_code = %s
                      AND starts_at <= now()
                      AND ends_at > now()
                    ORDER BY starts_at DESC
                    LIMIT 1
                )
                INSERT INTO blockade_rejections
                    (blockade_id, span_code, microstrain, submitted_by,
                     window_start, window_end, server_time)
                SELECT blockade_id, %s, %s, %s, starts_at, ends_at, now()
                FROM hit
                RETURNING id, blockade_id, window_start, window_end, server_time
                """,
                (span_code, span_code, microstrain, user["username"]),
            )
            blocked = await cur.fetchone()

            if blocked is None:
                await cur.execute(
                    """
                    INSERT INTO strain_readings
                        (span_code, microstrain, status, created_by, created_at)
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
                        "blocked": False,
                        "message": "已入队，后台工人将认领并判定",
                    },
                    status=201,
                )

            await conn.commit()

    detail = (
        f"跨段「{span_code}」正处于封锁时段"
        f"（{_fmt_local(blocked['window_start'])} 至 "
        f"{_fmt_local(blocked['window_end'])}，北京时间），"
        f"封锁窗外才收；本次报送已挡回并记录，服务器时刻 "
        f"{_fmt_local(blocked['server_time'])}"
    )
    return sanic_json(
        {
            "detail": detail,
            "blocked": True,
            "blockade_id": blocked["blockade_id"],
            "window_start": _iso(blocked["window_start"]),
            "window_end": _iso(blocked["window_end"]),
            "server_time": _iso(blocked["server_time"]),
        },
        status=409,
    )


def _blockade_dict(r) -> dict:
    return {
        "id": r["id"],
        "span_code": r["span_code"],
        "starts_at": _iso(r["starts_at"]),
        "ends_at": _iso(r["ends_at"]),
        "created_by": r["created_by"],
        "created_at": _iso(r["created_at"]),
        "active": r["active"],
    }


@app.get("/api/blockades")
async def list_blockades(request):
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            # now() 在同一事务内为固定值，active 判断与 server_time 同源
            await cur.execute("SELECT now() AS now_at")
            now_at = (await cur.fetchone())["now_at"]
            await cur.execute(
                """
                SELECT id, span_code, starts_at, ends_at, created_by, created_at,
                       (starts_at <= now() AND ends_at > now()) AS active
                FROM span_blockades
                ORDER BY starts_at DESC, id DESC
                """
            )
            blockades = [_blockade_dict(r) for r in await cur.fetchall()]
            await cur.execute(
                """
                SELECT id, blockade_id, span_code, microstrain, submitted_by,
                       window_start, window_end, rejected_at, server_time
                FROM blockade_rejections
                ORDER BY id DESC
                LIMIT 200
                """
            )
            rejections = []
            for r in await cur.fetchall():
                rejections.append(
                    {
                        "id": r["id"],
                        "blockade_id": r["blockade_id"],
                        "span_code": r["span_code"],
                        "microstrain": r["microstrain"],
                        "submitted_by": r["submitted_by"],
                        "window_start": _iso(r["window_start"]),
                        "window_end": _iso(r["window_end"]),
                        "rejected_at": _iso(r["rejected_at"]),
                        "server_time": _iso(r["server_time"]),
                    }
                )
    return sanic_json(
        {
            "server_time": _iso(now_at),
            "can_edit": user["role"] == "writer",
            "blockades": blockades,
            "rejections": rejections,
        }
    )


@app.post("/api/blockades")
async def create_blockade(request):
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    if user["role"] != "writer":
        return sanic_json({"detail": "仅测量员可挂封锁时段，复核员只读"}, status=403)
    body = request.json or {}
    span_code = str(body.get("span_code", "")).strip()
    if not span_code:
        return sanic_json({"detail": "跨段编号不能为空"}, status=400)
    try:
        starts_at = _parse_dt(body.get("starts_at"), "起始时刻")
        ends_at = _parse_dt(body.get("ends_at"), "结束时刻")
    except ValueError as exc:
        return sanic_json({"detail": str(exc)}, status=400)
    if ends_at <= starts_at:
        return sanic_json({"detail": "结束时刻必须晚于起始时刻"}, status=400)

    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO span_blockades (span_code, starts_at, ends_at, created_by)
                VALUES (%s, %s, %s, %s)
                RETURNING id, span_code, starts_at, ends_at, created_by, created_at,
                          (starts_at <= now() AND ends_at > now()) AS active
                """,
                (span_code, starts_at, ends_at, user["username"]),
            )
            row = await cur.fetchone()
        await conn.commit()
    return sanic_json(_blockade_dict(row), status=201)


@app.patch("/api/blockades/<bid:int>")
async def update_blockade(request, bid: int):
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    if user["role"] != "writer":
        return sanic_json({"detail": "仅测量员可改封锁时段，复核员只读"}, status=403)
    body = request.json or {}
    try:
        starts_at = (
            _parse_dt(body.get("starts_at"), "起始时刻")
            if body.get("starts_at") is not None
            else None
        )
        ends_at = (
            _parse_dt(body.get("ends_at"), "结束时刻")
            if body.get("ends_at") is not None
            else None
        )
    except ValueError as exc:
        return sanic_json({"detail": str(exc)}, status=400)
    span_code = body.get("span_code")
    if span_code is not None:
        span_code = str(span_code).strip()
        if not span_code:
            return sanic_json({"detail": "跨段编号不能为空"}, status=400)

    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT span_code, starts_at, ends_at
                FROM span_blockades
                WHERE id = %s
                FOR UPDATE
                """,
                (bid,),
            )
            current = await cur.fetchone()
            if current is None:
                return sanic_json({"detail": "封锁时段不存在"}, status=404)
            new_span = span_code if span_code is not None else current["span_code"]
            new_start = (
                starts_at if starts_at is not None else current["starts_at"]
            )
            new_end = ends_at if ends_at is not None else current["ends_at"]
            if new_end <= new_start:
                return sanic_json(
                    {"detail": "结束时刻必须晚于起始时刻"}, status=400
                )
            await cur.execute(
                """
                UPDATE span_blockades SET
                    span_code = %s,
                    starts_at = %s,
                    ends_at = %s
                WHERE id = %s
                RETURNING id, span_code, starts_at, ends_at, created_by, created_at,
                          (starts_at <= now() AND ends_at > now()) AS active
                """,
                (new_span, new_start, new_end, bid),
            )
            row = await cur.fetchone()
        await conn.commit()
    return sanic_json(_blockade_dict(row))


@app.delete("/api/blockades/<bid:int>")
async def delete_blockade(request, bid: int):
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    if user["role"] != "writer":
        return sanic_json({"detail": "仅测量员可删封锁时段，复核员只读"}, status=403)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "DELETE FROM span_blockades WHERE id = %s RETURNING id", (bid,)
            )
            row = await cur.fetchone()
        if row is None:
            await conn.rollback()
            return sanic_json({"detail": "封锁时段不存在"}, status=404)
        await conn.commit()
    return sanic_json({"deleted": bid})
