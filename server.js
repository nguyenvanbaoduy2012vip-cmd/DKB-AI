
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const STABILITY_API_KEY = process.env.STABILITY_API_KEY;

const MODEL =
  process.env.GROQ_MODEL || "openai/gpt-oss-20b";

const VISION_MODEL =
  process.env.GROQ_VISION_MODEL || "qwen/qwen3.8-27b";

const GROQ_URL = "https://api.groq.com/openai/v1";

const STABILITY_URL =
  "https://api.stability.ai/v2beta/stable-image/generate/core";

app.disable("x-powered-by");

app.use(express.json({ limit: "30mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ======================================
// SYSTEM PROMPT
// ======================================

const SYSTEM_PROMPT = `
Bạn là DKB AI, trợ lý trí tuệ nhân tạo của website DKB AI.

Tên hiển thị: DKB AI
Model hiển thị: dkb.flash.lite

Hãy:
- Trả lời bằng tiếng Việt khi người dùng sử dụng tiếng Việt.
- Trả lời rõ ràng, chính xác và hữu ích.
- Không tự bịa thông tin khi không biết.
- Trình bày code đầy đủ khi được yêu cầu.
- Sử dụng Markdown khi cần thiết.
- Không tự nhận mình là Gemini hay ChatGPT.
- Luôn giữ thái độ lịch sự và chuyên nghiệp.
`;

// ======================================
// HELPERS
// ======================================

function sendError(res, status, message) {
  return res.status(status).json({
    success: false,
    error: message
  });
}

function containsImage(messages) {
  return messages.some(message => {
    if (!Array.isArray(message.content)) {
      return false;
    }

    return message.content.some(item =>
      item &&
      (
        item.type === "image_url" ||
        item.image_url
      )
    );
  });
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) {
    throw new Error("messages phải là một mảng.");
  }

  const normalized = messages.slice(-16);

  return normalized.map(message => {
    if (!message || typeof message !== "object") {
      throw new Error("Tin nhắn không hợp lệ.");
    }

    const role = [
      "user",
      "assistant",
      "system"
    ].includes(message.role)
      ? message.role
      : "user";

    if (typeof message.content === "string") {
      return {
        role,
        content: message.content
      };
    }

    if (Array.isArray(message.content)) {
      const content = message.content.map(item => {
        if (!item || typeof item !== "object") {
          throw new Error("Nội dung tin nhắn không hợp lệ.");
        }

        if (item.type === "text") {
          return {
            type: "text",
            text: String(item.text || "")
          };
        }

        if (item.type === "image_url") {
          const imageUrl =
            typeof item.image_url === "string"
              ? item.image_url
              : item.image_url?.url;

          if (!imageUrl) {
            throw new Error("Ảnh gửi lên không hợp lệ.");
          }

          return {
            type: "image_url",
            image_url: {
              url: imageUrl
            }
          };
        }

        throw new Error(
          "Loại nội dung chưa được hỗ trợ."
        );
      });

      return {
        role,
        content
      };
    }

    throw new Error(
      "Định dạng nội dung không hợp lệ."
    );
  });
}

function buildMessages(messages) {
  const result = normalizeMessages(messages);

  if (result.length === 0) {
    throw new Error("Bạn chưa nhập nội dung.");
  }

  if (result[0].role !== "system") {
    result.unshift({
      role: "system",
      content: SYSTEM_PROMPT
    });
  }

  return result;
}

function getModel(messages) {
  return containsImage(messages)
    ? VISION_MODEL
    : MODEL;
}

function getMaxTokens(mode) {
  return mode === "max" ? 8192 : 4096;
}

function getReasoningEffort(mode) {
  return mode === "max" ? "high" : "low";
}

// ======================================
// GROQ REQUEST
// ======================================

async function groqRequest(body, timeout = 90000) {
  if (!GROQ_API_KEY) {
    throw new Error(
      "GROQ_API_KEY chưa được cấu hình trên Render."
    );
  }

  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeout);

  try {
    const response = await fetch(
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

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message =
        data?.error?.message ||
        data?.message ||
        `Groq API lỗi HTTP ${response.status}`;

      throw new Error(message);
    }

    return data;

  } finally {
    clearTimeout(timer);
  }
}

// ======================================
// HEALTH CHECK
// ======================================

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    name: "DKB AI",
    status: "online",
    model: "dkb.flash.lite",
    provider: "Groq API",
    providerModel: MODEL,
    visionModel: VISION_MODEL,
    imageProvider: "Stability AI",
    imageModel: "Stable Image Core",
    groqConfigured: Boolean(GROQ_API_KEY),
    imageConfigured: Boolean(STABILITY_API_KEY),
    search: false,
    imageSupport: true,
    audioTranscription: true,
    thinkingModes: ["lite", "max"],
    currentDateTime: new Date().toLocaleString(
      "vi-VN",
      {
        timeZone: "Asia/Ho_Chi_Minh"
      }
    )
  });
});

