import m from "mithril";

const TOKEN_KEY = "bridge_strain_token";
const USER_KEY = "bridge_strain_user";

function verdictClass(verdict, status) {
  if (verdict === "合格") return "tag pass";
  if (verdict === "越界") return "tag fail";
  if (status === "pending" || status === "processing") return "tag wait";
  return "tag wait";
}

function displayVerdict(row) {
  if (row.verdict) return row.verdict;
  if (row.status === "pending") return "待处理";
  if (row.status === "processing") return "处理中";
  return "—";
}

function phaseClass(phase) {
  if (phase === "生效中") return "tag fail";
  if (phase === "未开始") return "tag wait";
  return "tag done";
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { hour12: false });
}

const state = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  user: null,
  page: "readings",
  loginForm: { username: "surveyor", password: "surv123456" },
  submitForm: { span_code: "", microstrain: "" },
  blockadeForm: { span_code: "", starts_at: "", ends_at: "", note: "" },
  rows: [],
  spans: [],
  blockades: [],
  rejections: [],
  serverNowBase: null,
  error: "",
  msg: "",
  blockadeError: "",
  blockadeMsg: "",
  loading: false,
  timer: null,
  clockTimer: null,
};

try {
  state.user = JSON.parse(localStorage.getItem(USER_KEY) || "null");
} catch {
  state.user = null;
}

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { ...opts, headers });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { detail: text };
  }
  if (!res.ok) throw new Error(data.detail || res.statusText);
  return data;
}

async function loadReadings() {
  if (!state.token) return;
  try {
    state.rows = await api("/api/readings");
    state.error = "";
  } catch {
    state.error = "加载列表失败，请重新登录";
  }
}

async function loadBlockades() {
  if (!state.token) return;
  try {
    const data = await api("/api/blockades");
    state.blockades = data.blockades || [];
    state.rejections = data.rejections || [];
    state.serverNowBase = {
      server: Date.parse(data.server_now),
      client: Date.now(),
    };
  } catch {
    // 保留旧数据，下一轮轮询再试
  }
}

async function loadSpans() {
  if (!state.token) return;
  try {
    state.spans = await api("/api/spans");
  } catch {
    // 保留旧数据
  }
}

async function loadAll() {
  await Promise.all([loadReadings(), loadBlockades(), loadSpans()]);
  m.redraw();
}

function startPolling() {
  if (state.timer) clearInterval(state.timer);
  if (!state.token) return;
  state.timer = setInterval(loadAll, 3000);
}

// 服务器时刻 = 上次取回的服务器时刻 + 本机流逝量，仅用于展示；
// 真正的封锁判定在后台用数据库 now() 完成。
function serverNow() {
  if (!state.serverNowBase) return null;
  return new Date(
    state.serverNowBase.server + (Date.now() - state.serverNowBase.client)
  );
}

function activeBlockadeFor(spanCode) {
  const code = (spanCode || "").trim();
  if (!code) return null;
  return state.blockades.find((b) => b.span_code === code && b.active) || null;
}

async function submitReading(e) {
  e.preventDefault();
  state.error = "";
  state.msg = "";
  if (activeBlockadeFor(state.submitForm.span_code)) {
    state.error = "该跨段当前处于封锁时段，仅封锁窗外才接收报送";
    return;
  }
  state.loading = true;
  try {
    const data = await api("/api/readings", {
      method: "POST",
      body: JSON.stringify({
        span_code: state.submitForm.span_code,
        microstrain: parseFloat(state.submitForm.microstrain),
      }),
    });
    state.msg = data.message || "已提交";
    state.submitForm = { span_code: "", microstrain: "" };
    await loadAll();
  } catch (err) {
    state.error = err.message || "提交失败";
    await loadBlockades();
  } finally {
    state.loading = false;
    m.redraw();
  }
}

