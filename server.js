
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

const API_KEY = process.env.GROQ_API_KEY;
const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
const VISION_MODEL =
  process.env.GROQ_VISION_MODEL || "qwen/qwen3.8-27b";

const GROQ_URL =
  "https://api.groq.com/openai/v1/chat/completions";
const AUDIO_URL =
  "https://api.groq.com/openai/v1/audio/transcriptions";

const TIMEOUT = 90000;

app.disable("x-powered-by");
app.use(express.json({ limit: "30mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ==============================
// THỜI GIAN VIỆT NAM
// ==============================

function getVietnamTime() {
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    dateStyle: "full",
    timeStyle: "medium"
  }).format(new Date());
}

// ==============================
// SYSTEM PROMPT
// ==============================

function systemPrompt() {
  return `
Bạn là DKB AI, trợ lý AI trên website DKB AI.

Quy tắc:
- Trả lời bằng tiếng Việt khi người dùng sử dụng tiếng Việt.
- Trả lời chính xác, rõ ràng, dễ hiểu.
- Không tự bịa thông tin hoặc nguồn tham khảo.
- Nếu không biết, hãy nói rõ.
- Khi viết code, ưu tiên cung cấp code hoàn chỉnh.
- Không tự nhận mình là ChatGPT hoặc Gemini.
- Tên sản phẩm là DKB AI.
- Nhà phát triển chính: BDUY.
- Cộng tác viên và kiểm thử: QUỐC BẢO, TUẤN KIỆT.
- Thời gian Việt Nam hiện tại: ${getVietnamTime()}.
`;
}

// ==============================
// CHẾ ĐỘ LITE / MAX
// ==============================

function getMode(body) {
  return String(
    body.thinkingMode ||
    body.mode ||
    body.performance ||
    "lite"
  ).toLowerCase() === "max" ? "max" : "lite";
}

// ==============================
// KIỂM TRA TIN NHẮN
// ==============================

function validateMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) {
    throw new Error("Tin nhắn không hợp lệ.");
  }

  if (messages.length > 40) {
    throw new Error("Quá nhiều tin nhắn.");
  }

  return messages.map(message => {
    if (
      !message ||
      !["user", "assistant"].includes(message.role)
    ) {
      throw new Error("Vai trò tin nhắn không hợp lệ.");
    }

    if (typeof message.content === "string") {
      if (message.content.length > 30000) {
        throw new Error("Tin nhắn quá dài.");
      }

      return {
        role: message.role,
        content: message.content
      };
    }

    if (!Array.isArray(message.content)) {
      throw new Error("Nội dung không hợp lệ.");
    }

    for (const item of message.content) {
      if (item.type === "text") {
        if (typeof item.text !== "string") {
          throw new Error("Văn bản không hợp lệ.");
        }
      } else if (item.type === "image_url") {
        const url = item.image_url?.url;

        if (
          typeof url !== "string" ||
          !/^(https?:\/\/|data:image\/)/i.test(url)
        ) {
          throw new Error("Ảnh không hợp lệ.");
        }
      } else {
        throw new Error("Loại nội dung không hỗ trợ.");
      }
    }

    return {
      role: message.role,
      content: message.content
    };
  });
}

// ==============================
// KIỂM TRA ẢNH
// ==============================

function containsImage(messages) {
  const last = [...messages]
    .reverse()
    .find(message => message.role === "user");

  return Boolean(
    last &&
    Array.isArray(last.content) &&
    last.content.some(item => item.type === "image_url")
  );
}

// ==============================
// TẠO REQUEST
// ==============================

function buildRequest(body, stream = false) {
  const messages = validateMessages(body.messages);
  const mode = getMode(body);
  const hasImage = containsImage(messages);
  const useSearch = body.useSearch === true && !hasImage;

  const model = hasImage ? VISION_MODEL : MODEL;

  const payload = {
    model,
    messages: [
      {
        role: "system",
        content: systemPrompt()
      },
      ...messages.slice(-16)
    ],
    temperature: 0.6,
    max_completion_tokens: mode === "max" ? 8192 : 4096,
    stream
  };

  if (
    !hasImage &&
    model.startsWith("openai/gpt-oss")
  ) {
    payload.reasoning_effort =
      mode === "max" ? "high" : "low";
  }

  if (useSearch) {
    payload.tools = [
      { type: "browser_search" }
    ];
    payload.tool_choice = "auto";
  }

  return {
    payload,
    mode,
    model,
    useSearch
  };
}

// ==============================
// GỌI GROQ API
// ==============================

