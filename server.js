const express = require("express");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 10000;

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const STABILITY_API_KEY = process.env.STABILITY_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
const VISION_MODEL = process.env.GROQ_VISION_MODEL || "qwen/qwen3.8-27b";

const GROQ_URL = "https://api.groq.com/openai/v1";
const STABILITY_URL = "https://api.stability.ai/v2beta/stable-image/generate/core";

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      })
    : null;

app.disable("x-powered-by");
app.use(express.json({ limit: "30mb" }));
app.use(express.static(path.join(__dirname, "public")));

const SYSTEM_PROMPT = `Bạn là DKB AI, trợ lý AI của website DKB AI.
Trả lời bằng tiếng Việt khi người dùng dùng tiếng Việt.
Trả lời rõ ràng, chính xác, không bịa thông tin,
trình bày chuyên nghiệp và không tự nhận là ChatGPT hay Gemini.`;

function fail(res, status, error) {
  return res.status(status).json({
    success: false,
    error
  });
}

function authReady() {
  return Boolean(
    SUPABASE_URL &&
    SUPABASE_ANON_KEY &&
    supabaseAdmin
  );
}

// ==============================
// AUTHENTICATION
// ==============================

async function requireUser(req, res, next) {
  try {
    if (!authReady()) {
      return fail(
        res,
        503,
        "Supabase chưa được cấu hình đầy đủ trên Render."
      );
    }

    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ")
      ? h.slice(7)
      : "";

    if (!token) {
      return fail(
        res,
        401,
        "Vui lòng đăng nhập để tiếp tục."
      );
    }

    const { data, error } =
      await supabaseAdmin.auth.getUser(token);

    if (error || !data?.user) {
      return fail(
        res,
        401,
        "Phiên đăng nhập không hợp lệ. Hãy đăng nhập lại."
      );
    }

    req.user = data.user;
    req.accessToken = token;

    next();
  } catch (e) {
    return fail(
      res,
      401,
      "Không thể xác minh tài khoản."
    );
  }
}

// ==============================
// ROLE / ADMIN
// ==============================

async function getRole(id) {
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", id)
    .maybeSingle();

  if (error) throw error;

  return data?.role || "user";
}

async function requireAdmin(req, res, next) {
  try {
    const role = await getRole(req.user.id);

    if (role !== "admin") {
      return fail(
        res,
        403,
        "Bạn không có quyền quản trị."
      );
    }

    next();
  } catch (e) {
    return fail(
      res,
      500,
      "Không kiểm tra được quyền quản trị."
    );
  }
}

// ==============================
// USER PLAN
// ==============================

async function getPlan(id) {
  const { data } = await supabaseAdmin
    .from("user_subscriptions")
    .select("plan_code,status,expires_at")
    .eq("user_id", id)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const plans = {
    free: {
      code: "free",
      name: "Thường",
      minInterval: 60000
    },

    pro: {
      code: "pro",
      name: "Pro",
      minInterval: 30000
    },

    premium: {
      code: "premium",
      name: "Premium",
      minInterval: 10000
    }
  };

  if (
    !data ||
    (data.expires_at &&
      new Date(data.expires_at) < new Date())
  ) {
    return plans.free;
  }

  return plans[data.plan_code] || plans.free;
}

const lastRequest = new Map();

async function enforceChatLimit(req, res, next) {
  try {
    const plan = await getPlan(req.user.id);

    const last = lastRequest.get(req.user.id) || 0;

    const wait =
      plan.minInterval - (Date.now() - last);

    if (wait > 0) {
      return fail(
        res,
        429,
        `Gói ${plan.name}: vui lòng chờ ${Math.ceil(
          wait / 1000
        )} giây rồi gửi tiếp.`
      );
    }

    lastRequest.set(req.user.id, Date.now());

    req.plan = plan;

    next();
  } catch (e) {
    return fail(
      res,
      500,
      "Không kiểm tra được gói tài khoản."
    );
  }
}

// ==============================
// MESSAGE PROCESSING
// ==============================

