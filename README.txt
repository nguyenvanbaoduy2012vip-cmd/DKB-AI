# DKB AI — Render

## Cấu trúc
- `server.js`: backend Node.js gọi Gemini API.
- `public/index.html`: giao diện DKB AI đã đổi sang gọi `/api/chat`.
- `package.json`: cấu hình chạy Node.js.

## Triển khai
1. Tải ZIP và giải nén.
2. Đưa toàn bộ nội dung thư mục `dkb-ai-render` lên một GitHub repository.
3. Trên Render chọn **New → Web Service**, kết nối repository.
4. Chọn:
   - Runtime: Node
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: Free
   - Region: Singapore (nếu được chọn)
5. Trong phần Environment Variables, thêm:
   - Key: `GEMINI_API_KEY`
   - Value: API Key Gemini mới của bạn
6. Deploy. Mở URL `https://ten-dich-vu.onrender.com` để dùng DKB AI.
7. Kiểm tra backend tại `https://ten-dich-vu.onrender.com/api/health`.

## Lưu ý
- Không đặt API Key trong `public/index.html`, GitHub hoặc tin nhắn.
- Giao diện và backend được phục vụ cùng một domain, nên frontend gọi `/api/chat`.
- Không dùng URL Worker Cloudflare cũ nữa.
- Render Free có thể tự ngủ sau 15 phút không có request; lần mở lại có thể mất khoảng một phút để thức dậy.
- Chọn Singapore là lựa chọn vị trí triển khai gần Việt Nam, nhưng không đảm bảo Google sẽ chấp nhận mọi request Gemini. Nếu vẫn có lỗi vùng, cần xem chính xác nội dung lỗi trả về.
- Model API giữ nguyên `gemini-3.5-flash-lite` như mã cũ. Nếu Google trả lỗi model không tồn tại/không hỗ trợ, cần đổi sang model ID đang được tài khoản Gemini API hỗ trợ.
