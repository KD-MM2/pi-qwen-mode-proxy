# pi-qwen-mode-proxy v1.3.2 — Tắt thinking hoàn toàn cho model Qwen trên omp

**Ngày:** 2026-09-19
**Repo:** `pi-qwen-mode-proxy` (cài đặt qua symlink tại `~/.omp/plugins/node_modules/pi-qwen-mode-proxy`)
**Server:** llama.cpp @ `http://192.168.0.2:3334`, model `Qwen3.8-27B` (GGUF)
**Wire:** `api: openai-responses` (`/v1/responses`), provider `llama.cpp` trong `~/.omp/agent/models.yml`

---

## 1. Tóm tắt

Các profile có `thinking: false` (ví dụ `instruct`) giờ tạo ra **0 token thinking** trên các model Qwen, dù runtime omp kẹp "off" xuống mức effort tối thiểu. Extension ép tắt thật **trên wire**: nó loại bỏ các trường effort do runtime tiêm vào và đặt `chat_template_kwargs.enable_thinking: false` — chat template kiểu Qwen3 được nhúng trong GGUF sẽ map giá trị này thành `/no_think`.

Sự kiện mấu chốt cho phép điều này, được xác lập bằng probe trực tiếp trên server thật: **GGUF này tôn trọng `enable_thinking: false`** — trái với mô tả trong catalog model của omp về template Qwen 3.8 chính thức. Kwarg thậm chí còn thắng cả khi `reasoning: { effort: "low" }` bị kẹp vẫn còn hiện diện trong payload.

---

## 2. Vấn đề

Profile `instruct` của extension đặt `thinking: false`. Ý định: instruct mode nghĩa là không thinking gì cả.

Điều thực sự xảy ra trên omp:

1. Extension gọi runtime API để tắt thinking ("off").
2. Runtime omp kẹp "off" xuống **effort tối thiểu** đối với các model `requiresEffort` (Qwen 3.8 là một trong số đó).
3. Session sau đó báo level `low` — và mọi payload gửi đi đều mang `reasoning: { effort: "low" }`.
4. Chat template hiểu điều đó là "nghĩ, ở mức effort thấp" → thinking vẫn được phát ra.

Vậy là profile nói "off", UI tắt được, nhưng model vẫn nghĩ. Việc kẹp này là **theo thiết kế** trong omp: với các model có mục catalog ghi thinking là bắt buộc, runtime từ chối gửi payload không có thinking, vì (theo catalog) chat template Qwen 3.8 chính thức **gây lỗi** nếu nhận `enable_thinking: false`.

Các phiên bản 1.3.0–1.3.1 chấp nhận tiền đề đó và chỉ theo dõi *trên hình thức* việc bị kẹp: extension ghi nhớ rằng nó đã áp dụng "off" dù runtime báo `low`, và thông báo khi đổi profile nói với người dùng "runtime đã kẹp off xuống low — nhấn Ctrl+T để ẩn khối thinking". Thành thật, nhưng chưa phải là một bản sửa.

## 3. omp mã hóa thinking trên wire như thế nào

Cùng một server llama.cpp có hai định dạng wire, và chúng mã hóa thinking khác nhau:

| | **Wire Responses** (`api: openai-responses`) | **Wire Completions** (`api: openai-completions`) |
| --- | --- | --- |
| Endpoint | `/v1/responses` | `/v1/chat/completions` |
| Trường mang thinking | `reasoning: { effort: "low" \| "medium" \| ... }` | `enable_thinking: true/false`, `reasoning_effort` top-level, và `chat_template_kwargs: { reasoning_effort }` |
| Hỗ trợ `enable_thinking` bản địa | **Không** — serializer Responses không có trường này | Có — nhánh Qwen của serializer dùng chung phát ra nó |
| Tắt trên model `requiresEffort` | Bị kẹp: `reasoning: { effort: "low" }` | Bị kẹp: `enable_thinking: true` + `reasoning_effort: "low"` (+ bản sao trong kwargs) |

