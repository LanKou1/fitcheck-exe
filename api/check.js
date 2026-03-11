import Anthropic from "@anthropic-ai/sdk";
import { Redis } from "@upstash/redis";

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_BYTES = 5 * 1024 * 1024; // 5MB
const DAILY_LIMIT = 20;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function getIP(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    req.headers["x-real-ip"] ||
    "unknown"
  );
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

const SYSTEM_PROMPT = `You are FitCheck.exe — a ruthlessly honest but funny Gen-Z fashion AI. You rate outfits with real expertise but deliver it with humor, slang, and specific observations about what you actually see.

RULES:
- Output ONLY valid JSON. No markdown fences, no extra text.
- Reference SPECIFIC things you see in the image (colors, items, brands, styling choices).
- Be funny and playful but NEVER mean or offensive. Think "best friend roasting you" energy.
- Tips must be genuinely useful fashion advice, not jokes.
- If you cannot see an outfit or person clearly, return: {"error":"no_outfit"}
- CRITICAL: Judge the STYLING, not the price tag. Brand names and expensive items do NOT earn bonus points on their own. A Balenciaga tee with boring basketball shorts is still a boring fit. Rate what the outfit actually looks like — the composition, coordination, and creativity — not how much it costs or what logo is on it. A well-styled thrift fit should outscore a lazy expensive one every time.

OUTPUT SCHEMA (strict):
{
  "score": <number 0-10, one decimal>,
  "verdict": <short all-caps catchy phrase, e.g. "CERTIFIED DRIP" or "FASHION CRIME SCENE">,
  "verdictSub": <one funny sentence summarizing the vibe>,
  "emoji": <single emoji capturing the overall vibe>,
  "categories": [
    {"name": "Colour Coordination", "score": <0-10>, "comment": <short funny comment>},
    {"name": "Fit & Silhouette", "score": <0-10>, "comment": <short funny comment>},
    {"name": "Drip Factor", "score": <0-10>, "comment": <short funny comment>},
    {"name": "Originality", "score": <0-10>, "comment": <short funny comment>}
  ],
  "roast": <2-3 sentence playful roast referencing specific visible details>,
  "tips": [<genuine fashion tip>, <genuine fashion tip>, <genuine fashion tip>]
}`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Rate limiting
  const ip = getIP(req);
  const key = `ratelimit:${ip}:${today()}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, 86400);
  }
  if (count > DAILY_LIMIT) {
    return res.status(429).json({
      error: "rate_limited",
      message: "You've used all your daily fits. Come back tomorrow.",
    });
  }

  const { image, mediaType, lang } = req.body;

  // Validate inputs
  if (!image || !mediaType) {
    return res.status(400).json({ error: "Missing image or mediaType" });
  }
  if (!ALLOWED_TYPES.includes(mediaType)) {
    return res.status(400).json({ error: "Invalid image type" });
  }

  // Check decoded size
  const byteLength = Buffer.byteLength(image, "base64");
  if (byteLength > MAX_BYTES) {
    return res.status(400).json({ error: "Image too large (max 5MB)" });
  }

  // Bouncer — cheap Haiku pre-check before expensive Sonnet call
  try {
    const bouncer = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 10,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: image },
            },
            {
              type: "text",
              text: "Does this image contain clothing or an outfit — whether worn by a person, laid flat, or displayed in any way? Answer YES or NO only.",
            },
          ],
        },
      ],
    });
    const bouncerAnswer = bouncer.content[0].text.trim().toUpperCase();
    if (!bouncerAnswer.startsWith("YES")) {
      return res.status(400).json({ error: "no_outfit" });
    }
  } catch (err) {
    console.error("Bouncer error:", err);
    // If bouncer fails, let the request through rather than blocking legitimate users
  }

  try {
    const langInstruction = lang === 'zh'
      ? "\n\nRespond entirely in Simplified Chinese (简体中文). All text fields (verdict, verdictSub, category names, comments, roast, tips) must be in Chinese."
      : "\n\nRespond entirely in English.";

    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: SYSTEM_PROMPT + langInstruction,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType,
                data: image,
              },
            },
            {
              type: "text",
              text: "Rate this outfit. Be specific about what you see.",
            },
          ],
        },
      ],
    });

    const raw = message.content[0].text.trim();
    let result;
    try {
      result = JSON.parse(raw);
    } catch {
      return res.status(500).json({ error: "Failed to parse AI response" });
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "API call failed" });
  }
}
