const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const SYSTEM_PROMPT = `
Bạn là DKB AI, trợ lý AI thông minh và thân thiện.

NHẬN DIỆN:
- Tên: DKB AI
- Model hiển thị: dkb.flash.lite
- Nhà phát triển chính: BDUY
- Cộng tác và thử nghiệm: QUỐC BẢO, TUẤN KIỆT

Nếu được hỏi ai phát triển:
DKB AI được phát triển bởi BDUY – nhà phát triển chính.
QUỐC BẢO và TUẤN KIỆT là cộng tác viên và thành viên thử nghiệm.

QUY TẮC:
- Luôn nhận diện là DKB AI.
- Ưu tiên tiếng Việt.
- Không tự nhận là ChatGPT.
- Không nói DKB AI tự huấn luyện mô hình riêng.
- Công nghệ nền tảng là Gemini API.
- Trả lời trung thực, không bịa đặt thông tin.
- Sử dụng Google Search khi cần thông tin mới.
- Phân biệt kiến thức có sẵn và thông tin vừa tìm kiếm.
- Không nhầm ngày hiện tại với dữ liệu huấn luyện.
- Không bịa thông tin mới nếu không có nguồn kiểm chứng.
`;

// Lấy ngày, giờ, phút, giây theo múi giờ Việt Nam.
// Hàm được gọi ở MỖI request chat nên thời gian luôn được cập nhật.
function getVietnamDateTime() {
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    dateStyle: "full",
    timeStyle: "medium",
    hourCycle: "h23"
  }).format(new Date());
}

// Trang chủ
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Kiểm tra máy chủ và thời gian
app.get("/api/health", (req, res) => {
  res.json({
    name: "DKB AI",
    status: "online",
    model: "dkb.flash.lite",
    provider: "Gemini API",
    currentDateTime: getVietnamDateTime(),
    timezone: "Asia/Ho_Chi_Minh",
    message: "DKB AI API is running!"
  });
});

// Chat
app.post("/api/chat", async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "Missing API key",
      details: "GEMINI_API_KEY chưa được cấu hình trên Render."
    });
  }

  if (
    !Array.isArray(req.body?.messages) ||
    req.body.messages.length === 0
  ) {
    return res.status(400).json({
      error: "Messages are required"
    });
  }

  if (req.body.messages.length > 50) {
    return res.status(400).json({
      error: "Too many messages",
      details: "Maximum 50 messages per request."
    });
  }

  const messages = req.body.messages.slice(-12);
  const contents = [];

  for (const message of messages) {
    if (
      !message ||
      !["user", "assistant", "model"].includes(message.role) ||
      typeof message.content !== "string" ||
      !message.content.trim() ||
      message.content.length > 4000
    ) {
      return res.status(400).json({
        error: "Invalid message"
      });
    }

    contents.push({
      role: message.role === "assistant" ? "model" : message.role,
      parts: [{ text: message.content }]
    });
  }

  const controller = new AbortController();
  const timeoutMs = Number(process.env.GEMINI_TIMEOUT_MS) || 90000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Lấy thời gian mới nhất ngay khi người dùng gửi tin nhắn
    const currentDateTime = getVietnamDateTime();

    const apiUrl =
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{
            text: SYSTEM_PROMPT + `

THỜI GIAN HIỆN TẠI:
${currentDateTime}
Múi giờ: Việt Nam (Asia/Ho_Chi_Minh, UTC+7).

QUY TẮC THỜI GIAN:
- Đây là ngày giờ hiện tại chính xác do máy chủ cung cấp.
- Khi được hỏi hôm nay là ngày nào hoặc bây giờ là mấy giờ, hãy dùng thông tin trên.
- Không dùng năm 2024 hoặc ngày giờ cũ thay cho thời gian hiện tại.
- Không nhầm ngày giờ hiện tại với thời điểm dữ liệu huấn luyện.
- Không tự suy đoán giờ hiện tại nếu đã có thông tin này.
`
          }]
        },
        contents,
        tools: [
          {
            google_search: {}
          }
        ],
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
      return res.status(502).json({
        error: "Invalid Gemini response",
        details: "Google returned an unreadable response."
      });
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: "Gemini API error",
        details: result.error?.message || "Gemini request failed.",
        status: response.status,
        model: MODEL
      });
    }

    const candidate = result.candidates?.[0];

    const reply = candidate?.content?.parts
      ?.map(part => part.text || "")
      .join("")
      .trim();

    if (!reply) {
      return res.status(502).json({
        error: "Empty response",
        details:
          candidate?.finishReason ||
          "DKB AI did not generate a response."
      });
    }

    // Lấy nguồn Google Search nếu Gemini có trả về
    const chunks =
      candidate?.groundingMetadata?.groundingChunks || [];

    const sources = [];
    const seen = new Set();

    for (const chunk of chunks) {
      const web = chunk.web;

      if (web?.uri && !seen.has(web.uri)) {
        seen.add(web.uri);
        sources.push({
          title: web.title || "Nguồn tham khảo",
          url: web.uri
        });
      }
    }

    return res.json({
      name: "DKB AI",
      model: "dkb.flash.lite",
      currentDateTime,
      reply,
      sources
    });

  } catch (error) {
    if (error?.name === "AbortError") {
      return res.status(504).json({
        error: "Request timeout",
        details: "Gemini chưa phản hồi trong 90 giây. Hãy thử lại; nếu lặp lại, kiểm tra trạng thái API/model và hạn mức Google AI Studio."
      });
    }

    return res.status(500).json({
      error: "Internal server error",
      details:
        error instanceof Error ? error.message : "Unknown server error"
    });

  } finally {
    clearTimeout(timeout);
  }
});

// API endpoint không tồn tại
app.use("/api", (req, res) => {
  res.status(404).json({
    error: "API endpoint not found"
  });
});

// Khởi động server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`DKB AI server listening on port ${PORT}`);
  console.log(`Vietnam time: ${getVietnamDateTime()}`);
});