Việc kẹp nằm trong `stream.ts` (`normalizeMandatoryReasoningOptions`): khi thinking bị tắt trên model `requiresEffort`, nó thay thế bằng effort tối thiểu thay vì để request ra đi mà không có thinking.

Hệ quả: **chỉ với mã hóa của riêng runtime, "off" trên Qwen 3.8 không phân biệt được với `low`** — payload giống hệt nhau từng byte. Đó là bức tường mà thiết kế v1.3.1 va phải.

## 4. Điều tra: probe trực tiếp

Trước khi thay đổi gì, server thật đã được probe. Lời nói trong catalog là về template Qwen 3.8 *chính thức*; template được nhúng vào từng GGUF tại thời điểm quantize, và các bản quant của cộng đồng thường xuyên đi kèm template kiểu Qwen3 cổ điển thay vào đó. Cách duy nhất để biết là hỏi server.

### 4.1 Môi trường

- Server llama.cpp tại `http://192.168.0.2:3334`
- Các model đang serve gồm: `Qwen3.8-27B`, `Qwen3.8-27B-735`, `Qwen3.8-27B-Swift{,-Q5M,-Q5S,-UC}`, `Nail-Qwen3.6-35B-A3B-{Q4,Q5}`, `KAT-Coder-V2.5-Dev`, `Cyber-Tiel-Coder-35B-A3B`
- Mọi probe đều dùng đúng model id `Qwen3.8-27B` với prompt tối giản ("reply with exactly: OK") và giới hạn token nhỏ
- Lưu ý: một probe đầu tiên đã trúng `Nail-Qwen3.6-35B-A3B-Q4` (kết quả khớp `/qwen/i` đầu tiên trong danh sách model) và nhận HTTP 500 "failed to load" — model đó chưa được nạp. Luôn probe với đúng model id đã nạp.

### 4.2 Ma trận probe

| # | Wire | Các trường liên quan thinking gửi đi | HTTP | Độ trễ | Kết quả |
| --- | --- | --- | --- | --- | --- |
| A | `/v1/chat/completions` | `chat_template_kwargs: { enable_thinking: false }` | 200 | ~15,6 s | chỉ message, **0 ký tự reasoning**, nội dung `OK` |
| R1 | `/v1/responses` | `chat_template_kwargs: { enable_thinking: false }` | 200 | ~15,3 s | `output_types: [message]`, **không có reasoning item**, text `OK` |
| R3 | `/v1/responses` | `reasoning: { effort: "low" }` **+** `chat_template_kwargs: { enable_thinking: false }` | 200 | ~4,7 s | `output_types: [message]`, **không có reasoning item**, text `OK` |

### 4.3 Phát hiện

1. **GGUF này tôn trọng `enable_thinking: false`** — không gây lỗi. Template kiểu Qwen3 cổ điển map cờ này thành soft prompt `/no_think`, tạo ra 0 token thinking.
2. **Hoạt động trên cả hai định dạng wire**, kể cả `/v1/responses` (định dạng omp thực sự dùng với server này), thông qua `chat_template_kwargs`.
3. **Kwarg thắng trường effort song song** (R3). Ngay cả khi payload vẫn mang `reasoning: { effort: "low" }` bị kẹp — đúng trạng thái mà omp tạo ra — template vẫn tắt thinking. R3 là probe quyết định: đó là *đúng trạng thái wire* mà extension sẽ tạo ra.

### 4.4 Vì sao lời nói trong catalog không áp dụng

Mục `requiresEffort` / "template gây lỗi với `enable_thinking: false`" của catalog omp cho Qwen 3.8 mô tả **template 3.8 chính thức**. GGUF đang serve đi kèm một template khác (kiểu Qwen3 cổ điển). Cả hai phát biểu đều đúng với các artifact khác nhau — probe là thứ quyết định phát biểu nào áp dụng ở đây.

