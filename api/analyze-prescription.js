/**
 * api/analyze-prescription.js
 */

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_VISION_MODEL = "claude-3-5-sonnet-20240620";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "허용되지 않은 메서드입니다. POST로 요청해주세요." });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: "API Key가 설정되지 않았습니다. 환경 변수에 ANTHROPIC_API_KEY를 등록해 주세요.",
    });
    return;
  }

  const { image, system, instruction } = req.body || {};
  if (!image || typeof image !== "string") {
    res.status(400).json({ error: "분석할 이미지(base64)가 전달되지 않았습니다." });
    return;
  }

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
    const anthropicRes = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        // 프론트엔드가 넘기는 model 파라미터를 무시하고 백엔드의 검증된 모델명으로 고정
        model: CLAUDE_VISION_MODEL,
        max_tokens: 2048,
        system: system,
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
      let detail = "";
      try {
        const errBody = await anthropicRes.json();
        detail = errBody?.error?.message || "";
      } catch (_) {}
      
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

    res.status(200).json({
      hospital_name: parsed.hospital_name || "",
      extracted_medications: parsed.extracted_medications,
    });
  } catch (err) {
    console.error("ANALYZE_PRESCRIPTION_ERROR:", err?.message || String(err));
    res.status(500).json({ error: "Vision AI 분석 중 서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요." });
  }
}
