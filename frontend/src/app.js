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

const BJ_FMT = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function fmtBJ(iso) {
  if (!iso) return "—";
  return BJ_FMT.format(new Date(iso)).replace(/\//g, "-");
}

// datetime-local 控件值（浏览器本地时区的“年月日时分”）→ 带时区的绝对时刻。
// 仅用于把测量员填写的墙钟时间换算成绝对瞬间；是否落在封锁窗一律由后端 now() 判定。
function localInputToIso(value) {
  if (!value) return "";
  return new Date(value).toISOString();
}

// 后端返回的绝对时刻 → datetime-local 控件可用的浏览器本地字符串
function isoToLocalInput(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(
    d.getHours()
  )}:${p(d.getMinutes())}`;
}

const state = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  user: null,
  page: "readings",
  loginForm: { username: "surveyor", password: "surv123456" },
  submitForm: { span_code: "", microstrain: "" },
  rows: [],
  blockades: [],
  rejections: [],
  serverTime: "",
  blockadeLoaded: false,
  bForm: { span_code: "", starts_at: "", ends_at: "" },
  spanFilter: "__all__",
  editing: {},
  error: "",
  msg: "",
  listError: "",
  bError: "",
  bMsg: "",
  loading: false,
  timer: null,
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
  if (!res.ok) {
    const err = new Error(data.detail || res.statusText);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function loadReadings() {
  if (!state.token) return;
  try {
    state.rows = await api("/api/readings");
    state.listError = "";
  } catch {
    state.listError = "加载列表失败，请重新登录";
  }
  m.redraw();
}

async function loadBlockades() {
  if (!state.token) return;
  try {
    const data = await api("/api/blockades");
    state.blockades = data.blockades;
    state.rejections = data.rejections;
    state.serverTime = data.server_time;
    state.blockadeLoaded = true;
  } catch {
    // 网络抖动时保留上一次数据，下个轮询周期重试
  }
  m.redraw();
}

function pollAll() {
  if (!state.token) return;
  loadReadings();
  loadBlockades();
}

function startPolling() {
  if (state.timer) clearInterval(state.timer);
  if (!state.token) return;
  state.timer = setInterval(pollAll, 3000);
}

function activeBlockadeFor(spanCode) {
  const code = (spanCode || "").trim();
  if (!code) return null;
  return state.blockades.find((b) => b.span_code === code && b.active) || null;
}

function knownSpans() {
  const set = new Set();
  state.rows.forEach((r) => set.add(r.span_code));
  state.blockades.forEach((b) => set.add(b.span_code));
  return Array.from(set).sort();
}

function blockadeStateTag(b) {
  if (b.active) return m("span.tag.live", "生效中");
  if (new Date(b.starts_at) > new Date(state.serverTime))
    return m("span.tag.future", "未开始");
  return m("span.tag.dead", "已结束");
}

const ReadingsPage = {
  view() {
    const isWriter = state.user?.role === "writer";
    const active = activeBlockadeFor(state.submitForm.span_code);
    return [
      isWriter
        ? m("div.card", [
            m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "提交读数"),
            m(
              "p.sub",
              { style: { margin: "0 0 0.75rem" } },
              `封锁判断只认服务器时刻：${
                state.serverTime ? fmtBJ(state.serverTime) + "（北京时间）" : "读取中…"
              }；浏览器本机时间不参与判定。`
            ),
            active
              ? m(
                  "p.blockbanner",
                  `跨段「${active.span_code}」正处于封锁时段（${fmtBJ(
                    active.starts_at
                  )} 至 ${fmtBJ(
                    active.ends_at
                  )}，北京时间），封锁窗外才收，报送会被后台挡回。`
                )
              : null,
            m(
              "form",
              {
                onsubmit: async (e) => {
                  e.preventDefault();
                  state.error = "";
                  state.msg = "";
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
                    pollAll();
                  } catch (err) {
                    // 409 封锁挡回：以后台返回为准（含轮询间隙窗态变化的情形）
                    state.error = err.message || "提交失败";
                    if (err.status === 409) loadBlockades();
                  } finally {
                    state.loading = false;
                    m.redraw();
                  }
                },
              },
              [
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
                    {
                      type: "submit",
                      disabled: state.loading || !!active,
                      title: active ? "封锁窗外才收" : "",
                    },
                    active ? "封锁中" : "提交"
                  ),
                ]),
                m("datalist#span-options", knownSpans().map((s) => m("option", { value: s }))),
                state.error ? m("p.err", state.error) : null,
                state.msg ? m("p.ok", state.msg) : null,
              ]
            ),
          ])
        : null,
      m("div.card", [
        m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "读数列表"),
        state.listError ? m("p.err", state.listError) : null,
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
  },
};

const BlockadesPage = {
  oninit() {
    loadBlockades();
  },
  view() {
    const isWriter = state.user?.role === "writer";
    const spans = knownSpans();
    if (state.spanFilter !== "__all__" && !spans.includes(state.spanFilter)) {
      state.spanFilter = "__all__";
    }
    const shown = state.blockades.filter(
      (b) => state.spanFilter === "__all__" || b.span_code === state.spanFilter
    );
    const shownRejections = state.rejections.filter(
      (r) => state.spanFilter === "__all__" || r.span_code === state.spanFilter
    );

    return [
      m("div.card", [
        m(
          "p.sub",
          { style: { margin: 0 } },
          `服务器时刻：${
            state.serverTime ? fmtBJ(state.serverTime) + "（北京时间）" : "读取中…"
          }　封锁窗判定只吃此时钟，浏览器本机时间改了也没用。`
        ),
        !isWriter
          ? m(
              "p",
              { style: { margin: "0.5rem 0 0" } },
              m("span.tag.future", "复核员只读"),
              " 可查看封锁日历与挡回记录，不能挂起、修改或删除封锁。"
            )
          : null,
      ]),

      isWriter
        ? m("div.card", [
            m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "挂封锁时段"),
            m(
              "form",
              {
                onsubmit: async (e) => {
                  e.preventDefault();
                  state.bError = "";
                  state.bMsg = "";
                  try {
                    await api("/api/blockades", {
                      method: "POST",
                      body: JSON.stringify({
                        span_code: state.bForm.span_code,
                        starts_at: localInputToIso(state.bForm.starts_at),
                        ends_at: localInputToIso(state.bForm.ends_at),
                      }),
                    });
                    state.bForm = { span_code: "", starts_at: "", ends_at: "" };
                    state.bMsg = "封锁时段已挂起";
                    loadBlockades();
                  } catch (err) {
                    state.bError = err.message || "挂封锁失败";
                  }
                  m.redraw();
                },
              },
              [
                m("div.row", [
                  m("label", [
                    "跨段选择",
                    m("input", {
                      required: true,
                      list: "blockade-span-options",
                      placeholder: "例如 跨中S1",
                      value: state.bForm.span_code,
                      oninput: (e) => {
                        state.bForm.span_code = e.target.value;
                      },
                    }),
                  ]),
                  m("label", [
                    "起始时刻",
                    m("input", {
                      required: true,
                      type: "datetime-local",
                      step: "1",
                      value: state.bForm.starts_at,
                      oninput: (e) => {
                        state.bForm.starts_at = e.target.value;
                      },
                    }),
                  ]),
                  m("label", [
                    "结束时刻",
                    m("input", {
                      required: true,
                      type: "datetime-local",
                      step: "1",
                      value: state.bForm.ends_at,
                      oninput: (e) => {
                        state.bForm.ends_at = e.target.value;
                      },
                    }),
                  ]),
                  m("button", { type: "submit" }, "挂起"),
                  m(
                    "button.secondary",
                    {
                      type: "button",
                      title: "以服务器时刻为基准：前 5 分钟到后 30 分钟",
                      onclick: () => {
                        if (!state.serverTime) return;
                        const start = new Date(state.serverTime);
                        start.setMinutes(start.getMinutes() - 5);
                        const end = new Date(state.serverTime);
                        end.setMinutes(end.getMinutes() + 30);
                        state.bForm.starts_at = isoToLocalInput(start.toISOString());
                        state.bForm.ends_at = isoToLocalInput(end.toISOString());
                      },
                    },
                    "盖住此刻 ±"
                  ),
                ]),
                m(
                  "datalist#blockade-span-options",
                  spans.map((s) => m("option", { value: s }))
                ),
                m(
                  "p.sub",
                  { style: { margin: "0.5rem 0 0" } },
                  "时刻按本机时区填写，提交时换算为绝对时刻；落在窗内的报送由后台按服务器时刻挡回，窗外才收。"
                ),
                state.bError ? m("p.err", state.bError) : null,
                state.bMsg ? m("p.ok", state.bMsg) : null,
              ]
            ),
          ])
        : null,

      m("div.card", [
        m("div.row", { style: { justifyContent: "space-between" } }, [
          m("h2", { style: { margin: 0, fontSize: "1.1rem" } }, "封锁时段表"),
          m("label", [
            "跨段筛选",
            m(
              "select",
              {
                value: state.spanFilter,
                onchange: (e) => {
                  state.spanFilter = e.target.value;
                },
              },
              [
                m("option", { value: "__all__" }, "全部跨段"),
                ...spans.map((s) => m("option", { value: s }, s)),
              ]
            ),
          ]),
        ]),
        m("table", [
          m("thead", [
            m("tr", [
              m("th", "编号"),
              m("th", "跨段"),
              m("th", "起始（北京时间）"),
              m("th", "结束（北京时间）"),
              m("th", "状态"),
              m("th", "挂起人"),
              isWriter ? m("th", "操作") : null,
            ]),
          ]),
          m(
            "tbody",
            shown.length
              ? shown.map((b) => {
                  if (isWriter && !(b.id in state.editing)) {
                    state.editing[b.id] = {
                      starts_at: isoToLocalInput(b.starts_at),
                      ends_at: isoToLocalInput(b.ends_at),
                    };
                  }
                  const ed = state.editing[b.id];
                  return m("tr", { key: b.id, class: b.active ? "row-live" : "" }, [
                    m("td", b.id),
                    m("td", b.span_code),
                    isWriter
                      ? m("td", [
                          m("input.dt", {
                            type: "datetime-local",
                            step: "1",
                            value: ed?.starts_at || "",
                            oninput: (e) => {
                              ed.starts_at = e.target.value;
                            },
                          }),
                        ])
                      : m("td", fmtBJ(b.starts_at)),
                    isWriter
                      ? m("td", [
                          m("input.dt", {
                            type: "datetime-local",
                            step: "1",
                            value: ed?.ends_at || "",
                            oninput: (e) => {
                              ed.ends_at = e.target.value;
                            },
                          }),
                        ])
                      : m("td", fmtBJ(b.ends_at)),
                    m("td", blockadeStateTag(b)),
                    m("td", b.created_by),
                    isWriter
                      ? m("td", [
                          m(
                            "button.mini",
                            {
                              type: "button",
                              onclick: async () => {
                                state.bError = "";
                                state.bMsg = "";
                                try {
                                  await api(`/api/blockades/${b.id}`, {
                                    method: "PATCH",
                                    body: JSON.stringify({
                                      starts_at: localInputToIso(ed.starts_at),
                                      ends_at: localInputToIso(ed.ends_at),
                                    }),
                                  });
                                  state.bMsg = `封锁 #${b.id} 已更新`;
                                  loadBlockades();
                                } catch (err) {
                                  state.bError = err.message || "更新失败";
                                }
                                m.redraw();
                              },
                            },
                            "保存"
                          ),
                          m("button.mini.danger", {
                            type: "button",
                            onclick: async () => {
                              if (
                                !window.confirm(
                                  `确认删除跨段「${b.span_code}」的这条封锁时段？`
                                )
                              )
                                return;
                              state.bError = "";
                              state.bMsg = "";
                              try {
                                await api(`/api/blockades/${b.id}`, {
                                  method: "DELETE",
                                });
                                delete state.editing[b.id];
                                state.bMsg = `封锁 #${b.id} 已删除`;
                                loadBlockades();
                              } catch (err) {
                                state.bError = err.message || "删除失败";
                              }
                              m.redraw();
                            },
                          }, "删除"),
                        ])
                      : null,
                  ]);
                })
              : [
                  m(
                    "tr",
                    m(
                      "td",
                      { colspan: isWriter ? 7 : 6 },
                      "暂无封锁时段"
                    )
                  ),
                ]
          ),
        ]),
        state.bError ? m("p.err", state.bError) : null,
        state.bMsg ? m("p.ok", state.bMsg) : null,
      ]),

      m("div.card", [
        m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "封锁挡回记录"),
        m("table", [
          m("thead", [
            m("tr", [
              m("th", "编号"),
              m("th", "跨段"),
              m("th", "微应变"),
              m("th", "报送人"),
              m("th", "封锁窗（北京时间）"),
              m("th", "挡回时刻 / 服务器时刻（北京时间）"),
              m("th", "封锁#"),
            ]),
          ]),
          m(
            "tbody",
            shownRejections.length
              ? shownRejections.map((r) =>
                  m("tr", { key: r.id }, [
                    m("td", r.id),
                    m("td", r.span_code),
                    m("td", r.microstrain),
                    m("td", r.submitted_by),
                    m("td", `${fmtBJ(r.window_start)} ～ ${fmtBJ(r.window_end)}`),
                    m("td", `${fmtBJ(r.rejected_at)} / ${fmtBJ(r.server_time)}`),
                    m("td", r.blockade_id ?? "—"),
                  ])
                )
              : [m("tr", m("td", { colspan: 7 }, "暂无挡回记录"))]
          ),
        ]),
      ]),
    ];
  },
};