**Hệ quả cho thiết kế:** chế độ hỏng giờ là *ngược* so với catalog. Nếu GGUF này được thay bằng một bản xây với template chính thức, các request instruct-mode sẽ lỗi template thay vì lặng lẽ thinking. Lưu ý này được ghi trong README (xem §9).

## 5. Giải pháp: viết lại wire kiểu hard-off

### 5.1 Cơ chế

Trong hook `before_provider_request` — chạy sau khi runtime đã xây xong payload (kể cả các trường effort bị kẹp) nhưng trước khi gửi đi — extension, khi **profile đang hoạt động có `thinking: false`** và **request nhắm vào model Qwen**, sẽ viết lại payload:

1. Xóa `payload.reasoning` — trường mang effort trên wire Responses.
2. Xóa `payload.reasoning_effort` — trường mang effort top-level trên wire Completions.
3. Lật `payload.enable_thinking` sang `false` **chỉ khi nó đã là boolean** (wire Completions; không bao giờ *thêm* trên wire Responses — wire này không có trường đó — để tránh rủi ro trường lạ).
4. Ghép `payload.chat_template_kwargs`: xóa `reasoning_effort`, đặt `enable_thinking: false`, giữ nguyên mọi kwarg khác.

Trạng thái wire kết quả trên wire Responses: không có trường `reasoning`, `chat_template_kwargs: { enable_thinking: false }` → template phát `/no_think` → **0 token thinking**.

`applyHardOff` là idempotent (chạy lại là no-op) và trả về việc nó đã viết lại payload hay chưa.

### 5.2 Mã nguồn

`extensions/config.ts`:

```ts
/** Qwen models only — `enable_thinking` is Qwen template semantics. */
const QWEN_PATTERN = /qwen/i;

/**
 * Force true thinking-off on an outgoing Qwen payload.
 * ... (full doc comment in source: rationale, probe evidence) ...
 * Mutates `payload`. Returns true when rewritten.
 */
export function applyHardOff(
 payload: Record<string, unknown>,
 model: ModelIdentity | undefined,
): boolean {
 if (!isQwenModel(payload, model)) return false;
 if (payload.reasoning !== undefined) delete payload.reasoning;
 if (payload.reasoning_effort !== undefined) delete payload.reasoning_effort;
 if (typeof payload.enable_thinking === "boolean") payload.enable_thinking = false;
 const prev = (payload.chat_template_kwargs ?? {}) as Record<string, unknown>;
 const kwargs: Record<string, unknown> = { ...prev };
 delete kwargs.reasoning_effort;
 kwargs.enable_thinking = false;
 payload.chat_template_kwargs = kwargs;
 return true;
}
```

`extensions/index.ts` (hook, sau khi tiêm sampling parameters):

```ts
// Qwen models: the runtime's clamped "off" would otherwise re-enable
// minimum-effort thinking (see applyHardOff).
if (params.thinking === false) applyHardOff(payload, ctx.model);
return payload;
```

### 5.3 Các quyết định thiết kế

| Quyết định | Lý do |
| --- | --- |
| **Probe trước khi viết mã** | Toàn bộ tính năng phụ thuộc vào template nhúng trong *GGUF này*. Một probe trên server thật (R3) đáng giá hơn mọi catalog đọc. |
| **Kwarg là lực chính, xóa effort là chốt an toàn** | R3 chứng minh kwarg thắng cả khi effort còn hiện diện, nên việc viết lại bền vững trước sự trôi dạt hình dạng payload giữa các phiên bản runtime — và việc xóa effort vẫn loại bỏ nhiễu ngữ nghĩa. |
| **Chỉ gate model Qwen** (`/qwen/i` trên payload model hoặc id/name/provider của session model) | `enable_thinking` là ngữ nghĩa template Qwen. Server cùng đang serve các model KAT-Coder và Cyber-Tiel; payload của chúng phải được giữ nguyên. |
| **Phạm vi do profile quyết định, không do toggle** | Chỉ áp dụng khi *profile đang hoạt động* có `thinking: false`. Người dùng tự tắt thinking thủ công khi runtime đang dùng profile thinking vẫn nhận hành vi kẹp bình thường của runtime. |
| **`enable_thinking` top-level chỉ lật khi đã có sẵn** | Wire Responses không có trường đó; thêm trường lạ là rủi ro không cần thiết. Wire Completions có trường này nên chuẩn hóa tại đó. |
| **Ghép kwargs, không bao giờ thay thế** | Giữ nguyên mọi kwarg khác (ví dụ `thinking_budget`) mà runtime hay người dùng có thể đã đặt. |
| **Không có cờ cấu hình** | Extension cá nhân cho một người dùng, chế độ hỏng có thể quan sát được (500 mỗi request, đã tài liệu hóa). Một cờ sẽ là độ phức tạp không cân xứng. |