// ======================================
// CHAT API
// ======================================

app.post("/api/chat", async (req, res) => {
  try {
    const {
      messages,
      mode = "lite"
    } = req.body || {};

    const finalMessages = buildMessages(messages);
    const model = getModel(finalMessages);

    const body = {
      model,
      messages: finalMessages,
      temperature: 0.7,
      max_tokens: getMaxTokens(mode),
      stream: false
    };

    if (model.includes("gpt-oss")) {
      body.reasoning_effort =
        getReasoningEffort(mode);
    }

    const data = await groqRequest(body);

    const reply =
      data?.choices?.[0]?.message?.content || "";

    return res.json({
      success: true,
      reply,
      model: "dkb.flash.lite",
      usage: data.usage || null
    });

  } catch (error) {
    console.error("CHAT ERROR:", error);

    return sendError(
      res,
      500,
      error.message || "Không thể xử lý yêu cầu."
    );
  }
});

// ======================================
// STREAMING CHAT API
// ======================================

app.post("/api/chat-stream", async (req, res) => {
  let controller;
  let timer;

  try {
    const {
      messages,
      mode = "lite"
    } = req.body || {};

    const finalMessages = buildMessages(messages);
    const model = getModel(finalMessages);

    if (!GROQ_API_KEY) {
      return sendError(
        res,
        500,
        "GROQ_API_KEY chưa được cấu hình."
      );
    }

    const body = {
      model,
      messages: finalMessages,
      temperature: 0.7,
      max_tokens: getMaxTokens(mode),
      stream: true
    };

    if (model.includes("gpt-oss")) {
      body.reasoning_effort =
        getReasoningEffort(mode);
    }

    controller = new AbortController();

    timer = setTimeout(() => {
      controller.abort();
    }, 90000);

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
      const errorData = await upstream.json().catch(() => ({}));

      return sendError(
        res,
        upstream.status,
        errorData?.error?.message ||
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

    req.on("close", () => {
      clearTimeout(timer);
      controller?.abort();
    });

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();

    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      buffer += decoder.decode(value, {
        stream: true
      });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();

        if (!trimmed.startsWith("data:")) {
          continue;
        }

        const raw = trimmed.slice(5).trim();

        if (raw === "[DONE]") {
          res.write("event: done\n");
          res.write(
            'data: {"success":true}\n\n'
          );
          continue;
        }

        try {
          const parsed = JSON.parse(raw);

          const token =
            parsed?.choices?.[0]?.delta?.content;

          if (
            typeof token === "string" &&
            token.length
          ) {
            res.write("event: token\n");

            res.write(
              `data: ${JSON.stringify({
                text: token
              })}\n\n`
            );
          }

        } catch {
          // Bỏ qua chunk không hợp lệ.
        }
      }
    }

    clearTimeout(timer);

    if (!res.writableEnded) {
      res.write("event: done\n");
      res.write(
        'data: {"success":true}\n\n'
      );
      res.end();
    }

  } catch (error) {
    console.error("STREAM ERROR:", error);

    clearTimeout(timer);

    if (!res.headersSent) {
      return sendError(
        res,
        500,
        error.message ||
          "Lỗi khi tạo câu trả lời."
      );
    }

    if (!res.writableEnded) {
      res.write("event: error\n");

      res.write(
        `data: ${JSON.stringify({
          error: error.message || "Lỗi kết nối."
        })}\n\n`
      );

      res.end();
    }

  } finally {
    clearTimeout(timer);
  }
});

