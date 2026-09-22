/**
 * api/analyze-prescription.js
 * -----------------------------------------------------------------------
 * 처방전/약봉투 사진을 Claude 3.5 Sonnet Vision으로 분석하는 백엔드 프록시.
 *
 * ⚠️ 왜 프론트엔드가 아니라 여기(백엔드)에서 Anthropic API를 호출해야 하나요?
 *   1) 프론트엔드(dogdiet-plan.html)에 API 키를 두면 누구나 브라우저 개발자도구의
 *      네트워크 탭이나 "페이지 소스 보기"만으로 키를 훔쳐갈 수 있어요.
 *   2) Anthropic API(https://api.anthropic.com/v1/messages)는 브라우저에서 직접 호출하는
 *      것을 CORS 정책으로 막고 있어서, 프론트엔드가 직접 fetch해도 항상 실패해요.
 *   그래서 이 파일처럼 "서버"에서만 실행되는 코드가 실제 키를 들고 Anthropic을 호출하고,
 *   프론트엔드는 이 파일이 만드는 /api/analyze-prescription 엔드포인트만 호출해요.
 *
 * 배포 방법 (택 1):
 *   - Vercel: 이 파일을 프로젝트의 /api/analyze-prescription.js 경로에 그대로 두면
 *     Vercel이 자동으로 서버리스 함수(Node.js runtime)로 인식해 배포해줘요.
 *   - Netlify Functions / AWS Lambda / Cloudflare Workers 등 다른 플랫폼을 쓴다면,
 *     아래 handler 본문 로직은 그대로 두고 함수 시그니처(exports 방식)만 해당 플랫폼
 *     규격에 맞게 감싸주면 돼요.
 *
 * 환경 변수 설정:
 *   - 배포 플랫폼의 "Environment Variables" 설정에서 ANTHROPIC_API_KEY를 등록하세요.
 *   - 로컬 개발 시에는 프로젝트 루트에 .env 파일을 만들고 다음처럼 적어주세요:
 *       ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxx
 *     (.env는 절대 git에 커밋하지 마세요 — .gitignore에 반드시 추가하세요.)
 * -----------------------------------------------------------------------
 */

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_VISION_MODEL = "claude-3-5-sonnet-20241022";

/**
 * Vercel 스타일 서버리스 함수 핸들러.
 * (Netlify를 쓴다면 `export async function handler(event)` 형태로 바꾸고,
 *  req.body 대신 JSON.parse(event.body)를 쓰는 정도만 조정하면 돼요.)
 */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "허용되지 않은 메서드입니다. POST로 요청해주세요." });
    return;
  }

  // ---- 1) API Key 확인: 서버 환경 변수에서만 읽어요 (프론트엔드로는 절대 전달하지 않음) ----
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // 프론트엔드(analyzePrescriptionImage)가 이 문구를 그대로 사용자에게 보여줘요.
    res.status(500).json({
      error: "API Key가 설정되지 않았습니다. 환경 변수에 ANTHROPIC_API_KEY를 등록해 주세요.",
    });
    return;
  }

  // ---- 2) 프론트엔드가 보낸 값 확인 ----
  const { image, system, instruction, model } = req.body || {};
  if (!image || typeof image !== "string") {
    res.status(400).json({ error: "분석할 이미지(base64)가 전달되지 않았습니다." });
    return;
  }

  // 프론트엔드는 "data:image/jpeg;base64,...." 형태의 DataURL을 보내요.
  // Anthropic Vision은 media_type과 순수 base64 데이터를 분리해서 받아야 해요.
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(image);
  if (!match) {
    res.status(400).json({ error: "이미지 형식이 올바르지 않습니다 (base64 DataURL이 아니에요)." });
    return;
  }
  const mediaType = match[1];
  const base64Data = match[2];

  const userInstruction =
    instruction ||
    "이 처방전/약봉투 이미지에서 모든 처방 약물 성분(drug_molecule), 카테고리(category), 용량(dosage), 투여경로(route_of_administration), 상품명(trade_name)을 추출하여 JSON 스키마 규격대로만 반환해 주세요.";

  try {
    // ---- 3) Claude 3.5 Sonnet Vision 실제 호출 ----
    const anthropicRes = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: model || CLAUDE_VISION_MODEL,
        max_tokens: 2048,
        system: system, // PRESCRIPTION_VISION_SYSTEM_PROMPT (프론트엔드에서 그대로 전달)
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: mediaType, data: base64Data },
              },
              { type: "text", text: userInstruction },
            ],
          },
        ],
      }),
    });

    if (!anthropicRes.ok) {
      // Anthropic이 돌려준 에러를 그대로 프론트엔드에 노출하지 않고, 상태 코드만 보고
      // 사람이 이해할 수 있는 메시지로 정리해서 내려줘요 (원본 에러 객체를 그대로 넘기지 않음).
      let detail = "";
      try {
        const errBody = await anthropicRes.json();
        detail = errBody?.error?.message || "";
      } catch (_) {
        /* 응답 본문이 JSON이 아닐 수도 있어요 — 무시하고 진행 */
      }
      const statusMsg =
        anthropicRes.status === 401
          ? "API Key가 유효하지 않습니다. ANTHROPIC_API_KEY 값을 다시 확인해 주세요."
          : `Vision AI 분석 요청이 실패했습니다 (HTTP ${anthropicRes.status}).${detail ? " " + detail : ""}`;
      res.status(anthropicRes.status === 401 ? 401 : 502).json({ error: statusMsg });
      return;
    }

    const anthropicJson = await anthropicRes.json();
    const rawText = (anthropicJson.content || [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    // Claude가 코드펜스(```json ... ```)로 감싸 반환하는 경우를 대비해 안전하게 벗겨내요.
    const cleaned = rawText.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      res.status(502).json({
        error: "Vision AI 응답을 JSON으로 해석하지 못했습니다. 프롬프트 또는 모델 응답을 확인해주세요.",
      });
      return;
    }

    if (!parsed || !Array.isArray(parsed.extracted_medications)) {
      res.status(502).json({ error: "Vision AI 응답 형식이 스키마와 일치하지 않습니다." });
      return;
    }

    // ---- 4) 표준 스키마 그대로 프론트엔드에 반환 ----
    res.status(200).json({
      hospital_name: parsed.hospital_name || "",
      extracted_medications: parsed.extracted_medications,
    });
  } catch (err) {
    // 네트워크 오류 등 예기치 못한 예외 — 절대 원본 err 객체를 그대로 내려보내지 않고
    // (Headers 등 직렬화 불가능한 내부 객체가 섞여있을 수 있어요) 문자열 메시지만 사용해요.
    console.error("ANALYZE_PRESCRIPTION_ERROR:", err?.message || String(err));
    res.status(500).json({ error: "Vision AI 분석 중 서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요." });
  }
}