### 5.4 Ghi chú cho người dùng

`clampedOffNote(offLevel, hardOff)` thêm tham số thứ hai. Trên model Qwen, thông báo khi đổi profile giờ nói rằng wire **gửi** `enable_thinking: false` (không phát thinking) — không còn lời khuyên Ctrl+T. Với các model **không-Qwen** bị kẹp, giữ nguyên ghi chú cũ (kèm lời khuyên Ctrl+T / `hideThinkingBlock`, oh-my-pi#626).

## 6. Những gì thay đổi (v1.3.1 → v1.3.2)

| Tệp | Thay đổi |
| --- | --- |
| `extensions/config.ts` | Mới `QWEN_PATTERN`, `modelCandidates()` (dùng chung với `isTargetModel` đã refactor), `isQwenModel()`, `applyHardOff()`; `clampedOffNote` giờ nhận `(offLevel, hardOff)` kèm biến thể thông báo hard-off |
| `extensions/index.ts` | Import hai helper mới; `applyThinking(profile, ctx)` thêm `ctx` để ghi chú có thể kiểm tra gate Qwen (đã cập nhật cả 5 nơi gọi: create/edit/delete/switch profile, session_start); `before_provider_request` gọi `applyHardOff` cho các profile `thinking: false`; cập nhật doc comment phần đầu |
| `test-smoke.ts` | Các test `clampedOffNote` cập nhật sang 2 tham số; khối mới: viết lại wire Responses, viết lại wire Completions, ghép/giữ kwargs, gate không-Qwen (payload và danh tính session), idempotency — 15 kiểm tra mới |
| `README.md` | Mục mới "True off for Qwen models" (cơ chế, bằng chứng probe, lưu ý template GGUF); sửa bullet omp (lời nói cũ "Qwen 3.8 từ chối `enable_thinking:false`" được giới hạn vào template chính thức); đoạn Ctrl+T giới hạn vào các model không-Qwen bị kẹp; "How It Works" đề cập việc viết lại hard-off |
| `package.json` | `1.3.1` → `1.3.2` |

## 7. Xác minh

| Kiểm tra | Kết quả |
| --- | --- |
| Bộ smoke test (`bun test-smoke.ts`) | **106/106 đạt**, exit 0 (91 có sẵn + 15 mới) |
| Kiểm tra kiểu (`bunx tsc --noEmit`) | sạch, không có output |
| Chuỗi bằng chứng probe trực tiếp | (a) omp gửi `reasoning: { effort: "low" }` khi thinking tắt trên wire Responses (việc kẹp của runtime + serializer Responses); (b) extension xóa nó và thêm kwarg (test unit); (c) đúng trạng thái wire đó tạo ra 0 thinking (probe R3, chạy thật) |
| Bản cài đặt | `~/.omp/plugins/node_modules/pi-qwen-mode-proxy` là symlink tới workspace (mtime giống hệt trên `extensions/index.ts`: 2026-09-19 15:45:33); `applyHardOff` hiện diện trong `config.ts` bản cài và được nối trong `index.ts` bản cài |

**Sửa sau xác minh:** trong lúc soạn báo cáo, một lần sửa lề trên dòng kwargs được phát hiện đã gây ra lỗi chính tả ở tên biến trên dòng đó (`keywords` → đúng: `kwargs`). Đã sửa tại chỗ (tên biến được suy ra từ dòng liền kề `delete kwargs.reasoning_effort;`) và chạy lại toàn bộ xác minh: 106/106 đạt, tsc sạch.

## 8. Hành vi người dùng sau v1.3.2

- **Bắt đầu session omp mới** (extension import lại khi session khởi động).
- Chuyển sang `instruct` (hoặc profile `thinking: false` bất kỳ) trên model Qwen → **không có khối thinking nào xuất hiện**; thông báo chuyển profile ghi rõ wire đang gửi `enable_thinking: false`.
- Các profile `thinking`/`coding` (`thinking: true`) không đổi — thinking hoạt động như trước.
- `Ctrl+T` (`hideThinkingBlock`, #626) không còn cần cho model Qwen; nó vẫn là phương án cho các model không-Qwen bị kẹp.
- Hoạt động giống hệt trên pi và omp (dual-runtime), trên cả hai định dạng wire.

## 9. Lưu ý và chế độ hỏng

1. **Xuất xứ template là giả định chịu tải.** Hành vi phụ thuộc vào chat template nhúng trong GGUF tại thời điểm quantize. Nếu `Qwen3.8-27B` (hoặc model khác được serve dưới tên Qwen) sau này được thay bằng bản xây dùng **template Qwen 3.8 chính thức** — bản gây lỗi với `enable_thinking: false` — các request instruct-mode sẽ lỗi template mỗi request (HTTP 500). Các phương án giảm nhẹ, theo thứ tự ưu tiên: serve GGUF template cổ điển, serve với llama.cpp `--chat-template` tường minh, hoặc chấp nhận hành vi kẹp (thinking bật) cho model đó. Extension không thể phát hiện kiểu template trước; sự hỏng là rõ ràng, không lặng lẽ.
2. **Gate theo tên.** Gate Qwen khớp `/qwen/i` với payload model id hoặc id/name/provider của session model. Một model không-Qwen giả sử có "qwen" trong id sẽ bị gate vào (và request của nó bị viết lại); một model Qwen được serve dưới tên không-Qwen sẽ bị bỏ sót. Cả hai đều khó xảy ra với model id chính xác của llama.cpp; fallback session-model bao phủ trường hợp sau cho các model đăng ký trong `models.yml` với id Qwen.
3. **Trường top-level trên wire Completions.** Việc lật `enable_thinking` top-level chỉ xảy ra khi trường đã là boolean; không bao giờ tiêm vào. Nếu một phiên bản runtime tương lai ngừng gửi nó trên wire Completions, kwarg vẫn ép tắt (kwarg là lực chính trên cả hai wire).

## 10. Tái tạo probe

Với server llama.cpp host GGUF Qwen template cổ điển, probe quyết định (R3) là một request duy nhất:

```http
POST /v1/responses
Content-Type: application/json

{
  "model": "Qwen3.8-27B",
  "input": "Reply with exactly: OK",
  "chat_template_kwargs": { "enable_thinking": false },
  "reasoning": { "effort": "low" }
}
```

Kỳ vọng: HTTP 200, `output` của phản hồi chứa một item `message` và **không có** item `reasoning`. Nếu một item `reasoning` xuất hiện (hoặc request 500 với lỗi template), template đang serve không khớp với bản cổ điển mà tính năng này dựa vào — xem §9.1.

## 11. Việc còn mở

- Không có gì chặn. Nghiệm thu phía người dùng: chạy một session omp thật với profile `instruct` và xác nhận 0 thinking trong transcript (điều này đã được dự đoán từ probe + test unit; đường duy nhất chưa chạy là toàn bộ runtime stack end-to-end).
- Nếu server catalog sau này chuyển sang các bản Qwen 3.8 template chính thức, xem lại §9.1 — các phương án dự phòng ở đó đã được tài liệu hóa nhưng chưa cài đặt (cố ý: probe đã khiến chúng không cần thiết với GGUF hiện tại).