function containsImage(messages) {
  return messages.some(m =>
    Array.isArray(m.content) &&
    m.content.some(
      x =>
        x &&
        (x.type === "image_url" || x.image_url)
    )
  );
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) {
    throw new Error("Bạn chưa nhập nội dung.");
  }

  return messages.slice(-16).map(m => {
    if (
      !m ||
      !["user", "assistant"].includes(m.role)
    ) {
      throw new Error("Tin nhắn không hợp lệ.");
    }

    if (typeof m.content === "string") {
      return {
        role: m.role,
        content: m.content
      };
    }

    if (Array.isArray(m.content)) {
      return {
        role: m.role,

        content: m.content.map(x => {
          if (x.type === "text") {
            return {
              type: "text",
              text: String(x.text || "")
            };
          }

          if (x.type === "image_url") {
            const url =
              typeof x.image_url === "string"
                ? x.image_url
                : x.image_url?.url;

            if (
              !url ||
              !url.startsWith("data:image/")
            ) {
              throw new Error(
                "Ảnh gửi lên không hợp lệ."
              );
            }

            return {
              type: "image_url",
              image_url: {
                url
              }
            };
          }

          throw new Error(
            "Loại nội dung chưa hỗ trợ."
          );
        })
      };
    }

    throw new Error(
      "Định dạng tin nhắn không hợp lệ."
    );
  });
}

function buildMessages(messages) {
  const list = normalizeMessages(messages);

  list.unshift({
    role: "system",
    content: SYSTEM_PROMPT
  });

  return list;
}

// ==============================
// GROQ API
// ==============================

async function groqRequest(body, timeout = 90000) {
  if (!GROQ_API_KEY) {
    throw new Error(
      "GROQ_API_KEY chưa được cấu hình trên Render."
    );
  }

  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeout
  );

  try {
    const r = await fetch(
      `${GROQ_URL}/chat/completions`,
      {
        method: "POST",

        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json"
        },

        body: JSON.stringify(body),

        signal: controller.signal
      }
    );

    const d = await r.json().catch(() => ({}));

    if (!r.ok) {
      throw new Error(
        d?.error?.message ||
        `Groq API lỗi HTTP ${r.status}`
      );
    }

    return d;
  } finally {
    clearTimeout(timer);
  }
}

// ==============================
// IMAGE PROMPT
// ==============================

async function improveImagePrompt(prompt) {
  const d = await groqRequest(
    {
      model: MODEL,

      messages: [
        {
          role: "system",

          content:
            "Rewrite the user's image request as a detailed English image prompt. Preserve the exact subject, place and scene. Do not change the requested setting. Output only the prompt."
        },

        {
          role: "user",
          content: prompt
        }
      ],

      temperature: 0.2,
      max_tokens: 700
    },
    30000
  );

  return (
    d.choices?.[0]?.message?.content || prompt
  )
    .trim()
    .slice(0, 4000);
}

// ==============================
// HEALTH / CONFIG
// ==============================

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    name: "DKB AI",
    status: "online",
    model: "dkb.flash.lite",

    groqConfigured: !!GROQ_API_KEY,
    imageConfigured: !!STABILITY_API_KEY,
    supabaseConfigured: authReady(),

    time: new Date().toLocaleString("vi-VN", {
      timeZone: "Asia/Ho_Chi_Minh"
    })
  });
});

app.get("/api/config", (req, res) => {
  res.json({
    success: true,
    supabaseUrl: SUPABASE_URL || "",
    supabaseKey: SUPABASE_ANON_KEY || ""
  });
});

// ==============================
// CURRENT USER
// ==============================

app.get("/api/me", requireUser, async (req, res) => {
  try {
    const [plan, role] = await Promise.all([
      getPlan(req.user.id),
      getRole(req.user.id)
    ]);

    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("display_name")
      .eq("id", req.user.id)
      .maybeSingle();

    res.json({
      success: true,

      user: {
        id: req.user.id,
        email: req.user.email,
        display_name: profile?.display_name || ""
      },

      role,
      plan
    });
  } catch (e) {
    fail(
      res,
      500,
      "Không tải được thông tin tài khoản."
    );
  }
});

// ==============================
// CHAT HISTORY
// ==============================

app.get("/api/chats", requireUser, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("chat_sessions")
    .select("id,title,created_at,updated_at")
    .eq("user_id", req.user.id)
    .order("updated_at", { ascending: false })
    .limit(50);

  if (error) {
    return fail(
      res,
      500,
      "Không tải được lịch sử chat: " + error.message
    );
  }

  res.json({
    success: true,
    chats: data || []
  });
});

