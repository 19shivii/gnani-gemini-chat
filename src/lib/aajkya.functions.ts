import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export const CRITERIA = [
  "High protein",
  "Under 30 min",
  "Light",
  "Use what we have",
  "Comfort food",
  "Something different",
  "Anything works",
] as const;

export type KitchenItem = { item: string; state: string; note: string };
export type ProcItem = { item: string; state: string };
export type MealState = {
  diners: number;
  mealType: string;
  time: string;
  diet: string;
  criteria: string[];
  kitchen: KitchenItem[];
  procurement: ProcItem[];
  activeMeal: string | null;
  lastMeal: string | null;
};
export type ChatMsg = { role: "user" | "assistant"; content: string };

const stateSchema = z.object({
  diners: z.number(),
  mealType: z.string(),
  time: z.string(),
  diet: z.string(),
  criteria: z.array(z.string()),
  kitchen: z.array(z.object({ item: z.string(), state: z.string(), note: z.string() })),
  procurement: z.array(z.object({ item: z.string(), state: z.string() })),
  activeMeal: z.string().nullable(),
  lastMeal: z.string().nullable(),
});

const turnInput = z.object({
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })),
  state: stateSchema,
  greet: z.boolean().optional(),
});

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "reply",
    "language",
    "event_type",
    "diners",
    "criteria",
    "ingredient_updates",
    "procurement_updates",
    "active_meal",
  ],
  properties: {
    reply: { type: "string" },
    language: { type: "string", enum: ["hi-IN", "en-IN"] },
    event_type: { type: "string" },
    diners: { type: ["number", "null"] },
    criteria: { type: ["array", "null"], items: { type: "string" } },
    ingredient_updates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["item", "state", "note"],
        properties: {
          item: { type: "string" },
          state: { type: "string", enum: ["AVAILABLE", "LOW", "MISSING", "UNCERTAIN", "SPOILED"] },
          note: { type: "string" },
        },
      },
    },
    procurement_updates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["item", "state"],
        properties: {
          item: { type: "string" },
          state: { type: "string", enum: ["ORDERED", "CANCELLED", "DELIVERED", "DELAYED", "UNKNOWN"] },
        },
      },
    },
    active_meal: { type: ["string", "null"] },
  },
};

export type TurnResult = {
  reply: string;
  language: "hi-IN" | "en-IN";
  event_type: string;
  diners: number | null;
  criteria: string[] | null;
  ingredient_updates: KitchenItem[];
  procurement_updates: ProcItem[];
  active_meal: string | null;
};

