
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

const API_KEY = process.env.GROQ_API_KEY;
const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
const TIMEOUT_MS = Number(process.env.GROQ_TIMEOUT_MS) || 60000;

const GROQ_URL =
  "https://api.groq.com/openai/v1/chat/completions";

app.disable("x-powered-by");
app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.join(__dirname, "public")));

const SYSTEM_PROMPT = `
Bạn là DKB AI, trợ lý AI thông minh, thân thiện và hữu ích.

THÔNG TIN:
- Tên: DKB AI.
- Model hiển thị: dkb.flash.lite.
- Nhà phát triển chính: BDUY.
- Cộng tác và thử nghiệm: QUỐC BẢO, TUẤN KIỆT.
- Nếu được hỏi ai phát triển: BDUY là nhà phát triển chính; QUỐC BẢO và TUẤN KIỆT là cộng tác viên, thành viên thử nghiệm.
- Ưu tiên trả lời bằng tiếng Việt.
- Không tự nhận là ChatGPT.
- Công nghệ nền tảng: Groq API.
- Không nói DKB AI tự huấn luyện mô hình riêng.

QUY TẮC:
- Trả lời trung thực, rõ ràng, dễ hiểu.
- Không bịa thông tin, sự kiện hoặc nguồn tham khảo.
- Khi có kết quả tìm kiếm Internet, ưu tiên thông tin mới và đáng tin cậy.
- Khi trả lời thông tin mới, hãy ghi rõ thời điểm hoặc ngày cập nhật nếu có.
- Nếu tìm thấy nguồn, hãy dẫn đường dẫn nguồn trong câu trả lời.
- Phân biệt thông tin đã xác minh và thông tin chưa chắc chắn.
- Không khẳng định thông tin hiện tại nếu chưa có căn cứ.

THỜI GIAN:
Máy chủ cung cấp thời gian Việt Nam trong từng yêu cầu.
Dùng chính xác thời gian đó khi được hỏi ngày giờ.
Múi giờ: Asia/Ho_Chi_Minh (UTC+7).
`;

function getVietnamDateTime() {
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    dateStyle: "full",
    timeStyle: "medium",
    hourCycle: "h23"
  }).format(new Date());
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// KIỂM TRA SERVER
app.get("/api/health", (req, res) => {
  res.json({
    name: "DKB AI",
    status: "online",
    model: "dkb.flash.lite",
    provider: "Groq API",
    providerModel: MODEL,
    webSearch: true,
    currentDateTime: getVietnamDateTime(),
    timezone: "Asia/Ho_Chi_Minh",
    features: [
      "history",
      "markdown",
      "web-search",
      "retry",
      "voice-input",
      "dark-mode",
      "chat-management",
      "streaming",
      "performance-settings"
    ]
  });
});

// KIỂM TRA TIN NHẮN
function validateMessages(messages) {
  if (
    !Array.isArray(messages) ||
    !messages.length ||
    messages.length > 50
  ) {
    return "Danh sách tin nhắn không hợp lệ.";
  }

  for (const m of messages) {
    if (
      !m ||
      !["user", "assistant", "model"].includes(m.role) ||
      typeof m.content !== "string" ||
      !m.content.trim() ||
      m.content.length > 12000
    ) {
      return "Có tin nhắn không hợp lệ.";
    }

    if (m.image) {
      return "Model tìm kiếm hiện tại chưa hỗ trợ gửi ảnh. Hãy gửi câu hỏi bằng văn bản.";
    }
  }

  return null;
}

// TẠO LỊCH SỬ GỬI CHO GROQ
function buildMessages(messages, currentDateTime) {
  const result = [
    {
      role: "system",
      content:
        SYSTEM_PROMPT +
        "\n\nTHỜI GIAN HIỆN TẠI: " +
        currentDateTime
    }
  ];

  for (const m of messages.slice(-12)) {
    result.push({
      role:
        m.role === "assistant" || m.role === "model"
          ? "assistant"
          : "user",
      content: m.content
    });
  }

  return result;
}