const App = {
  oninit() {
    pollAll();
    startPolling();
  },
  onremove() {
    if (state.timer) clearInterval(state.timer);
  },
  view() {
    if (!state.token) {
      return m(
        "div.wrap",
        [
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
                    pollAll();
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
        ]
      );
    }

    const isWriter = state.user?.role === "writer";

    return m("div.wrap", [
      m("div.topbar", [
        m("div", [
          m("h1", "桥梁应变班交台"),
          m("p.sub", "微应变 80～220 με 为合格，否则为越界。"),
        ]),
        m("div.topright", [
          m("div.tabs", [
            m(
              "button.secondary" + (state.page === "readings" ? ".tab-active" : ""),
              {
                type: "button",
                onclick: () => {
                  state.page = "readings";
                },
              },
              "报送台"
            ),
            m(
              "button.secondary" + (state.page === "blockades" ? ".tab-active" : ""),
              {
                type: "button",
                onclick: () => {
                  state.page = "blockades";
                  state.bError = "";
                  state.bMsg = "";
                  loadBlockades();
                },
              },
              "封锁日历"
            ),
          ]),
          m("div.userline", [
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
                  state.blockades = [];
                  state.rejections = [];
                  state.blockadeLoaded = false;
                  state.page = "readings";
                  if (state.timer) clearInterval(state.timer);
                  m.redraw();
                },
              },
              "退出"
            ),
          ]),
        ]),
      ]),
      state.page === "blockades" ? m(BlockadesPage) : m(ReadingsPage),
    ]);
  },
};

export default App;
