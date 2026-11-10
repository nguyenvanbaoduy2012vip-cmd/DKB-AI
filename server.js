const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 30000;

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
- Dùng Google Search khi cần thông tin mới và nêu rõ nguồn nếu có.
- Phân biệt kiến thức có sẵn và thông tin vừa tìm kiếm.
- Không nhầm ngày hiện tại với dữ liệu huấn luyện.
- Không nói rằng bạn không có quyền truy cập ngày giờ nếu máy chủ đã cung cấp thời gian.
`;

function getVietnamParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());

  return Object.fromEntries(parts.map(p => [p.type, p.value]));
}

function getVietnamDateTime() {
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    dateStyle: "full",
    timeStyle: "medium",
    hourCycle: "h23"
  }).format(new Date());
}

function getVietnamDateISO() {
  const p = getVietnamParts();
  return `${p.year}-${p.month}-${p.day}`;
}

function daysUntil(year, month, day) {
  // Dùng ngày lịch Việt Nam, không bị lệch do múi giờ của máy chủ.
  const today = getVietnamDateISO().split("-").map(Number);
  const start = Date.UTC(today[0], today[1] - 1, today[2]);
  const target = Date.UTC(year, month - 1, day);
  return Math.round((target - start) / 86400000);
}

// Xử lý trực tiếp các câu hỏi ngày giờ/lịch phổ biến để câu trả lời chính xác,
// không phụ thuộc việc mô hình có làm theo system prompt hay không.
function answerTimeQuestion(message) {
  const q = message.toLocaleLowerCase("vi").normalize("NFC");
  const todayISO = getVietnamDateISO();
  const p = getVietnamParts();
  const todayText = getVietnamDateTime();

  const asksTime = /(mấy giờ|bây giờ là mấy giờ|giờ hiện tại|thời gian hiện tại)/i.test(q);
  const asksToday = /(hôm nay là ngày mấy|hôm nay ngày bao nhiêu|ngày hôm nay|hôm nay thứ mấy|hôm nay là thứ mấy)/i.test(q);

  if (asksTime) {
    return `Hiện tại là ${p.hour}:${p.minute}:${p.second} (giờ Việt Nam, UTC+7), ngày ${todayText}.`;
  }

  if (asksToday) {
    return `Hôm nay là ${todayText} (giờ Việt Nam, UTC+7).`;
  }

  const asksNewYear2027 =
    /(tết dương lịch|tết tây|năm mới)\s*(2027)?/.test(q) &&
    /(còn bao nhiêu ngày|bao nhiêu ngày nữa|còn mấy ngày|mấy ngày nữa|khi nào)/.test(q);

  if (asksNewYear2027) {
    const days = daysUntil(2027, 1, 1);
    if (days > 0) return `Tết Dương lịch 2027 là ngày 01/01/2027. Tính từ hôm nay (${todayISO}), còn ${days} ngày nữa.`;
    if (days === 0) return "Hôm nay là Tết Dương lịch 2027 (01/01/2027). Chúc mừng năm mới!";
    return "Tết Dương lịch 2027 (01/01/2027) đã qua rồi.";
  }

  return null;
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
    timeoutMs: TIMEOUT_MS,
    message: "DKB AI API is running!"
  });
});

// Chat
app.post("/api/chat", async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!Array.isArray(req.body?.messages) || req.body.messages.length === 0) {
    return res.status(400).json({ error: "Messages are required" });
  }

  if (req.body.messages.length > 50) {
    return res.status(400).json({ error: "Too many messages" });
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
      return res.status(400).json({ error: "Invalid message" });
    }

    contents.push({
      role: message.role === "assistant" ? "model" : message.role,
      parts: [{ text: message.content }]
    });
  }

  const latestUserMessage = [...messages].reverse().find(m => m.role === "user");
  const currentDateTime = getVietnamDateTime();

  // Trả lời ngày giờ bằng dữ liệu máy chủ, không gọi Gemini nên gần như tức thì.
  const directTimeReply = latestUserMessage
    ? answerTimeQuestion(latestUserMessage.content)
    : null;

  if (directTimeReply) {
    return res.json({
      name: "DKB AI",
      model: "dkb.flash.lite",
      currentDateTime,
      reply: directTimeReply,
      sources: []
    });
  }

  if (!apiKey) {
    return res.status(500).json({
      error: "Missing API key",
      details: "GEMINI_API_KEY chưa được cấu hình trên Render."
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

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
        systemInstruction: {
          parts: [{
            text: `${SYSTEM_PROMPT}

THỜI GIAN HIỆN TẠI DO MÁY CHỦ CUNG CẤP:
${currentDateTime}
Múi giờ: Asia/Ho_Chi_Minh (UTC+7).

BẮT BUỘC:
- Đây là thời gian hiện tại chính xác tại Việt Nam.
- Nếu người dùng hỏi ngày, giờ hoặc tính khoảng thời gian từ hôm nay, hãy dùng mốc thời gian trên.
- Tuyệt đối không trả lời rằng bạn không biết ngày giờ hiện tại.
- Tính số ngày bằng ngày lịch, không tự đoán.`
          }]
        },
        contents,
        tools: [{ google_search: {} }],
        generationConfig: {
          temperature: 0.5,
          maxOutputTokens: 2048,
          topP: 0.9
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
        details: candidate?.finishReason || "DKB AI did not generate a response."
      });
    }

    const chunks = candidate?.groundingMetadata?.groundingChunks || [];
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
        details: `Gemini chưa phản hồi trong ${Math.round(TIMEOUT_MS / 1000)} giây. Hãy thử lại sau.`
      });
    }

    return res.status(500).json({
      error: "Internal server error",
      details: error instanceof Error ? error.message : "Unknown server error"
    });
  } finally {
    clearTimeout(timeout);
  }
});

app.use("/api", (req, res) => {
  res.status(404).json({ error: "API endpoint not found" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`DKB AI server listening on port ${PORT}`);
  console.log(`Vietnam time: ${getVietnamDateTime()}`);
  console.log(`Gemini timeout: ${TIMEOUT_MS}ms`);
});