app.get(
  "/api/chats/:id",
  requireUser,
  async (req, res) => {
    const { data: session, error: se } =
      await supabaseAdmin
        .from("chat_sessions")
        .select("id,title")
        .eq("id", req.params.id)
        .eq("user_id", req.user.id)
        .maybeSingle();

    if (se || !session) {
      return fail(
        res,
        404,
        "Không tìm thấy cuộc trò chuyện."
      );
    }

    const { data, error } = await supabaseAdmin
      .from("chat_messages")
      .select("id,role,content,created_at")
      .eq("session_id", session.id)
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: true })
      .limit(500);

    if (error) {
      return fail(
        res,
        500,
        "Không tải được tin nhắn: " + error.message
      );
    }

    res.json({
      success: true,
      chat: session,

      messages: (data || []).map(m => ({
        role: m.role,
        content: m.content
      }))
    });
  }
);

app.post(
  "/api/chats/sync",
  requireUser,
  async (req, res) => {
    try {
      const id = String(
        req.body?.id || ""
      ).slice(0, 80);

      const title = String(
        req.body?.title || "Cuộc trò chuyện mới"
      ).slice(0, 120);

      const messages = Array.isArray(
        req.body?.messages
      )
        ? req.body.messages.slice(-300)
        : [];

      if (!id) {
        return fail(
          res,
          400,
          "Thiếu mã cuộc trò chuyện."
        );
      }

      const { data: existing } =
        await supabaseAdmin
          .from("chat_sessions")
          .select("id")
          .eq("id", id)
          .eq("user_id", req.user.id)
          .maybeSingle();

      if (!existing) {
        const { error } = await supabaseAdmin
          .from("chat_sessions")
          .insert({
            id,
            user_id: req.user.id,
            title,
            updated_at: new Date().toISOString()
          });

        if (error) {
          return fail(
            res,
            500,
            "Không tạo được phiên chat: " +
              error.message
          );
        }
      } else {
        const { error } = await supabaseAdmin
          .from("chat_sessions")
          .update({
            title,
            updated_at: new Date().toISOString()
          })
          .eq("id", id)
          .eq("user_id", req.user.id);

        if (error) {
          return fail(
            res,
            500,
            "Không cập nhật được phiên chat: " +
              error.message
          );
        }
      }

      const { error: deleteError } =
        await supabaseAdmin
          .from("chat_messages")
          .delete()
          .eq("session_id", id)
          .eq("user_id", req.user.id);

      if (deleteError) {
        return fail(
          res,
          500,
          "Không cập nhật được lịch sử: " +
            deleteError.message
        );
      }

      const rows = messages
        .filter(
          m =>
            m &&
            ["user", "assistant"].includes(m.role)
        )
        .map(m => {
          let content =
            typeof m.content === "string"
              ? m.content
              : "[Ảnh đính kèm]";

          if (Array.isArray(m.content)) {
            content =
              (m.content.find(
                x => x.type === "text"
              )?.text || "") +
              " [Ảnh đính kèm]";
          }

          if (m.image) {
            content += " [Có ảnh đính kèm]";
          }

          return {
            session_id: id,
            user_id: req.user.id,
            role: m.role,
            content: String(content).slice(0, 30000)
          };
        });

      if (rows.length) {
        const { error } = await supabaseAdmin
          .from("chat_messages")
          .insert(rows);

        if (error) {
          return fail(
            res,
            500,
            "Không lưu được tin nhắn: " +
              error.message
          );
        }
      }

      res.json({
        success: true
      });
    } catch (e) {
      fail(res, 500, e.message);
    }
  }
);

app.delete(
  "/api/chats/:id",
  requireUser,
  async (req, res) => {
    const { error } = await supabaseAdmin
      .from("chat_sessions")
      .delete()
      .eq("id", req.params.id)
      .eq("user_id", req.user.id);

    if (error) {
      return fail(res, 500, error.message);
    }

    res.json({
      success: true
    });
  }
);

// ==============================
// CHAT API
// ==============================