export const chatTurn = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => turnInput.parse(d))
  .handler(async ({ data }): Promise<TurnResult> => {
    const { BASE_SYSTEM_PROMPT } = await import("./system-prompt.server");
    const key = process.env["LOVABLE_API_KEY"];
    if (!key) throw new Error("AI is not configured");

    const s = data.state;
    const context = `
==================================================
LIVE CURRENT CONTEXT (from the app — this overrides any example context above)
==================================================
Speaker role: manager
Meal: ${s.mealType} at ${s.time}, diet: ${s.diet}
Number of diners: ${s.diners}
Active meal: ${s.activeMeal ?? "not chosen yet"}
Last night's meal: ${s.lastMeal ?? "not recorded"} (avoid suggesting the same meal again tonight unless the user asks for it)
Selected meal intent criteria: ${s.criteria.join(", ") || "none"}
Allowed criteria values (use EXACTLY these strings): ${CRITERIA.join(" | ")}
Kitchen Memory:
${s.kitchen.map((k) => `* ${k.item}: ${k.state}${k.note ? ` (${k.note})` : ""}`).join("\n") || "* (nothing reported yet)"}
Procurement:
${s.procurement.map((p) => `* ${p.item}: ${p.state}`).join("\n") || "* (none)"}

==================================================
OUTPUT FORMAT (internal, never spoken)
==================================================
Return JSON matching the schema.
- reply: what you will SAY out loud to the user (1–2 short natural sentences, no internal terms). Keep the conversation going: when useful, ask one short follow-up (e.g. about missing ingredients, diners, or what kind of dinner they want).
- language: hi-IN if reply is Hindi/Hinglish, en-IN if English.
- diners: new headcount if the user changed it, else null.
- criteria: the FULL new list of selected criteria if the user expressed meal intent (e.g. "kuch halka" → Light, "jaldi" → Under 30 min, "protein wala" → High protein), else null.
- ingredient_updates / procurement_updates: only changes from the latest user message (apply corrections).
- active_meal: new meal name if user chose/changed the meal, else null.
Write Hindi replies in Roman script (Hinglish) so the voice reads them naturally.`;

    const input = data.greet
      ? [{ role: "user", content: "[SYSTEM: The user just opened the voice assistant. Greet them briefly in Hinglish as the Aaj Kya kitchen assistant and ask one short question about tonight's dinner or what's available in the kitchen. Return no state changes.]" }]
      : data.messages.map((m) => ({ role: m.role, content: m.content }));

    const res = await fetch("https://ai.gateway.lovable.dev/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        "Lovable-API-Key": key,
        "X-Lovable-AIG-SDK": "fetch",
      },
      body: JSON.stringify({
        model: "openai/gpt-6-astra",
        instructions: BASE_SYSTEM_PROMPT + "\n" + context,
        input,
        stream: true,
        store: false,
        reasoning: { effort: "low" },
        text: { format: { type: "json_schema", name: "turn", strict: true, schema: OUTPUT_SCHEMA } },
      }),
    });
    if (!res.ok || !res.body) {
      const t = await res.text().catch(() => "");
      if (res.status === 429) throw new Error("Too many requests, please wait a moment.");
      if (res.status === 402) throw new Error("AI credits exhausted. Please add credits to your workspace.");
      throw new Error(`AI failed (${res.status}): ${t.slice(0, 300)}`);
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let text = "";
    let refusal = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const ev = JSON.parse(payload);
            if (ev.type === "response.output_text.delta") text += ev.delta;
            if (ev.type === "response.refusal.delta") refusal = true;
            if (ev.type === "error" || ev.type === "response.failed")
              throw new Error(ev.error?.message ?? ev.response?.error?.message ?? "AI stream failed");
          } catch (e) {
            if (e instanceof SyntaxError) continue;
            throw e;
          }
        }
      }
    }
    if (refusal) throw new Error("The assistant declined to answer that.");
    try {
      return JSON.parse(text) as TurnResult;
    } catch {
      return {
        reply: text || "Sorry, ek baar phir boliye?",
        language: "hi-IN",
        event_type: "UNCLEAR",
        diners: null,
        criteria: null,
        ingredient_updates: [],
        procurement_updates: [],
        active_meal: null,
      };
    }
  });

export const transcribe = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ audio: z.string(), mime: z.string() }).parse(d))
  .handler(async ({ data }) => {
    const key = process.env["GNANI_API_KEY"];
    if (!key) throw new Error("Gnani key missing");
    const bytes = Uint8Array.from(atob(data.audio), (c) => c.charCodeAt(0));
    const fd = new FormData();
    fd.append("audio_file", new Blob([bytes], { type: data.mime }), "speech.wav");
    fd.append("language_code", "hi-IN");
    const res = await fetch("https://api.vachana.ai/stt/v3", {
      method: "POST",
      headers: { "X-API-Key-ID": key },
      body: fd,
    });
    const j = (await res.json().catch(() => ({}))) as { transcript?: string; error?: { message?: string } };
    if (!res.ok) throw new Error(`Speech recognition failed: ${j.error?.message ?? res.status}`);
    return { transcript: (j.transcript ?? "").trim() };
  });

export const speak = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ text: z.string().min(1), language: z.string() }).parse(d),
  )
  .handler(async ({ data }) => {
    const key = process.env["GNANI_API_KEY"];
    if (!key) throw new Error("Gnani key missing");
    const res = await fetch("https://api.vachana.ai/api/v1/tts/inference", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key-ID": key },
      body: JSON.stringify({
        text: data.text,
        voice: "Nalini",
        model: "timbre-v2.5",
        language: data.language === "en-IN" ? "en-IN" : "hi-IN",
        speed: 1.0,
        audio_config: { sample_rate: 24000, num_channels: 1, sample_width: 2, encoding: "linear_pcm", container: "wav" },
      }),
    });
    if (!res.ok) throw new Error(`Voice reply failed (${res.status})`);
    const buf = new Uint8Array(await res.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { audio: btoa(bin) };
  });
