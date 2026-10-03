import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Mic, MicOff, Pencil, Send, Users, AlertTriangle, ArrowRight, Check, ChefHat, Loader2 } from "lucide-react";
import {
  CRITERIA,
  chatTurn,
  speak,
  transcribe,
  type ChatMsg,
  type MealState,
  type TurnResult,
} from "@/lib/aajkya.functions";
import { openMic, closeMic, recordUtterance, type Mic as MicT } from "@/lib/recorder";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Aaj Kya? — What should dinner feel like tonight?" },
      { name: "description", content: "Speak or type in Hindi, English or Hinglish. Aaj Kya? updates tonight's plan and replies by voice." },
      { property: "og:title", content: "Aaj Kya? — Kitchen voice assistant" },
      { property: "og:description", content: "A conversational Hinglish kitchen assistant for tonight's dinner." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

const INITIAL: MealState = {
  diners: 2,
  mealType: "dinner",
  time: "8:00 pm",
  diet: "vegetarian",
  criteria: [],
  kitchen: [],
  procurement: [],
  activeMeal: null,
};

type Meal = { name: string; needs: string[]; tags: string[]; mins: number };
const MEALS: Meal[] = [
  { name: "Palak Paneer", needs: ["palak", "paneer"], tags: ["High protein", "Comfort food"], mins: 35 },
  { name: "Shahi Paneer", needs: ["paneer", "cream"], tags: ["High protein", "Comfort food"], mins: 40 },
  { name: "Dal Tadka & Rice", needs: ["dal"], tags: ["Comfort food", "Use what we have"], mins: 30 },
  { name: "Moong Dal Chilla", needs: ["moong dal"], tags: ["High protein", "Light", "Under 30 min"], mins: 20 },
  { name: "Aloo Gobi", needs: ["aloo", "gobi"], tags: ["Use what we have"], mins: 30 },
  { name: "Vegetable Khichdi", needs: ["rice", "dal"], tags: ["Light", "Comfort food"], mins: 25 },
  { name: "Rajma Chawal", needs: ["rajma"], tags: ["High protein", "Comfort food"], mins: 45 },
  { name: "Tofu Bhurji", needs: ["tofu"], tags: ["High protein", "Under 30 min", "Something different"], mins: 15 },
  { name: "Palak Aloo", needs: ["palak", "aloo"], tags: ["Light", "Use what we have"], mins: 25 },
  { name: "Vegetable Pulao", needs: ["rice"], tags: ["Under 30 min", "Something different"], mins: 25 },
];

function b64ToBlobUrl(b64: string, type: string) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type }));
}

function applyTurn(s: MealState, r: TurnResult): MealState {
  const kitchen = [...s.kitchen];
  for (const u of r.ingredient_updates ?? []) {
    const i = kitchen.findIndex((k) => k.item.toLowerCase() === u.item.toLowerCase());
    if (i >= 0) kitchen[i] = u;
    else kitchen.push(u);
  }
  const procurement = [...s.procurement];
  for (const u of r.procurement_updates ?? []) {
    const i = procurement.findIndex((k) => k.item.toLowerCase() === u.item.toLowerCase());
    if (i >= 0) procurement[i] = u;
    else procurement.push(u);
  }
  return {
    ...s,
    diners: r.diners ?? s.diners,
    criteria: r.criteria ? r.criteria.filter((c) => (CRITERIA as readonly string[]).includes(c)) : s.criteria,
    activeMeal: r.active_meal ?? s.activeMeal,
    kitchen,
    procurement,
  };
}

type Phase = "idle" | "listening" | "hearing" | "thinking" | "speaking";

