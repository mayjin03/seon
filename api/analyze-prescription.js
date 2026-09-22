/**
 * api/analyze-prescription.js
 */

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const rawKey = process.env.ANTHROPIC_API_KEY || "";
  const apiKey = rawKey.replace(/["'\r\n\s]/g, "").trim();

  if (!apiKey) {
    return res.status(500).json({
      error: "Vercel 환경 변수에 ANTHROPIC_API_KEY가 설정되지 않았습니다.",
    });
  }

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
    const anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "accept": "application/json"
      },
      body: JSON.stringify({
        model: "claude-3-sonnet-20240229",
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
    const responseText = await anthropicResponse.text();

    if (!anthropicResponse.ok) {
      return res.status(502).json({
        error: `Anthropic API 응답 에러 (HTTP ${resStatus})`,
        raw_anthropic_response: responseText,
        key_prefix: apiKey.substring(0, 12)
      });
    }

    let data;
    try {
      data = JSON.parse(responseText);
    } catch (_) {
      return res.status(502).json({ error: "Anthropic 응답 파싱 실패", raw: responseText });
    }

    const rawText = (data.content || [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

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