async function groqRequest(url, options = {}) {
  if (!API_KEY) {
    throw new Error(
      "GROQ_API_KEY chưa được cấu hình trên Render."
    );
  }

  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    TIMEOUT
  );

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        ...(options.headers || {})
      }
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Yêu cầu hết thời gian chờ.");
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// ==============================
// ĐỌC PHẢN HỒI API
// ==============================

async function readResponse(response) {
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data?.error?.message ||
      `Groq API lỗi HTTP ${response.status}`
    );
  }

  return data;
}

function extractReply(data) {
  const content = data?.choices?.[0]?.message?.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map(item => item.text || "")
      .join("");
  }

  return "";
}

// ==============================
// LẤY NGUỒN THAM KHẢO
// ==============================

function collectSources(data) {
  const sources = new Map();
  const seen = new WeakSet();

  function scan(value) {
    if (
      !value ||
      typeof value !== "object" ||
      seen.has(value)
    ) {
      return;
    }

    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach(scan);
      return;
    }

    for (const [key, item] of Object.entries(value)) {
      if (
        typeof item === "string" &&
        /^https?:\/\//i.test(item) &&
        [
          "url",
          "uri",
          "link",
          "source_url",
          "web_url"
        ].includes(key)
      ) {
        sources.set(item, {
          url: item,
          title: value.title || value.name || item
        });
      }

      if (item && typeof item === "object") {
        scan(item);
      }
    }
  }

  scan(data);

  return [...sources.values()].slice(0, 15);
}

// ==============================
// HEALTH CHECK
// ==============================

app.get("/api/health", (req, res) => {
  res.json({
    name: "DKB AI",
    status: "online",
    provider: "Groq API",
    model: "dkb.flash.lite",
    providerModel: MODEL,
    visionModel: VISION_MODEL,
    thinkingModes: ["lite", "max"],
    search: true,
    imageSupport: true,
    audioTranscription: true,
    apiKeyConfigured: Boolean(API_KEY),
    currentDateTime: getVietnamTime(),
    timezone: "Asia/Ho_Chi_Minh"
  });
});

// ==============================
// CHAT THÔNG THƯỜNG
// ==============================

app.post("/api/chat", async (req, res) => {
  try {
    const {
      payload,
      mode,
      model,
      useSearch
    } = buildRequest(req.body, false);

    const response = await groqRequest(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await readResponse(response);

    const reply = extractReply(data);

    if (!reply) {
      throw new Error(
        "AI không trả về nội dung. Hãy thử lại."
      );
    }

    res.json({
      reply,
      sources: collectSources(data),
      mode,
      model: "dkb.flash.lite",
      providerModel: model,
      searched: useSearch,
      currentDateTime: getVietnamTime()
    });

  } catch (error) {
    console.error("CHAT ERROR:", error);

    res.status(500).json({
      error: error.message || "Không thể kết nối DKB AI."
    });
  }
});

// ==============================
// CHAT STREAMING - SSE
// ==============================

app.post("/api/chat-stream", async (req, res) => {
  let reader = null;
  let clientClosed = false;

  res.on("close", () => {
    clientClosed = true;

    if (reader) {
      reader.cancel().catch(() => {});
    }
  });

  function sendEvent(event, data) {
    if (clientClosed || res.destroyed) return;

    res.write(
      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    );
  }

  try {
    const {
      payload,
      mode,
      model,
      useSearch
    } = buildRequest(req.body, true);

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    // Khi bật tìm kiếm, dùng phản hồi đầy đủ
    // để nhận nội dung và dữ liệu nguồn.
    if (useSearch) {
      const response = await groqRequest(GROQ_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          ...payload,
          stream: false
        })
      });

      const data = await readResponse(response);
      const reply = extractReply(data);

      if (!reply) {
        throw new Error("AI không trả về nội dung.");
      }

      sendEvent("token", { text: reply });

      sendEvent("sources", {
        sources: collectSources(data)
      });

      sendEvent("done", {
        mode,
        model: "dkb.flash.lite",
        providerModel: model,
        searched: true,
        currentDateTime: getVietnamTime()
      });

      return res.end();
    }

    // Streaming thông thường
    const response = await groqRequest(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ...payload,
        stream: true
      })
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));

      throw new Error(
        data?.error?.message ||
        `Groq API lỗi HTTP ${response.status}`
      );
    }

    if (!response.body) {
      throw new Error("Không nhận được dữ liệu streaming.");
    }

    reader = response.body.getReader();

    const decoder = new TextDecoder();
    let buffer = "";

    while (!clientClosed) {
      const { value, done } = await reader.read();

      if (done) break;

      buffer += decoder.decode(value, {
        stream: true
      });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();

        if (!trimmed.startsWith("data:")) continue;

        const raw = trimmed.slice(5).trim();

        if (raw === "[DONE]") continue;

        try {
          const chunk = JSON.parse(raw);

          const text =
            chunk.choices?.[0]?.delta?.content;

          if (typeof text === "string" && text) {
            sendEvent("token", { text });
          }
        } catch (error) {
          // Bỏ qua dòng dữ liệu chưa hoàn chỉnh.
        }
      }
    }

    if (!clientClosed) {
      sendEvent("done", {
        mode,
        model: "dkb.flash.lite",
        providerModel: model,
        searched: false,
        currentDateTime: getVietnamTime()
      });

      res.end();
    }

  } catch (error) {
    console.error("STREAM ERROR:", error);

    sendEvent("error", {
      error: error.message || "Lỗi kết nối DKB AI."
    });

    if (!res.destroyed) {
      res.end();
    }
  }
});