// ======================================
// IMAGE GENERATION API
// STABILITY AI - STABLE IMAGE CORE
// ======================================

app.post("/api/generate-image", async (req, res) => {
  let timer;

  const controller = new AbortController();

  try {
    if (!STABILITY_API_KEY) {
      return sendError(
        res,
        500,
        "STABILITY_API_KEY chưa được cấu hình trên Render."
      );
    }

    const originalPrompt = String(
      req.body?.prompt || ""
    ).trim();

    if (!originalPrompt) {
      return sendError(
        res,
        400,
        "Bạn chưa nhập mô tả hình ảnh."
      );
    }

    if (originalPrompt.length > 3000) {
      return sendError(
        res,
        400,
        "Mô tả hình ảnh tối đa 3000 ký tự."
      );
    }

    const allowedRatios = [
      "1:1",
      "16:9",
      "9:16",
      "4:3",
      "3:4",
      "3:2",
      "2:3",
      "21:9"
    ];

    const aspectRatio = allowedRatios.includes(
      req.body?.aspect_ratio
    )
      ? req.body.aspect_ratio
      : "1:1";

    // Cải thiện độ trung thành với mô tả gốc.
    // Không tự ý đổi địa điểm hoặc chủ thể.

    const finalPrompt = [
      "Create one image based on the following description.",
      "Follow the user's original scene and intention closely.",
      "Preserve the requested subject, location, environment,",
      "time of day, objects, composition and visual details.",
      "Do not replace the requested location with another location.",
      "Do not change an outdoor scene into an indoor scene.",
      "Do not invent unrelated objects or environments.",
      "When details are unspecified, use natural visual choices",
      "that remain consistent with the original request.",
      "",
      "Original user description:",
      originalPrompt
    ].join(" ");

    const form = new FormData();

    form.append("prompt", finalPrompt);
    form.append("output_format", "png");
    form.append("aspect_ratio", aspectRatio);

    timer = setTimeout(() => {
      controller.abort();
    }, 120000);

    const response = await fetch(
      STABILITY_URL,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${STABILITY_API_KEY}`,
          Accept: "image/*"
        },
        body: form,
        signal: controller.signal
      }
    );

    if (!response.ok) {
      const errorText = await response.text();

      console.error(
        "STABILITY ERROR:",
        response.status,
        errorText
      );

      let providerMessage = "";

      try {
        const parsed = JSON.parse(errorText);

        providerMessage =
          parsed?.errors?.join(", ") ||
          parsed?.message ||
          parsed?.name ||
          "";

      } catch {
        providerMessage =
          errorText.slice(0, 400);
      }

      let message =
        providerMessage ||
        `Stability AI lỗi HTTP ${response.status}.`;

      if (response.status === 401) {
        message =
          "API key Stability AI không hợp lệ.";
      } else if (response.status === 402) {
        message =
          "Tài khoản Stability AI không đủ credit.";
      } else if (response.status === 403) {
        message =
          "Stability AI từ chối yêu cầu. Có thể liên quan đến quyền truy cập hoặc bộ lọc nội dung. Hãy kiểm tra thông báo chi tiết từ nhà cung cấp.";
      } else if (response.status === 429) {
        message =
          "Bạn gửi yêu cầu quá nhanh. Hãy thử lại sau.";
      } else if (response.status >= 500) {
        message =
          "Máy chủ Stability AI đang gặp sự cố. Hãy thử lại sau.";
      }

      return sendError(
        res,
        response.status,
        message
      );
    }

    const imageBuffer = Buffer.from(
      await response.arrayBuffer()
    );

    if (!imageBuffer.length) {
      return sendError(
        res,
        502,
        "Stability AI không trả về dữ liệu hình ảnh."
      );
    }

    const imageBase64 =
      imageBuffer.toString("base64");

    return res.json({
      success: true,
      image: `data:image/png;base64,${imageBase64}`,
      mimeType: "image/png",
      provider: "Stability AI",
      model: "Stable Image Core",
      originalPrompt,
      aspectRatio
    });

  } catch (error) {
    console.error(
      "IMAGE GENERATION ERROR:",
      error
    );

    if (error.name === "AbortError") {
      return sendError(
        res,
        504,
        "Tạo ảnh quá lâu. Vui lòng thử lại."
      );
    }

    return sendError(
      res,
      500,
      error.message || "Không thể tạo ảnh."
    );

  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
});

// ======================================
// VOICE TRANSCRIPTION
// GROQ WHISPER
// ======================================

app.post("/api/transcribe", async (req, res) => {
  try {
    if (!GROQ_API_KEY) {
      return sendError(
        res,
        500,
        "GROQ_API_KEY chưa được cấu hình."
      );
    }

    const audioBase64 = req.body?.audio;

    const mimeType =
      req.body?.mimeType || "audio/webm";

    if (
      !audioBase64 ||
      typeof audioBase64 !== "string"
    ) {
      return sendError(
        res,
        400,
        "Không tìm thấy dữ liệu âm thanh."
      );
    }

    const audioBuffer = Buffer.from(
      audioBase64,
      "base64"
    );

    if (
      !audioBuffer.length ||
      audioBuffer.length > 20 * 1024 * 1024
    ) {
      return sendError(
        res,
        400,
        "File âm thanh không hợp lệ hoặc quá lớn."
      );
    }

    const extension =
      mimeType.includes("ogg") ? "ogg" :
      mimeType.includes("mp4") ? "mp4" :
      mimeType.includes("wav") ? "wav" :
      "webm";

    const form = new FormData();

    form.append(
      "file",
      new Blob(
        [audioBuffer],
        { type: mimeType }
      ),
      `recording.${extension}`
    );

    form.append(
      "model",
      "whisper-large-v3-turbo"
    );

    form.append("language", "vi");
    form.append("response_format", "json");

    const response = await fetch(
      `${GROQ_URL}/audio/transcriptions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`
        },
        body: form
      }
    );

    const data = await response.json().catch(
      () => ({})
    );

    if (!response.ok) {
      throw new Error(
        data?.error?.message ||
        "Không thể chuyển giọng nói thành văn bản."
      );
    }

    return res.json({
      success: true,
      text: data.text || ""
    });

  } catch (error) {
    console.error(
      "TRANSCRIBE ERROR:",
      error
    );

    return sendError(
      res,
      500,
      error.message ||
        "Lỗi nhận diện giọng nói."
    );
  }
});

// ======================================
// FALLBACK
// ======================================

app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Không tìm thấy đường dẫn API."
  });
});

// ======================================
// START SERVER
// ======================================

app.listen(PORT, () => {
  console.log("--------------------------------");
  console.log("DKB AI SERVER STARTED");
  console.log("Port:", PORT);
  console.log("Text model:", MODEL);
  console.log("Vision model:", VISION_MODEL);
  console.log(
    "Groq configured:",
    Boolean(GROQ_API_KEY)
  );
  console.log(
    "Stability configured:",
    Boolean(STABILITY_API_KEY)
  );
  console.log("--------------------------------");
});