function Index() {
  const chatFn = useServerFn(chatTurn);
  const sttFn = useServerFn(transcribe);
  const ttsFn = useServerFn(speak);

  const [step, setStep] = useState<1 | 2>(1);
  const [state, setState] = useState<MealState>(INITIAL);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");

  const stateRef = useRef(state);
  const msgsRef = useRef(messages);
  stateRef.current = state;
  msgsRef.current = messages;
  const activeRef = useRef(false);
  const micRef = useRef<MicT | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, phase]);

  const playReply = useCallback(
    async (text: string, language: string) => {
      setPhase("speaking");
      try {
        const { audio } = await ttsFn({ data: { text, language } });
        const url = b64ToBlobUrl(audio, "audio/wav");
        await new Promise<void>((res) => {
          const a = audioRef.current ?? new Audio();
          audioRef.current = a;
          a.src = url;
          a.onended = () => res();
          a.onerror = () => res();
          a.play().catch(() => res());
        });
        URL.revokeObjectURL(url);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [ttsFn],
  );

  const runTurn = useCallback(
    async (userText: string | null) => {
      setPhase("thinking");
      const next: ChatMsg[] = userText ? [...msgsRef.current, { role: "user", content: userText }] : msgsRef.current;
      if (userText) setMessages(next);
      const r = await chatFn({ data: { messages: next, state: stateRef.current, greet: !userText } });
      setState((s) => applyTurn(s, r));
      setMessages((m) => [...m, { role: "assistant", content: r.reply }]);
      await playReply(r.reply, r.language);
    },
    [chatFn, playReply],
  );

  const stopConversation = useCallback(() => {
    activeRef.current = false;
    abortRef.current?.abort();
    audioRef.current?.pause();
    closeMic(micRef.current);
    micRef.current = null;
    setPhase("idle");
    setLevel(0);
  }, []);

  const startConversation = useCallback(async () => {
    setError(null);
    // unlock audio on user gesture
    audioRef.current = audioRef.current ?? new Audio();
    try {
      micRef.current = await openMic();
    } catch {
      setError("Microphone access was blocked. Allow it, or use “Type instead”.");
      return;
    }
    activeRef.current = true;
    try {
      if (msgsRef.current.length === 0) await runTurn(null);
      while (activeRef.current && micRef.current) {
        setPhase("listening");
        const ac = new AbortController();
        abortRef.current = ac;
        const wav = await recordUtterance(micRef.current, {
          signal: ac.signal,
          onLevel: setLevel,
          onSpeechStart: () => setPhase("hearing"),
        });
        setLevel(0);
        if (!activeRef.current) break;
        if (!wav) continue;
        setPhase("thinking");
        const { transcript } = await sttFn({ data: { audio: wav, mime: "audio/wav" } });
        if (!activeRef.current) break;
        if (!transcript) continue;
        await runTurn(transcript);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      stopConversation();
    }
  }, [runTurn, sttFn, stopConversation]);

  useEffect(() => () => stopConversation(), [stopConversation]);

  const sendTyped = async () => {
    const t = draft.trim();
    if (!t || phase === "thinking") return;
    setDraft("");
    setError(null);
    try {
      await runTurn(t);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!activeRef.current) setPhase("idle");
    }
  };

  const toggleCriterion = (c: string) =>
    setState((s) => ({
      ...s,
      criteria: s.criteria.includes(c) ? s.criteria.filter((x) => x !== c) : [...s.criteria, c],
    }));

  const blocked = new Set(
    state.kitchen.filter((k) => ["MISSING", "SPOILED"].includes(k.state)).map((k) => k.item.toLowerCase()),
  );
  const feasible = MEALS.filter((m) => !m.needs.some((n) => blocked.has(n)));
  const ranked = [...feasible].sort(
    (a, b) =>
      b.tags.filter((t) => state.criteria.includes(t)).length - a.tags.filter((t) => state.criteria.includes(t)).length,
  );
  const signals = state.kitchen.filter((k) => k.state !== "AVAILABLE");
  const live = phase !== "idle" && activeRef.current;

  const phaseLabel: Record<Phase, string> = {
    idle: "Tap to speak (Continuous conversation)",
    listening: "Listening… bolo",
    hearing: "Sun rahi hoon…",
    thinking: "Soch rahi hoon…",
    speaking: "Bol rahi hoon…",
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-md pb-16">
        {/* Header */}
        <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-background/90 px-4 py-3 backdrop-blur">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-flame text-primary-foreground shadow-flame">
            <ChefHat className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-extrabold leading-none">Aaj Kya?</h1>
              <span className="rounded-md bg-warn px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-warn-foreground">
                {state.activeMeal ? "Cooking" : "Planning"}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">Kapoor Kitchen</p>
          </div>
          <span className="rounded-full border border-border bg-card px-3 py-1 text-sm font-semibold">Manager</span>
        </header>

        <main className="space-y-5 px-4 pt-5">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-muted-foreground">भोजन निर्णय प्रक्रिया</span>
            <span className="rounded-full border border-primary/30 bg-accent px-3 py-1 text-xs font-bold text-accent-foreground">
              Step {step} of 2
            </span>
          </div>

          <div className="grid grid-cols-2 gap-1 rounded-2xl border border-border bg-secondary p-1">
            {[
              { n: 1 as const, label: "Tonight's Intent" },
              { n: 2 as const, label: `Choose a Meal (${feasible.length})` },
            ].map((t) => (
              <button
                key={t.n}
                onClick={() => setStep(t.n)}
                className={`flex items-center justify-center gap-2 rounded-xl px-3 py-3 text-sm font-semibold transition ${
                  step === t.n ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"
                }`}
              >
                <span
                  className={`grid h-5 w-5 place-items-center rounded-full text-xs ${
                    step === t.n ? "bg-accent text-accent-foreground" : "bg-border"
                  }`}
                >
                  {t.n}
                </span>
                {t.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-3 rounded-2xl bg-ink px-4 py-3 text-ink-foreground">
            <span className="h-2 w-2 rounded-full bg-leaf" />
            <span className="font-bold tracking-wide text-turmeric">TONIGHT</span>
            <span className="flex-1 text-sm">
              {state.mealType} · {state.diners} people · {state.time} · {state.diet}
            </span>
            <span className="font-mono text-[11px] opacity-60">Indiranagar</span>
          </div>

          {step === 1 ? (
            <>
              <div>
                <h2 className="text-3xl font-extrabold leading-tight">What should dinner feel like tonight?</h2>
                <p className="mt-1 text-muted-foreground">Tell us what matters. We'll filter out meals that won't work.</p>
              </div>

              {/* Voice card */}
              <section className="rounded-3xl border border-border bg-card p-5 shadow-sm">
                <div className="mb-4 flex items-start justify-between gap-3">
                  <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                    State your intent in natural Hindi or English:
                  </p>
                  <button
                    onClick={() => setTyping((v) => !v)}
                    className="flex items-center gap-1 text-sm font-semibold text-primary"
                  >
                    <Pencil className="h-3.5 w-3.5" /> {typing ? "Hide typing" : "Type instead"}
                  </button>
                </div>

                {messages.length > 0 && (
                  <div ref={scrollRef} className="mb-4 max-h-72 space-y-2 overflow-y-auto pr-1">
                    {messages.map((m, i) => (
                      <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                        <div
                          className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-[15px] leading-snug ${
                            m.role === "user"
                              ? "rounded-br-sm bg-ink text-ink-foreground"
                              : "rounded-bl-sm bg-accent text-foreground"
                          }`}
                        >
                          {m.content}
                        </div>
                      </div>
                    ))}
                    {phase === "thinking" && (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" /> soch rahi hoon…
                      </div>
                    )}
                  </div>
                )}

                <button
                  onClick={live ? stopConversation : startConversation}
                  className="relative flex w-full items-center justify-center gap-3 rounded-2xl bg-flame px-5 py-4 text-lg font-bold text-primary-foreground shadow-flame transition active:scale-[0.99]"
                >
                  {live && (phase === "listening" || phase === "hearing") && (
                    <span className="absolute inset-0 rounded-2xl ring-4 ring-primary/40 animate-pulse-ring" />
                  )}
                  {live ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
                  <span>{live ? phaseLabel[phase] : phaseLabel.idle}</span>
                </button>
                {live && (
                  <div className="mt-3 flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
                      <div className="h-full bg-primary transition-[width] duration-75" style={{ width: `${level * 100}%` }} />
                    </div>
                    <span className="text-xs text-muted-foreground">tap again to end</span>
                  </div>
                )}

                {typing && (
                  <form
                    className="mt-3 flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      sendTyped();
                    }}
                  >
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      placeholder="e.g. Paneer thoda kam hai, aaj 3 log hain"
                      className="flex-1 rounded-xl border border-input bg-background px-3 py-2.5 outline-none focus:ring-2 focus:ring-ring"
                    />
                    <button
                      type="submit"
                      disabled={phase === "thinking"}
                      className="grid w-11 place-items-center rounded-xl bg-ink text-ink-foreground disabled:opacity-50"
                    >
                      <Send className="h-4 w-4" />
                    </button>
                  </form>
                )}
                {error && <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
              </section>

              {/* Criteria */}
              <section className="rounded-3xl border border-border bg-card p-5 shadow-sm">
                <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Meal intent criteria</p>
                <h3 className="mb-3 mt-1 text-lg font-bold">Select criteria that matter tonight:</h3>
                <div className="flex flex-wrap gap-2">
                  {CRITERIA.map((c) => {
                    const on = state.criteria.includes(c);
                    return (
                      <button
                        key={c}
                        onClick={() => toggleCriterion(c)}
                        className={`flex items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-semibold transition ${
                          on
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border bg-secondary text-foreground"
                        }`}
                      >
                        {on && <Check className="h-3.5 w-3.5" />}
                        {c}
                      </button>
                    );
                  })}
                </div>
              </section>

              {/* Summary */}
              <section className="rounded-3xl border border-border bg-secondary/60 p-5">
                <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Parsed input summary</p>
                <div className="mt-3 flex items-center gap-3 border-b border-border pb-3">
                  <span className="text-sm font-bold">DINERS:</span>
                  <span className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-sm font-semibold">
                    <Users className="h-4 w-4 text-primary" /> {state.diners} people
                  </span>
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <span className="text-sm font-bold">KITCHEN SIGNAL</span>
                  <button
                    onClick={() => setState((s) => ({ ...s, kitchen: [], procurement: [] }))}
                    className="text-sm text-muted-foreground"
                  >
                    Clear
                  </button>
                </div>
                <div className="mt-2 space-y-2">
                  {signals.length === 0 && state.procurement.length === 0 && (
                    <p className="text-sm text-muted-foreground">Nothing reported yet. Try “Paneer khatam hai”.</p>
                  )}
                  {signals.map((k) => (
                    <div
                      key={k.item}
                      className="flex items-start gap-2 rounded-xl border border-warn-border bg-warn px-3 py-2 text-sm font-semibold text-warn-foreground"
                    >
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span className="capitalize">
                        {k.item} reported {k.state.toLowerCase()}
                        {k.note ? ` (${k.note})` : ""}
                      </span>
                    </div>
                  ))}
                  {state.procurement.map((p) => (
                    <div key={p.item} className="rounded-xl border border-border bg-card px-3 py-2 text-sm">
                      <span className="capitalize font-semibold">{p.item}</span> order: {p.state.toLowerCase()}
                    </div>
                  ))}
                  {state.kitchen
                    .filter((k) => k.state === "AVAILABLE")
                    .map((k) => (
                      <span
                        key={k.item}
                        className="mr-1 inline-flex items-center gap-1 rounded-full bg-card px-2.5 py-1 text-xs font-semibold capitalize"
                      >
                        <Check className="h-3 w-3 text-leaf" /> {k.item}
                      </span>
                    ))}
                </div>
              </section>

              <button
                onClick={() => setStep(2)}
                className="flex w-full items-center justify-between rounded-2xl bg-flame px-6 py-4 text-lg font-bold text-primary-foreground shadow-flame"
              >
                <span className="flex-1 text-center">Find Meals ({feasible.length} Feasible Options)</span>
                <ArrowRight className="h-5 w-5" />
              </button>
            </>
          ) : (
            <section className="space-y-3">
              <h2 className="text-2xl font-extrabold">Choose a meal</h2>
              {ranked.map((m) => {
                const chosen = state.activeMeal === m.name;
                const low = m.needs.filter((n) =>
                  state.kitchen.some((k) => k.item.toLowerCase() === n && k.state === "LOW"),
                );
                return (
                  <button
                    key={m.name}
                    onClick={() => setState((s) => ({ ...s, activeMeal: m.name }))}
                    className={`w-full rounded-2xl border p-4 text-left transition ${
                      chosen ? "border-primary bg-accent" : "border-border bg-card"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-lg font-bold">{m.name}</span>
                      <span className="text-sm text-muted-foreground">{m.mins} min</span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {m.tags.map((t) => (
                        <span
                          key={t}
                          className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                            state.criteria.includes(t) ? "bg-primary text-primary-foreground" : "bg-secondary"
                          }`}
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                    {low.length > 0 && (
                      <p className="mt-2 text-xs font-semibold text-warn-foreground">Low: {low.join(", ")}</p>
                    )}
                  </button>
                );
              })}
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