// ==============================
// CHUYỂN GIỌNG NÓI THÀNH VĂN BẢN
// ==============================

app.post("/api/transcribe", async (req, res) => {
  try {
    if (!API_KEY) {
      throw new Error(
        "GROQ_API_KEY chưa được cấu hình trên Render."
      );
    }

    const {
      audioBase64,
      mimeType,
      language
    } = req.body || {};

    if (
      typeof audioBase64 !== "string" ||
      !audioBase64
    ) {
      throw new Error("Không tìm thấy dữ liệu âm thanh.");
    }

    const audioBuffer = Buffer.from(
      audioBase64,
      "base64"
    );

    if (!audioBuffer.length) {
      throw new Error("Tệp âm thanh không hợp lệ.");
    }

    if (audioBuffer.length > 24 * 1024 * 1024) {
      throw new Error("Âm thanh vượt quá giới hạn 24MB.");
    }

    const allowedTypes = [
      "audio/webm",
      "audio/mp4",
      "audio/mpeg",
      "audio/mp3",
      "audio/wav",
      "audio/x-wav",
      "audio/ogg",
      "audio/m4a"
    ];

    const safeMimeType = String(
      mimeType || "audio/webm"
    ).split(";")[0].toLowerCase();

    if (!allowedTypes.includes(safeMimeType)) {
      throw new Error("Định dạng âm thanh không được hỗ trợ.");
    }

    const extensionMap = {
      "audio/webm": "webm",
      "audio/mp4": "mp4",
      "audio/mpeg": "mp3",
      "audio/mp3": "mp3",
      "audio/wav": "wav",
      "audio/x-wav": "wav",
      "audio/ogg": "ogg",
      "audio/m4a": "m4a"
    };

    const extension =
      extensionMap[safeMimeType] || "webm";

    const audioBlob = new Blob(
      [audioBuffer],
      { type: safeMimeType }
    );

    const form = new FormData();

    form.append(
      "file",
      audioBlob,
      `recording.${extension}`
    );

    form.append(
      "model",
      "whisper-large-v3-turbo"
    );

    form.append("response_format", "json");

    if (language) {
      form.append("language", String(language));
    }

    const response = await groqRequest(AUDIO_URL, {
      method: "POST",
      body: form
    });

    const data = await readResponse(response);

    res.json({
      text: data.text || "",
      language: data.language || language || null
    });

  } catch (error) {
    console.error("TRANSCRIBE ERROR:", error);

    res.status(500).json({
      error: error.message || "Không thể nhận diện giọng nói."
    });
  }
});

// ==============================
// TRANG CHỦ
// ==============================

app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

// ==============================
// API KHÔNG TỒN TẠI
// ==============================

app.use("/api", (req, res) => {
  res.status(404).json({
    error: "API không tồn tại.",
    path: req.originalUrl
  });
});

// ==============================
// LỖI SERVER
// ==============================

app.use((error, req, res, next) => {
  console.error("SERVER ERROR:", error);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    error: "Lỗi máy chủ DKB AI."
  });
});

// ==============================
// KHỞI ĐỘNG SERVER
// ==============================

app.listen(PORT, () => {
  console.log("--------------------------------");
  console.log("DKB AI SERVER STARTED");
  console.log("Port:", PORT);
  console.log("Model:", MODEL);
  console.log("Vision:", VISION_MODEL);
  console.log("API Key:", API_KEY ? "CONFIGURED" : "MISSING");
  console.log("Vietnam time:", getVietnamTime());
  console.log("--------------------------------");
});