async function createBlockade(e) {
  e.preventDefault();
  state.blockadeError = "";
  state.blockadeMsg = "";
  if (!state.blockadeForm.span_code) {
    state.blockadeError = "请选择跨段";
    return;
  }
  if (!state.blockadeForm.starts_at || !state.blockadeForm.ends_at) {
    state.blockadeError = "请填写起止时刻";
    return;
  }
  state.loading = true;
  try {
    await api("/api/blockades", {
      method: "POST",
      body: JSON.stringify({
        span_code: state.blockadeForm.span_code,
        starts_at: new Date(state.blockadeForm.starts_at).toISOString(),
        ends_at: new Date(state.blockadeForm.ends_at).toISOString(),
        note: state.blockadeForm.note,
      }),
    });
    state.blockadeMsg = "已挂起封锁时段";
    state.blockadeForm = { span_code: "", starts_at: "", ends_at: "", note: "" };
    await loadBlockades();
  } catch (err) {
    state.blockadeError = err.message || "保存失败";
  } finally {
    state.loading = false;
    m.redraw();
  }
}

async function removeBlockade(id) {
  state.blockadeError = "";
  state.blockadeMsg = "";
  try {
    await api(`/api/blockades/${id}`, { method: "DELETE" });
    state.blockadeMsg = "已挪开（删除）封锁时段";
    await loadBlockades();
  } catch (err) {
    state.blockadeError = err.message || "删除失败";
  }
  m.redraw();
}

function loginView() {
  return m("div.wrap", [
    m("h1", "桥梁应变班交台"),
    m(
      "p.sub",
      "测量员提交跨段编号与微应变读数，后台工人认领队列后判定合格或越界。"
    ),
    m("div.card", [
      m(
        "form",
        {
          onsubmit: async (e) => {
            e.preventDefault();
            state.error = "";
            state.loading = true;
            try {
              const data = await api("/api/auth/login", {
                method: "POST",
                body: JSON.stringify(state.loginForm),
              });
              state.token = data.access_token;
              state.user = { username: data.username, role: data.role };
              localStorage.setItem(TOKEN_KEY, state.token);
              localStorage.setItem(USER_KEY, JSON.stringify(state.user));
              await loadAll();
              startPolling();
            } catch {
              state.error = "用户名或密码错误";
            } finally {
              state.loading = false;
              m.redraw();
            }
          },
        },
        [
          m("div.row", [
            m("label", [
              "用户名",
              m("input", {
                value: state.loginForm.username,
                oninput: (e) => {
                  state.loginForm.username = e.target.value;
                },
              }),
            ]),
            m("label", [
              "密码",
              m("input", {
                type: "password",
                value: state.loginForm.password,
                oninput: (e) => {
                  state.loginForm.password = e.target.value;
                },
              }),
            ]),
            m(
              "button",
              { type: "submit", disabled: state.loading },
              "登录"
            ),
          ]),
          state.error ? m("p.err", state.error) : null,
        ]
      ),
      m(
        "p.sub",
        { style: { marginBottom: 0 } },
        "测量员 surveyor / surv123456 · 复核员 reviewer / rev123456"
      ),
    ]),
  ]);
}