app.post(
  "/api/chat",
  requireUser,
  enforceChatLimit,
  async (req, res) => {
    try {
      const messages = buildMessages(
        req.body?.messages
      );

      const model = containsImage(messages)
        ? VISION_MODEL
        : MODEL;

      const mode =
        req.body?.mode === "max"
          ? "max"
          : "lite";

      const body = {
        model,
        messages,
        temperature: 0.7,
        max_tokens:
          mode === "max" ? 8192 : 4096,
        stream: false
      };

      if (model.includes("gpt-oss")) {
        body.reasoning_effort =
          mode === "max" ? "high" : "low";
      }

      const d = await groqRequest(body);

      res.json({
        success: true,

        reply:
          d.choices?.[0]?.message?.content || "",

        model: "dkb.flash.lite",
        plan: req.plan
      });
    } catch (e) {
      console.error("CHAT", e);
      fail(res, 500, e.message);
    }
  }
);

// ==============================
// STREAM CHAT
// ==============================

app.post(
  "/api/chat-stream",
  requireUser,
  enforceChatLimit,
  async (req, res) => {
    let timer;

    try {
      const messages = buildMessages(
        req.body?.messages
      );

      const model = containsImage(messages)
        ? VISION_MODEL
        : MODEL;

      const mode =
        req.body?.mode === "max"
          ? "max"
          : "lite";

      const body = {
        model,
        messages,
        temperature: 0.7,
        max_tokens:
          mode === "max" ? 8192 : 4096,
        stream: true
      };

      if (model.includes("gpt-oss")) {
        body.reasoning_effort =
          mode === "max" ? "high" : "low";
      }

      if (!GROQ_API_KEY) {
        return fail(
          res,
          500,
          "GROQ_API_KEY chưa được cấu hình."
        );
      }

      const controller = new AbortController();

      timer = setTimeout(
        () => controller.abort(),
        90000
      );

      req.on("aborted", () => controller.abort());

      const upstream = await fetch(
        `${GROQ_URL}/chat/completions`,
        {
          method: "POST",

          headers: {
            Authorization: `Bearer ${GROQ_API_KEY}`,
            "Content-Type": "application/json"
          },

          body: JSON.stringify(body),
          signal: controller.signal
        }
      );

      if (!upstream.ok) {
        const d = await upstream
          .json()
          .catch(() => ({}));

        clearTimeout(timer);

        return fail(
          res,
          upstream.status,
          d?.error?.message ||
            "Không thể kết nối Groq API."
        );
      }

      res.setHeader(
        "Content-Type",
        "text/event-stream"
      );

      res.setHeader(
        "Cache-Control",
        "no-cache"
      );

      res.setHeader(
        "Connection",
        "keep-alive"
      );

      res.setHeader(
        "X-Accel-Buffering",
        "no"
      );

      res.flushHeaders?.();

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();

      let buffer = "";

      while (true) {
        const { done, value } =
          await reader.read();

        if (done) break;

        buffer += decoder.decode(value, {
          stream: true
        });

        const lines = buffer.split("\n");

        buffer = lines.pop() || "";

        for (const line of lines) {
          const t = line.trim();

          if (!t.startsWith("data:")) {
            continue;
          }

          const raw = t.slice(5).trim();

          if (raw === "[DONE]") {
            continue;
          }

          try {
            const j = JSON.parse(raw);

            const token =
              j.choices?.[0]?.delta?.content;

            if (
              typeof token === "string" &&
              token
            ) {
              res.write(
                `event: token\ndata: ${JSON.stringify({
                  text: token
                })}\n\n`
              );
            }
          } catch (e) {}
        }
      }

      clearTimeout(timer);

      if (!res.writableEnded) {
        res.write(
          'event: done\ndata: {"success":true}\n\n'
        );

        res.end();
      }
    } catch (e) {
      if (timer) {
        clearTimeout(timer);
      }

      console.error("STREAM", e);

      if (!res.headersSent) {
        return fail(res, 500, e.message);
      }

      if (!res.writableEnded) {
        res.write(
          `event: error\ndata: ${JSON.stringify({
            error: e.message
          })}\n\n`
        );

        res.end();
      }
    }
  }
);

// ==============================
// IMAGE GENERATION
// ==============================

