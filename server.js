const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;
const MODEL = "gemini-3.5-flash-lite";

const SYSTEM_PROMPT = `
Bạn là DKB AI, một trợ lý trí tuệ nhân tạo thông minh, thân thiện và hữu ích.

THÔNG TIN NHẬN DIỆN:
- Tên: DKB AI
- Model hiển thị: dkb.flash.lite
- Nhà phát triển chính: BDUY
- Cộng tác và thử nghiệm: QUỐC BẢO, TUẤN KIỆT

KHI ĐƯỢC HỎI AI PHÁT TRIỂN:
Hãy trả lời:
"DKB AI được phát triển bởi BDUY – nhà phát triển chính.
QUỐC BẢO và TUẤN KIỆT là những cộng tác viên và thành viên tham gia thử nghiệm dự án."

QUY TẮC:
- Luôn nhận diện mình là DKB AI.
- Ưu tiên trả lời bằng tiếng Việt nếu người dùng sử dụng tiếng Việt.
- Thân thiện, chuyên nghiệp, dễ hiểu.
- Trả lời đúng trọng tâm, không bịa đặt thông tin.
- Không tự nhận mình là ChatGPT.
- Không nói DKB AI tự huấn luyện mô hình riêng.
- Nếu được hỏi công nghệ nền tảng, hãy nói DKB AI sử dụng Gemini API.
- Không tự ý thay đổi tên hoặc vai trò của nhóm phát triển.
`;

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function sendJson(res, data, status = 200) {
  return res.status(status).json(data);
}

app.get("/api/health", (req, res) => {
  res.json({
    name: "DKB AI",
    status: "online",
    model: "dkb.flash.lite",
    provider: "Gemini API",
    message: "DKB AI API is running!"
  });
});

app.post("/api/chat", async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return sendJson(res, {
      error: "Missing API key",
      details: "GEMINI_API_KEY chưa được cấu hình trên Render."
    }, 500);
  }

  const body = req.body;
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return sendJson(res, { error: "Messages are required" }, 400);
  }

  if (body.messages.length > 50) {
    return sendJson(res, {
      error: "Too many messages",
      details: "Maximum 50 messages per request."
    }, 400);
  }

  const messages = body.messages.slice(-12);
  const contents = [];

  for (const message of messages) {
    if (!message || !["user", "assistant", "model"].includes(message.role)) {
      return sendJson(res, { error: "Invalid message role" }, 400);
    }

    if (
      typeof message.content !== "string" ||
      message.content.trim().length === 0 ||
      message.content.length > 4000
    ) {
      return sendJson(res, { error: "Invalid message content" }, 400);
    }

    contents.push({
      role: message.role === "assistant" ? "model" : message.role,
      parts: [{ text: message.content }]
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const apiUrl =
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 2048,
          topP: 0.95
        }
      }),
      signal: controller.signal
    });

    let result;
    try {
      result = await response.json();
    } catch {
      return sendJson(res, {
        error: "Invalid Gemini response",
        details: "Google returned an unreadable response."
      }, 502);
    }

    if (!response.ok) {
      return sendJson(res, {
        error: "Gemini API error",
        details: result.error?.message || "Gemini request failed.",
        status: response.status,
        model: MODEL
      }, response.status >= 400 && response.status < 600 ? response.status : 502);
    }

    const candidate = result.candidates?.[0];
    const reply = candidate?.content?.parts
      ?.map(part => part.text || "")
      .join("")
      .trim();

    if (!reply) {
      return sendJson(res, {
        error: "Empty response",
        details: candidate?.finishReason || "DKB AI did not generate a response."
      }, 502);
    }

    return res.json({
      name: "DKB AI",
      model: "dkb.flash.lite",
      reply
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      return sendJson(res, {
        error: "Request timeout",
        details: "Gemini API took too long to respond."
      }, 504);
    }

    return sendJson(res, {
      error: "Internal server error",
      details: error instanceof Error ? error.message : "Unknown server error"
    }, 500);
  } finally {
    clearTimeout(timeout);
  }
});

// Trả lỗi JSON cho endpoint API không tồn tại.
app.use("/api", (req, res) => {
  res.status(404).json({ error: "API endpoint not found" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`DKB AI server listening on port ${PORT}`);
});