function readingsPage(isWriter) {
  const blocked = activeBlockadeFor(state.submitForm.span_code);
  return [
    isWriter
      ? m("div.card", [
          m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "提交读数"),
          m("form", { onsubmit: submitReading }, [
            m("div.row", [
              m("label", [
                "跨段编号",
                m("input", {
                  required: true,
                  placeholder: "例如 跨中S3",
                  list: "span-options",
                  value: state.submitForm.span_code,
                  oninput: (e) => {
                    state.submitForm.span_code = e.target.value;
                  },
                }),
                m(
                  "datalist",
                  { id: "span-options" },
                  state.spans.map((s) => m("option", { value: s, key: s }))
                ),
              ]),
              m("label", [
                "微应变（με）",
                m("input", {
                  required: true,
                  type: "number",
                  step: "0.1",
                  value: state.submitForm.microstrain,
                  oninput: (e) => {
                    state.submitForm.microstrain = e.target.value;
                  },
                }),
              ]),
              m(
                "button",
                { type: "submit", disabled: state.loading || !!blocked },
                "提交"
              ),
            ]),
            blocked
              ? m(
                  "p.err",
                  `跨段 ${blocked.span_code} 当前处于封锁时段（${fmtTime(
                    blocked.starts_at
                  )} 至 ${fmtTime(blocked.ends_at)}），仅封锁窗外才接收报送`
                )
              : null,
            state.error ? m("p.err", state.error) : null,
            state.msg ? m("p.ok", state.msg) : null,
          ]),
        ])
      : null,
    m("div.card", [
      m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "读数列表"),
      m("table", [
        m("thead", [
          m("tr", [
            m("th", "编号"),
            m("th", "跨段"),
            m("th", "微应变"),
            m("th", "结论"),
            m("th", "说明"),
            m("th", "状态"),
            m("th", "提交人"),
          ]),
        ]),
        m(
          "tbody",
          state.rows.length
            ? state.rows.map((r) =>
                m("tr", { key: r.id }, [
                  m("td", r.id),
                  m("td", r.span_code),
                  m("td", r.microstrain),
                  m("td", [
                    m(
                      "span",
                      { class: verdictClass(r.verdict, r.status) },
                      displayVerdict(r)
                    ),
                  ]),
                  m("td", r.reason || "—"),
                  m("td", r.status),
                  m("td", r.created_by),
                ])
              )
            : [m("tr", m("td", { colspan: 7 }, "暂无数据"))]
        ),
      ]),
    ]),
  ];
}

function blockadesPage(isWriter) {
  const now = serverNow();
  return [
    m("div.card", [
      m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "服务器时刻"),
      m(
        "p.clock",
        now ? now.toLocaleString("zh-CN", { hour12: false }) : "…"
      ),
      m(
        "p.sub",
        { style: { marginBottom: 0 } },
        "封锁判定一律以服务器时刻为准，浏览器本机时间不参与判定。"
      ),
    ]),
    isWriter
      ? m("div.card", [
          m(
            "h2",
            { style: { marginTop: 0, fontSize: "1.1rem" } },
            "新增封锁时段"
          ),
          m("form", { onsubmit: createBlockade }, [
            m("div.row", [
              m("label", [
                "跨段选择",
                m(
                  "select",
                  {
                    value: state.blockadeForm.span_code,
                    onchange: (e) => {
                      state.blockadeForm.span_code = e.target.value;
                    },
                  },
                  [
                    m("option", { value: "" }, "— 请选择跨段 —"),
                    state.spans.map((s) =>
                      m("option", { value: s, key: s }, s)
                    ),
                  ]
                ),
              ]),
              m("label", [
                "开始时刻",
                m("input", {
                  type: "datetime-local",
                  required: true,
                  value: state.blockadeForm.starts_at,
                  oninput: (e) => {
                    state.blockadeForm.starts_at = e.target.value;
                  },
                }),
              ]),
              m("label", [
                "结束时刻",
                m("input", {
                  type: "datetime-local",
                  required: true,
                  value: state.blockadeForm.ends_at,
                  oninput: (e) => {
                    state.blockadeForm.ends_at = e.target.value;
                  },
                }),
              ]),
              m("label", [
                "备注",
                m("input", {
                  placeholder: "可选",
                  value: state.blockadeForm.note,
                  oninput: (e) => {
                    state.blockadeForm.note = e.target.value;
                  },
                }),
              ]),
              m(
                "button",
                { type: "submit", disabled: state.loading },
                "挂起封锁"
              ),
            ]),
            state.spans.length
              ? null
              : m(
                  "p.sub",
                  "暂无已知跨段，可先在「读数报送」页提交一条读数后再来挂封锁。"
                ),
            state.blockadeError ? m("p.err", state.blockadeError) : null,
            state.blockadeMsg ? m("p.ok", state.blockadeMsg) : null,
          ]),
        ])
      : null,
    m("div.card", [
      m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "封锁时段表"),
      m("table", [
        m("thead", [
          m("tr", [
            m("th", "跨段"),
            m("th", "开始时刻"),
            m("th", "结束时刻"),
            m("th", "状态"),
            m("th", "备注"),
            m("th", "挂起人"),
            isWriter ? m("th", "操作") : null,
          ]),
        ]),
        m(
          "tbody",
          state.blockades.length
            ? state.blockades.map((b) =>
                m("tr", { key: b.id }, [
                  m("td", b.span_code),
                  m("td", fmtTime(b.starts_at)),
                  m("td", fmtTime(b.ends_at)),
                  m("td", [m("span", { class: phaseClass(b.phase) }, b.phase)]),
                  m("td", b.note || "—"),
                  m("td", b.created_by),
                  isWriter
                    ? m(
                        "td",
                        m(
                          "button.secondary",
                          {
                            type: "button",
                            onclick: () => removeBlockade(b.id),
                          },
                          "删除"
                        )
                      )
                    : null,
                ])
              )
            : [
                m(
                  "tr",
                  m("td", { colspan: isWriter ? 7 : 6 }, "暂无封锁时段")
                ),
              ]
        ),
      ]),
    ]),
    m("div.card", [
      m(
        "h2",
        { style: { marginTop: 0, fontSize: "1.1rem" } },
        "封锁记录（挡回）"
      ),
      m("table", [
        m("thead", [
          m("tr", [
            m("th", "挡回时刻"),
            m("th", "跨段"),
            m("th", "微应变"),
            m("th", "报送人"),
            m("th", "封锁窗"),
            m("th", "说明"),
          ]),
        ]),
        m(
          "tbody",
          state.rejections.length
            ? state.rejections.map((r) =>
                m("tr", { key: r.id }, [
                  m("td", fmtTime(r.attempted_at)),
                  m("td", r.span_code),
                  m("td", r.microstrain),
                  m("td", r.attempted_by),
                  m(
                    "td",
                    `${fmtTime(r.window_starts_at)} ～ ${fmtTime(
                      r.window_ends_at
                    )}`
                  ),
                  m("td", r.reason),
                ])
              )
            : [m("tr", m("td", { colspan: 6 }, "暂无挡回记录"))]
        ),
      ]),
    ]),
  ];
}