app.post(
  "/api/generate-image",
  requireUser,
  async (req, res) => {
    try {
      if (!STABILITY_API_KEY) {
        return fail(
          res,
          500,
          "STABILITY_API_KEY chưa được cấu hình."
        );
      }

      const prompt = String(
        req.body?.prompt || ""
      ).trim();

      if (!prompt || prompt.length > 3000) {
        return fail(
          res,
          400,
          "Mô tả ảnh phải từ 1 đến 3000 ký tự."
        );
      }

      const aspect = [
        "1:1",
        "16:9",
        "9:16",
        "4:3",
        "3:4",
        "3:2",
        "2:3",
        "21:9"
      ].includes(req.body?.aspect_ratio)
        ? req.body.aspect_ratio
        : "1:1";

      const optimized =
        await improveImagePrompt(prompt);

      const form = new FormData();

      form.append("prompt", optimized);
      form.append("output_format", "png");
      form.append("aspect_ratio", aspect);

      const r = await fetch(STABILITY_URL, {
        method: "POST",

        headers: {
          Authorization: `Bearer ${STABILITY_API_KEY}`,
          Accept: "image/*"
        },

        body: form
      });

      if (!r.ok) {
        const t = await r.text();

        let message =
          `Stability AI lỗi HTTP ${r.status}`;

        try {
          const j = JSON.parse(t);

          message =
            j.errors?.join(", ") ||
            j.message ||
            message;
        } catch (e) {}

        if (r.status === 402) {
          message =
            "Tài khoản Stability AI không đủ credit.";
        }

        if (r.status === 403) {
          message =
            "Yêu cầu tạo ảnh bị bộ lọc an toàn từ chối.";
        }

        return fail(res, r.status, message);
      }

      if (
        r.headers.get("finish-reason") ===
        "CONTENT_FILTERED"
      ) {
        return fail(
          res,
          403,
          "Ảnh bị bộ lọc an toàn từ chối."
        );
      }

      const b = Buffer.from(
        await r.arrayBuffer()
      );

      res.json({
        success: true,

        image:
          `data:image/png;base64,${b.toString("base64")}`,

        originalPrompt: prompt,
        optimizedPrompt: optimized
      });
    } catch (e) {
      console.error("IMAGE", e);
      fail(res, 500, e.message);
    }
  }
);

// ==============================
// VOICE TRANSCRIPTION
// ==============================

app.post(
  "/api/transcribe",
  requireUser,
  async (req, res) => {
    try {
      if (!GROQ_API_KEY) {
        return fail(
          res,
          500,
          "GROQ_API_KEY chưa được cấu hình."
        );
      }

      const b64 = req.body?.audio;

      if (
        !b64 ||
        typeof b64 !== "string"
      ) {
        return fail(
          res,
          400,
          "Không tìm thấy dữ liệu âm thanh."
        );
      }

      const audio = Buffer.from(
        b64,
        "base64"
      );

      if (
        !audio.length ||
        audio.length > 20 * 1024 * 1024
      ) {
        return fail(
          res,
          400,
          "Âm thanh không hợp lệ hoặc quá lớn."
        );
      }

      const mime =
        req.body?.mimeType || "audio/webm";

      const ext = mime.includes("ogg")
        ? "ogg"
        : mime.includes("mp4")
        ? "mp4"
        : mime.includes("wav")
        ? "wav"
        : "webm";

      const form = new FormData();

      form.append(
        "file",
        new Blob([audio], { type: mime }),
        `recording.${ext}`
      );

      form.append(
        "model",
        "whisper-large-v3-turbo"
      );

      form.append("language", "vi");
      form.append("response_format", "json");

      const r = await fetch(
        `${GROQ_URL}/audio/transcriptions`,
        {
          method: "POST",

          headers: {
            Authorization: `Bearer ${GROQ_API_KEY}`
          },

          body: form
        }
      );

      const d = await r
        .json()
        .catch(() => ({}));

      if (!r.ok) {
        return fail(
          res,
          r.status,
          d.error?.message ||
            "Không thể chuyển giọng nói."
        );
      }

      res.json({
        success: true,
        text: d.text || ""
      });
    } catch (e) {
      fail(res, 500, e.message);
    }
  }
);

// ==============================
// ADMIN OVERVIEW
// ==============================

