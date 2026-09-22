/**
 * api/analyze-prescription.js
 * Anthropic Claude 3.5 Sonnet Vision 백엔드 프록시
 */

export default async function handler(req, res) {
  // CORS 및 HTTP Method 검증
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  // 1) API Key 검증 (공백 제거)
  const rawKey = process.env.ANTHROPIC_API_KEY || "";
  const apiKey = rawKey.trim();

  if (!apiKey) {
    return res.status(500).json({
      error: "Vercel 환경 변수에 ANTHROPIC_API_KEY가 설정되지 않았습니다.",
    });
  }

  // 2) Body 데이터 검증
  const { image, system, instruction } = req.body || {};
  if (!image || typeof image !== "string") {
    return res.status(400).json({ error: "이미지(base64) 데이터가 누락되었습니다." });
  }

  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(image);
  if (!match) {
    return res.status(400).json({ error: "올바른 Base64 DataURL 형식이 아닙니다." });
  }

  const mediaType = match[1];
  const base64Data = match[2];

  const promptText =
    instruction ||
    "이 처방전/약봉투 이미지에서 모든 처방 약물 성분(drug_molecule), 카테고리(category), 용량(dosage), 투여경로(route_of_administration), 상품명(trade_name)을 추출하여 JSON 스키마 규격대로만 반환해 주세요.";

  try {
    // 3) Anthropic Messages API 호출 (정확한 Endpoint URL 및 Header 지정)
    const anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-3-5-sonnet-20240620",
        max_tokens: 2048,
        system: system || undefined,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mediaType,
                  data: base64Data
                }
              },
              {
                type: "text",
                text: promptText
              }
            ]
          }
        ]
      })
    });

    const resStatus = anthropicResponse.status;

    if (!anthropicResponse.ok) {
      let errorDetail = "";
      try {
        const errJson = await anthropicResponse.json();
        errorDetail = errJson?.error?.message || JSON.stringify(errJson);
      } catch (_) {
        errorDetail = await anthropicResponse.text();
      }

      return res.status(502).json({
        error: `Vision AI 분석 요청이 실패했습니다 (HTTP ${resStatus}). ${errorDetail}`
      });
    }

    const data = await anthropicResponse.json();
    const rawText = (data.content || [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    // Markdown Code Block (```json ... ```) 제거
    const cleanedJsonText = rawText
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    let parsedResult;
    try {
      parsedResult = JSON.parse(cleanedJsonText);
    } catch (parseError) {
      return res.status(502).json({
        error: "AI 응답을 JSON으로 파싱하지 못했습니다.",
        rawText: rawText
      });
    }

    if (!parsedResult || !Array.isArray(parsedResult.extracted_medications)) {
      return res.status(502).json({
        error: "Vision AI 응답 형식이 추출 스키마와 일치하지 않습니다.",
        parsedResult
      });
    }

    // 4) 성공 응답 반환
    return res.status(200).json({
      hospital_name: parsedResult.hospital_name || "",
      extracted_medications: parsedResult.extracted_medications
    });

  } catch (err) {
    console.error("SERVER_ERROR:", err);
    return res.status(500).json({
      error: `서버 내부 오류가 발생했습니다: ${err?.message || String(err)}`
    });
  }
}