// CẤU HÌNH HIỆU SUẤT
function getPerformance(performance) {
  if (performance === "fast") {
    return {
      reasoning_effort: "low",
      max_completion_tokens: 1024
    };
  }

  if (performance === "deep") {
    return {
      reasoning_effort: "high",
      max_completion_tokens: 4096
    };
  }

  return {
    reasoning_effort: "medium",
    max_completion_tokens: 2048
  };
}

// TẠO REQUEST GROQ
function getRequestBody(
  messages,
  performance,
  useSearch,
  stream
) {
  const body = {
    model: MODEL,
    messages,
    ...getPerformance(performance),
    temperature: 1,
    top_p: 1,
    stream
  };

  // BẬT TÌM KIẾM INTERNET
  if (useSearch) {
    body.tools = [
      {
        type: "browser_search"
      }
    ];

    body.tool_choice = "auto";
  }

  return body;
}

// LẤY NGUỒN THAM KHẢO TỪ KẾT QUẢ GROQ
function collectSources(data) {
  const sources = [];
  const seen = new Set();

  function walk(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 10) {
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item, depth + 1);
      }
      return;
    }

    if (
      typeof value.url === "string" &&
      /^https?:\/\//i.test(value.url)
    ) {
      if (!seen.has(value.url)) {
        seen.add(value.url);

        sources.push({
          title:
            value.title ||
            value.name ||
            "Nguồn tham khảo",
          url: value.url
        });
      }
    }

    for (const key of Object.keys(value)) {
      walk(value[key], depth + 1);
    }
  }

  walk(data);

  return sources.slice(0, 10);
}

function getReply(result) {
  const content = result?.choices?.[0]?.message?.content;

  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map(item => item.text || "")
      .join("")
      .trim();
  }

  return "";
}

function getGroqError(result) {
  return (
    result?.error?.message ||
    result?.message ||
    "Không thể kết nối Groq API."
  );
}