app.get(
  "/api/admin/overview",
  requireUser,
  requireAdmin,
  async (req, res) => {
    const [
      users,
      chats,
      subs,
      settings
    ] = await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select(
          "id,email,display_name,created_at,last_sign_in_at"
        )
        .order("created_at", {
          ascending: false
        })
        .limit(500),

      supabaseAdmin
        .from("chat_messages")
        .select(
          "id,user_id,session_id,role,content,created_at"
        )
        .order("created_at", {
          ascending: false
        })
        .limit(1000),

      supabaseAdmin
        .from("user_subscriptions")
        .select(
          "id,user_id,plan_code,status,expires_at,created_at"
        )
        .order("created_at", {
          ascending: false
        })
        .limit(500),

      supabaseAdmin
        .from("payment_settings")
        .select("*")
        .eq("id", 1)
        .maybeSingle()
    ]);

    if (
      users.error ||
      chats.error ||
      subs.error
    ) {
      return fail(
        res,
        500,
        "Không tải được dữ liệu quản trị: " +
          (
            users.error ||
            chats.error ||
            subs.error
          ).message
      );
    }

    res.json({
      success: true,
      users: users.data || [],
      chats: chats.data || [],
      subscriptions: subs.data || [],
      payment: settings.data || {}
    });
  }
);

// ==============================
// ADMIN GRANT PLAN
// ==============================

app.post(
  "/api/admin/grant-plan",
  requireUser,
  requireAdmin,
  async (req, res) => {
    const email = String(
      req.body?.email || ""
    )
      .trim()
      .toLowerCase();

    const plan = String(
      req.body?.plan_code || ""
    );

    const days = Math.max(
      1,
      Math.min(
        3650,
        Number(req.body?.days || 30)
      )
    );

    if (
      !email ||
      !["free", "pro", "premium"].includes(plan)
    ) {
      return fail(
        res,
        400,
        "Email hoặc gói không hợp lệ."
      );
    }

    const { data: profile, error: pe } =
      await supabaseAdmin
        .from("profiles")
        .select("id")
        .ilike("email", email)
        .maybeSingle();

    if (pe) {
      return fail(res, 500, pe.message);
    }

    if (!profile) {
      return fail(
        res,
        404,
        "Không tìm thấy tài khoản email này. Tài khoản phải đăng ký trước."
      );
    }

    const expires =
      plan === "free"
        ? null
        : new Date(
            Date.now() + days * 86400000
          ).toISOString();

    const { error } = await supabaseAdmin
      .from("user_subscriptions")
      .insert({
        user_id: profile.id,
        plan_code: plan,
        status: "active",
        expires_at: expires,
        granted_by: req.user.id
      });

    if (error) {
      return fail(res, 500, error.message);
    }

    res.json({
      success: true,
      message: `Đã cấp gói ${plan} cho ${email}.`
    });
  }
);

// ==============================
// ADMIN PAYMENT SETTINGS
// ==============================

app.post(
  "/api/admin/payment-settings",
  requireUser,
  requireAdmin,
  async (req, res) => {
    const payload = {
      id: 1,

      display_name: String(
        req.body?.display_name || ""
      ).slice(0, 100),

      bank_name: String(
        req.body?.bank_name || ""
      ).slice(0, 100),

      account_number: String(
        req.body?.account_number || ""
      ).slice(0, 80),

      account_holder: String(
        req.body?.account_holder || ""
      ).slice(0, 100),

      phone: String(
        req.body?.phone || ""
      ).slice(0, 40),

      zalo: String(
        req.body?.zalo || ""
      ).slice(0, 200),

      tiktok: String(
        req.body?.tiktok || ""
      ).slice(0, 200),

      note: String(
        req.body?.note || ""
      ).slice(0, 500),

      updated_at: new Date().toISOString()
    };

    const { error } = await supabaseAdmin
      .from("payment_settings")
      .upsert(payload);

    if (error) {
      return fail(res, 500, error.message);
    }

    res.json({
      success: true
    });
  }
);

// ==============================
// PUBLIC PAYMENT SETTINGS
// ==============================

app.get(
  "/api/payment-settings",
  async (req, res) => {
    if (!supabaseAdmin) {
      return fail(
        res,
        503,
        "Supabase chưa cấu hình."
      );
    }

    const { data, error } =
      await supabaseAdmin
        .from("payment_settings")
        .select(
          "display_name,bank_name,account_number,account_holder,phone,zalo,tiktok,note"
        )
        .eq("id", 1)
        .maybeSingle();

    if (error) {
      return fail(res, 500, error.message);
    }

    res.json({
      success: true,
      payment: data || {}
    });
  }
);

// ==============================
// 404
// ==============================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Không tìm thấy đường dẫn API."
  });
});

// ==============================
// START SERVER
// ==============================

app.listen(PORT, () => {
  console.log(`DKB AI running on ${PORT}`);
});