const App = {
  oninit() {
    loadAll();
    startPolling();
    state.clockTimer = setInterval(() => m.redraw(), 1000);
  },
  onremove() {
    if (state.timer) clearInterval(state.timer);
    if (state.clockTimer) clearInterval(state.clockTimer);
  },
  view() {
    if (!state.token) {
      return loginView();
    }

    const isWriter = state.user?.role === "writer";

    return m("div.wrap", [
      m("div.topbar", [
        m("div", [
          m("h1", "桥梁应变班交台"),
          m("p.sub", "微应变 80～220 με 为合格，否则为越界。"),
        ]),
        m("div", [
          `${state.user?.username}（${isWriter ? "测量员" : "复核员"}） `,
          m(
            "button.secondary",
            {
              type: "button",
              onclick: () => {
                localStorage.removeItem(TOKEN_KEY);
                localStorage.removeItem(USER_KEY);
                state.token = "";
                state.user = null;
                state.rows = [];
                state.spans = [];
                state.blockades = [];
                state.rejections = [];
                state.serverNowBase = null;
                if (state.timer) clearInterval(state.timer);
                m.redraw();
              },
            },
            "退出"
          ),
        ]),
      ]),
      m("div.nav", [
        m(
          "button",
          {
            type: "button",
            class: state.page === "readings" ? "active" : "",
            onclick: () => {
              state.page = "readings";
            },
          },
          "读数报送"
        ),
        m(
          "button",
          {
            type: "button",
            class: state.page === "blockades" ? "active" : "",
            onclick: () => {
              state.page = "blockades";
            },
          },
          "封锁日历"
        ),
      ]),
      state.page === "blockades"
        ? blockadesPage(isWriter)
        : readingsPage(isWriter),
    ]);
  },
};

export default App;