// CHAT THƯỜNG
app.post("/api/chat", async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({
      error: "Missing API key",
      details: "GROQ_API_KEY chưa được cấu hình trên Render."
    });
  }

  const invalid = validateMessages(req.body?.messages);

  if (invalid) {
    return res.status(400).json({
      error: "Invalid messages",
      details: invalid
    });
  }

  const currentDateTime = getVietnamDateTime();

  const performance = [
    "fast",
    "balanced",
    "deep"
  ].includes(req.body.performance)
    ? req.body.performance
    : "balanced";

  const useSearch = req.body.useSearch !== false;

  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    TIMEOUT_MS
  );

  try {
    const response = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`
      },
      body: JSON.stringify(
        getRequestBody(
          buildMessages(req.body.messages, currentDateTime),
          performance,
          useSearch,
          false
        )
      ),
      signal: controller.signal
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(response.status).json({
        error: "Groq API error",
        details: getGroqError(result),
        status: response.status,
        model: MODEL
      });
    }

    const reply = getReply(result);

    if (!reply) {
      return res.status(502).json({
        error: "Empty response",
        details: "DKB AI chưa tạo được câu trả lời."
      });
    }

    const sources = collectSources(
      result.choices?.[0]?.message
    );

    res.json({
      name: "DKB AI",
      model: "dkb.flash.lite",
      provider: "Groq",
      currentDateTime,
      reply,
      sources
    });

  } catch (error) {
    if (error.name === "AbortError") {
      return res.status(504).json({
        error: "Request timeout",
        details: "Groq chưa phản hồi trong thời gian cho phép."
      });
    }

    res.status(500).json({
      error: "Internal server error",
      details: error.message || "Unknown error"
    });

  } finally {
    clearTimeout(timeout);
  }
});

// CHAT STREAMING + WEB SEARCH
app.post("/api/chat-stream", async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({
      error: "Missing API key",
      details: "GROQ_API_KEY chưa được cấu hình trên Render."
    });
  }

  const invalid = validateMessages(req.body?.messages);

  if (invalid) {
    return res.status(400).json({
      error: "Invalid messages",
      details: invalid
    });
  }

  const currentDateTime = getVietnamDateTime();

  const performance = [
    "fast",
    "balanced",
    "deep"
  ].includes(req.body.performance)
    ? req.body.performance
    : "balanced";

  const useSearch = req.body.useSearch !== false;

  const controller = new AbortController();

  res.on("close", () => {
    if (!res.writableEnded) {
      controller.abort();
    }
  });

  const timeout = setTimeout(
    () => controller.abort(),
    TIMEOUT_MS
  );

  try {
    const upstream = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`
      },
      body: JSON.stringify(
        getRequestBody(
          buildMessages(req.body.messages, currentDateTime),
          performance,
          useSearch,
          !useSearch
        )
      ),
      signal: controller.signal
    });

    if (!upstream.ok) {
      const err = await upstream.json().catch(() => ({}));

      return res.status(upstream.status).json({
        error: "Groq API error",
        details: getGroqError(err),
        status: upstream.status,
        model: MODEL
      });
    }

    res.status(200);
    res.setHeader(
      "Content-Type",
      "text/event-stream; charset=utf-8"
    );
    res.setHeader(
      "Cache-Control",
      "no-cache, no-transform"
    );
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    // SEARCH: GROQ TÌM KIẾM XONG RỒI TRẢ KẾT QUẢ
    if (useSearch) {
      const result = await upstream.json();

      const reply = getReply(result);

      if (reply) {
        res.write(
          `data: ${JSON.stringify({
            type: "text",
            text: reply
          })}\n\n`
        );
      }

      const sources = collectSources(
        result.choices?.[0]?.message
      );

      res.write(
        `data: ${JSON.stringify({
          type: "done",
          currentDateTime,
          sources
        })}\n\n`
      );

      res.end();
      return;
    }

    // KHÔNG SEARCH: STREAMING TỪNG PHẦN
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();

    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();

      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split("\n\n");
      buffer = events.pop() || "";

      for (const event of events) {
        const line = event
          .split("\n")
          .find(item => item.startsWith("data:"));

        if (!line) continue;

        const raw = line.slice(5).trim();

        if (!raw || raw === "[DONE]") continue;

        try {
          const chunk = JSON.parse(raw);

          const text =
            chunk.choices?.[0]?.delta?.content;

          if (typeof text === "string" && text) {
            res.write(
              `data: ${JSON.stringify({
                type: "text",
                text
              })}\n\n`
            );
          }
        } catch {
          // Bỏ qua chunk chưa hoàn chỉnh.
        }
      }
    }

    res.write(
      `data: ${JSON.stringify({
        type: "done",
        currentDateTime,
        sources: []
      })}\n\n`
    );

    res.end();

  } catch (error) {
    if (!res.headersSent) {
      const status =
        error.name === "AbortError" ? 504 : 500;

      return res.status(status).json({
        error: "Streaming error",
        details:
          error.name === "AbortError"
            ? "Groq chưa phản hồi trong thời gian cho phép."
            : error.message || "Unknown error"
      });
    }

    if (!res.writableEnded) {
      res.write(
        `data: ${JSON.stringify({
          type: "error",
          message:
            error.message || "Kết nối bị gián đoạn."
        })}\n\n`
      );

      res.end();
    }

  } finally {
    clearTimeout(timeout);
  }
});

// API KHÔNG TỒN TẠI
app.use("/api", (req, res) => {
  res.status(404).json({
    error: "API endpoint not found"
  });
});

// KHỞI ĐỘNG
app.listen(PORT, "0.0.0.0", () => {
  console.log("DKB AI server is running");
  console.log("Provider: Groq API");
  console.log("Model: " + MODEL);
  console.log("Web Search: Browser Search");
  console.log("Vietnam time: " + getVietnamDateTime());
});
