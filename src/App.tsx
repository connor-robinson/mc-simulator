import React, { useEffect, useMemo, useRef, useState, } from "react";

import { PenLine, Notebook, ExternalLink, Trash2 } from "lucide-react";

/* MCQ Simulator — TSX, Tailwind (dark, minimalist)
   Added per your requests:
   - Session category: math1 / math2 / physics
   - Setup: preview last two notes (Math = math1+math2 combined, Physics separate) with a toggle
   - History: inline rename (kept) + subject badges + progress charts (Math vs Physics) showing score% trend
   - Scatter: adds a time-progression line; shows unanswered distinctly; keeps guessed = hollow ring
   - Robust storage & backup (kept), submit confirm modal (kept), NEXT primary (kept)
*/

const LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;
type Letter = typeof LETTERS[number];

const MISTAKE_OPTIONS = [
  "None",
  "Calc / algebra mistakes",
  "Read the question wrong",
  "Failed to spot setup",
  "Understanding",
  "Formula recall",
  "Diagrams",
  "Poor Time management",
  "Other",
] as const;
type MistakeTag = typeof MISTAKE_OPTIONS[number];

type Subject = "math1" | "math2" | "physics";

const LS_KEY = "mcqSessionsV1";
const LS_BACKUP = "mcqSessionsV1__backup";

/* ---------- Types ---------- */
type Answer = { choice: Letter | null; other: string };

type SessionMeta = {
  id: string;
  name: string;
  subject: Subject;                 // NEW
  startNum: number;
  endNum: number;
  startedAt: number;
  endedAt?: number;
  minutes: number;
  perQuestionSec: number[];
  answers: Answer[];
  correctFlags?: (boolean | null)[];
  guessedFlags?: boolean[];
  mistakeTags?: MistakeTag[];
  score?: { correct: number; total: number };
  notes?: string;
  version: 1;
};

type Store = { sessions: SessionMeta[] };

/* ---------- Helpers ---------- */
const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(" ");
const fmtTime = (sec: number) => {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};
const now = () => Date.now();

/* ---------- Storage (robust) ---------- */
function isSession(s: any): boolean {
  // Be permissive to allow migration; required minimal fields:
  return s && typeof s.id === "string" && Array.isArray(s.answers) && Array.isArray(s.perQuestionSec);
}
function addMissingFields(s: any): SessionMeta {
  // Migrate missing fields with safe defaults
  const subject: Subject = (s.subject === "math1" || s.subject === "math2" || s.subject === "physics") ? s.subject : "math1";
  const version = 1 as const;
  return { subject, version, ...s };
}
function sanitize(store: any): Store | null {
  if (!store || typeof store !== "object") return null;
  if (!Array.isArray(store.sessions)) return null;
  const sane = store.sessions.filter(isSession).map(addMissingFields);
  return { sessions: sane };
}
function readRaw(key: string) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeRaw(key: string, value: string) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}
function loadStore(): Store {
  const raw = readRaw(LS_KEY);
  if (!raw) {
    const empty: Store = { sessions: [] };
    writeRaw(LS_KEY, JSON.stringify(empty));
    writeRaw(LS_BACKUP, JSON.stringify(empty));
    return empty;
  }
  try {
    const parsed = JSON.parse(raw);
    const clean = sanitize(parsed);
    if (clean) return clean;
    const b = readRaw(LS_BACKUP);
    if (b) {
      const parsedB = JSON.parse(b);
      const cleanB = sanitize(parsedB);
      if (cleanB) { writeRaw(LS_KEY, JSON.stringify(cleanB)); return cleanB; }
    }
  } catch {
    const b = readRaw(LS_BACKUP);
    if (b) {
      try {
        const parsedB = JSON.parse(b);
        const cleanB = sanitize(parsedB);
        if (cleanB) { writeRaw(LS_KEY, JSON.stringify(cleanB)); return cleanB; }
      } catch {}
    }
  }
  const empty: Store = { sessions: [] };
  writeRaw(LS_KEY, JSON.stringify(empty));
  writeRaw(LS_BACKUP, JSON.stringify(empty));
  return empty;
}
/** Transactional update with validation + backup */
function mutateStore(fn: (store: Store) => Store): Store {
  const current = loadStore();
  const updated = fn(structuredClone(current));
  const clean = sanitize(updated);
  if (!clean) return current;
  const old = readRaw(LS_KEY);
  if (old) writeRaw(LS_BACKUP, old);
  writeRaw(LS_KEY, JSON.stringify(clean));
  return clean;
}
function upsertSession(s: SessionMeta) {
  mutateStore((st) => {
    const i = st.sessions.findIndex((x) => x.id === s.id);
    if (i >= 0) st.sessions[i] = s; else st.sessions.unshift(s);
    return st;
  });
}
function removeSession(id: string) {
  mutateStore((st) => {
    st.sessions = st.sessions.filter((s) => s.id !== id);
    return st;
  });
}

/* ---------- App ---------- */
export default function App() {
  type View = "setup" | "quiz" | "review" | "history";
  const [view, setView] = useState<View>("setup");

  // Setup
  const [sessionName, setSessionName] = useState("");
  const [subject, setSubject] = useState<Subject>("math1");         // NEW
  const [startNum, setStartNum] = useState<number>(1);
  const [endNum, setEndNum] = useState<number>(20);
  const [minutes, setMinutes] = useState<number>(30);

  // Notes
  const [sessionNotes, setSessionNotes] = useState<string>("");

  // Setup notes preview toggle (math combines M1+M2)
  const [notesPreviewScope, setNotesPreviewScope] = useState<"math" | "physics">("math"); // NEW

  // Active/loaded session
  const [sessionId, setSessionId] = useState<string>("");
  const [currentIdx, setCurrentIdx] = useState(0);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [perQSec, setPerQSec] = useState<number[]>([]);
  const [correctFlags, setCorrectFlags] = useState<(boolean | null)[]>([]);
  const [guessedFlags, setGuessedFlags] = useState<boolean[]>([]);
  const [mistakeTags, setMistakeTags] = useState<MistakeTag[]>([]);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [endedAt, setEndedAt] = useState<number | null>(null);
  const [deadline, setDeadline] = useState<number | null>(null);

  // Submit modal
  const [confirmOpen, setConfirmOpen] = useState(false);

  const totalQuestions = Math.max(0, endNum - startNum + 1);
  const correctCount = useMemo(() => correctFlags.filter((x) => x === true).length, [correctFlags]);

  /* Timer */
  const tickRef = useRef<number | null>(null);
  useEffect(() => {
    if (view !== "quiz" || !deadline) return;
    const i = window.setInterval(() => {
      const left = Math.max(0, deadline - now());
      if (left <= 0) {
        window.clearInterval(i);
        doSubmit();
        return;
      }
      setPerQSec((prev) => {
        const a = prev.slice();
        a[currentIdx] = (a[currentIdx] ?? 0) + 1;
        return a;
      });
    }, 1000);
    tickRef.current = i;
    return () => { if (tickRef.current) window.clearInterval(tickRef.current); };
  }, [view, deadline, currentIdx]);

  const remainingSec = Math.max(0, deadline ? Math.ceil((deadline - now()) / 1000) : minutes * 60);

  /* Start quiz */
  function startQuiz() {
    setSessionNotes("");
    if (Number.isNaN(startNum) || Number.isNaN(endNum) || startNum > endNum) return alert("Check your question range.");
    if (minutes <= 0) return alert("Timer must be positive.");
    const N = endNum - startNum + 1;
    const initAnswers: Answer[] = Array.from({ length: N }, () => ({ choice: null, other: "" }));
    const initTimes = Array.from({ length: N }, () => 0);
    const initCorrect = Array.from({ length: N }, () => null as (boolean | null));
    const initGuess = Array.from({ length: N }, () => false);
    const initTags = Array.from({ length: N }, () => "None" as MistakeTag);

    const id = crypto.randomUUID();
    const t0 = now();

    setSessionId(id);
    setAnswers(initAnswers);
    setPerQSec(initTimes);
    setCorrectFlags(initCorrect);
    setGuessedFlags(initGuess);
    setMistakeTags(initTags);
    setCurrentIdx(0);
    setStartedAt(t0);
    setEndedAt(null);
    setDeadline(t0 + minutes * 60 * 1000);
    setView("quiz");

    upsertSession({
      id,
      name: sessionName.trim() || `Session ${new Date(t0).toLocaleString()}`,
      subject,                              // NEW
      startNum,
      endNum,
      startedAt: t0,
      minutes,
      perQuestionSec: initTimes,
      answers: initAnswers,
      correctFlags: initCorrect,
      guessedFlags: initGuess,
      mistakeTags: initTags,
      notes: "",
      version: 1,
    });
  }

  /* Submit */
  function doSubmit() {
    if (!sessionId || startedAt == null) return;
    const t1 = now();
    const meta: SessionMeta = {
      id: sessionId,
      name: sessionName.trim() || `Session ${new Date(startedAt).toLocaleString()}`,
      subject,
      startNum,
      endNum,
      startedAt,
      endedAt: t1,
      minutes,
      perQuestionSec: perQSec,
      answers,
      correctFlags,
      guessedFlags,
      mistakeTags,
      score: { correct: correctCount, total: totalQuestions },
      notes: sessionNotes,
      version: 1,
    };
    upsertSession(meta);
    setEndedAt(t1);
    setDeadline(null);
    setConfirmOpen(false);
    setView("review");
  }
  function handleSubmit() { setConfirmOpen(true); }

  /* Open from History */
  function openForMarking(s: SessionMeta) {
    setSessionId(s.id);
    setSessionName(s.name);
    setSubject(s.subject ?? "math1");
    setStartNum(s.startNum);
    setEndNum(s.endNum);
    setMinutes(s.minutes);
    setAnswers(s.answers.slice());
    setPerQSec(s.perQuestionSec.slice());
    setCorrectFlags((s.correctFlags ?? Array.from({ length: s.answers.length }, () => null)).slice());
    setGuessedFlags((s.guessedFlags ?? Array.from({ length: s.answers.length }, () => false)).slice());
    setMistakeTags((s.mistakeTags ?? Array.from({ length: s.answers.length }, () => "None" as MistakeTag)).slice());
    setStartedAt(s.startedAt);
    setEndedAt(s.endedAt ?? null);
    setDeadline(null);
    setCurrentIdx(0);
    setSessionNotes(s.notes ?? "");
    setView("review");
  }

  /* Local UI helpers */
  function setChoice(idx: number, letter: Letter) {
    setAnswers((prev) => { const a = prev.slice(); a[idx] = { ...a[idx], choice: letter }; return a; });
  }
  function setOther(idx: number, text: string) {
    setAnswers((prev) => { const a = prev.slice(); a[idx] = { ...a[idx], other: text }; return a; });
  }
  function toggleGuess(idx: number) {
    setGuessedFlags((prev) => { const a = prev.slice(); a[idx] = !a[idx]; return a; });
  }
  function nav(d: number) { setCurrentIdx((i) => Math.min(Math.max(0, i + d), totalQuestions - 1)); }
  function jumpTo(i: number) { setCurrentIdx(i); }

  const questionNumbers = useMemo(
    () => Array.from({ length: totalQuestions }, (_, i) => startNum + i),
    [startNum, totalQuestions]
  );

  /* Setup: last two notes preview for chosen scope */
  const lastTwoNotes = useMemo(() => {
    const { sessions } = loadStore();
    const group = notesPreviewScope === "math"
      ? sessions.filter(s => s.subject === "math1" || s.subject === "math2")
      : sessions.filter(s => s.subject === "physics");
    return group
      .filter(s => (s.notes ?? "").trim().length > 0)
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
      .slice(0, 2);
  }, [notesPreviewScope, view]); // re-eval when you open Setup or change scope

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 antialiased selection:bg-neutral-800">
      <TopBar
        view={view}
        onNavigate={(v) => setView(v)}
        quizLocked={view === "quiz"}
        onSubmitClick={handleSubmit}
      />

      <main className="mx-auto max-w-5xl px-4 pb-24 pt-8">
        {/* Setup */}
        {view === "setup" && (
          <Card className="p-6">
            <h1 className="text-2xl font-semibold tracking-tight">MCQ Session Setup</h1>
            <p className="mt-1 text-sm text-neutral-400">Minimalist, keyboard-friendly, and fast.</p>

            <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <LabeledInput label="Session name (optional)" value={sessionName} onChange={setSessionName} placeholder="e.g. ESAT M1 Set A" />
              <LabeledNumber label="Timer (minutes)" value={minutes} onChange={setMinutes} min={1} />
              <LabeledNumber label="Start question #" value={startNum} onChange={setStartNum} />
              <LabeledNumber label="End question # (inclusive)" value={endNum} onChange={setEndNum} />
            </div>

            {/* Subject picker */}
            <div className="mt-4">
              <div className="text-sm text-neutral-400 mb-1">Subject</div>
              <div className="flex gap-2">
                {(["math1","math2","physics"] as Subject[]).map((s) => (
                  <button
                    key={s}
                    onClick={() => setSubject(s)}
                    className={cx(
                      "rounded-lg px-3 py-1 text-sm ring-1",
                      subject === s ? "bg-neutral-100 text-neutral-900 ring-neutral-200" : "bg-neutral-950 text-neutral-200 ring-neutral-800 hover:bg-neutral-900"
                    )}
                  >
                    {s.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            {/* Notes preview (last two for chosen scope) */}
            <Card className="mt-6 p-4">
              <div className="mb-3 flex items-center justify-between">
                <div className="text-sm text-neutral-400">Recent notes preview</div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setNotesPreviewScope("math")}
                    className={cx(
                      "rounded-full px-3 py-1 text-xs ring-1",
                      notesPreviewScope === "math" ? "bg-neutral-100 text-neutral-900 ring-neutral-200" : "bg-neutral-950 text-neutral-200 ring-neutral-800 hover:bg-neutral-900"
                    )}
                    title="Math = M1 + M2"
                  >
                    Math (M1+M2)
                  </button>
                  <button
                    onClick={() => setNotesPreviewScope("physics")}
                    className={cx(
                      "rounded-full px-3 py-1 text-xs ring-1",
                      notesPreviewScope === "physics" ? "bg-neutral-100 text-neutral-900 ring-neutral-200" : "bg-neutral-950 text-neutral-200 ring-neutral-800 hover:bg-neutral-900"
                    )}
                  >
                    Physics
                  </button>
                </div>
              </div>
              {lastTwoNotes.length === 0 ? (
                <div className="text-xs text-neutral-500">No previous notes in this category yet.</div>
              ) : (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {lastTwoNotes.map((s) => (
                    <div key={s.id} className="rounded-xl bg-neutral-900/50 p-3 ring-1 ring-neutral-900">
                      <div className="flex items-center justify-between mb-1">
                        <div className="text-xs text-neutral-400">{new Date(s.startedAt).toLocaleString()}</div>
                        <SubjectBadge subject={s.subject} />
                      </div>
                      <div className="text-xs text-neutral-300 whitespace-pre-wrap">{s.notes}</div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <div className="mt-6 flex items-center justify-between gap-3">
              <div className="text-xs text-neutral-400">
                Range size: <span className="text-neutral-200 font-medium">{totalQuestions}</span>
              </div>
              <div className="flex gap-2">
                <Button onClick={() => setView("history")}>View history</Button>
                <Button variant="primary" onClick={startQuiz}>Start</Button>
              </div>
            </div>
          </Card>
        )}

        {/* Quiz */}
        {view === "quiz" && (
          <div className="space-y-6">
            <Card className="p-5 flex items-center justify-between">
              <div className="text-sm text-neutral-400">Time left</div>
              <div className="text-4xl font-bold tabular-nums tracking-tight">{fmtTime(remainingSec)}</div>
              <div className="text-sm text-neutral-400">Session {sessionName || "(unnamed)"} </div>
            </Card>

            <Card className="p-6">
              <div className="mb-4 flex items-center gap-4">
                <div className="rounded bg-indigo-900 px-5 py-2 text-2xl font-extrabold text-white shadow">
                  Question {questionNumbers[currentIdx]}
                </div>
                <SubjectBadge subject={subject} />
                <button
                  className={cx(
                    "rounded px-2 py-1 text-xs transition",
                    guessedFlags[currentIdx]
                      ? "bg-indigo-500 text-neutral-100 ring-1 ring-indigo-300"
                      : "bg-neutral-950 text-neutral-200 hover:bg-neutral-900 ring-1 ring-neutral-800"
                  )}
                  onClick={() => toggleGuess(currentIdx)}
                  title="Toggle guess"
                >
                  Guess?
                </button>
              </div>

              <div className="grid grid-flow-col auto-cols-fr gap-3 overflow-x-auto">
                {LETTERS.map((L) => (
                  <ChoicePill key={L} letter={L} selected={answers[currentIdx]?.choice === L} onClick={() => setChoice(currentIdx, L)} />
                ))}
              </div>

              <div className="mt-4">
                <label className="text-sm text-neutral-400">Other / notes</label>
                <input
                  value={answers[currentIdx]?.other ?? ""}
                  onChange={(e) => setOther(currentIdx, e.target.value)}
                  placeholder="Type anything (e.g., 'unsure between C/D')"
                  className="mt-1 w-full rounded-xl bg-neutral-900/60 px-3 py-2 outline-none ring-1 ring-neutral-800 focus:ring-2 focus:ring-neutral-600"
                />
              </div>

              <div className="mt-6 flex items-center justify-between gap-3">
                <div className="text-xs text-neutral-500">
                  Time on this question: <span className="text-neutral-300 tabular-nums">{fmtTime(perQSec[currentIdx] ?? 0)}</span>
                </div>
                <div className="flex gap-2">
                  <Button onClick={() => nav(-1)} disabled={currentIdx === 0}>Prev</Button>
                  <Button variant="primary" onClick={() => nav(+1)} disabled={currentIdx === totalQuestions - 1}>Next</Button>
                </div>
              </div>
            </Card>

            <Card className="p-5">
              <div className="mb-3 text-sm text-neutral-400">Quick jump</div>
              <div className="grid grid-cols-6 gap-2 sm:grid-cols-10">
                {questionNumbers.map((q, i) => (
                  <button
                    key={q}
                    onClick={() => jumpTo(i)}
                    className={cx(
                      "rounded-lg px-2 py-2 text-sm tabular-nums ring-1",
                      currentIdx === i
                        ? "bg-neutral-100 text-neutral-900 ring-neutral-200"
                        : answers[i]?.choice
                        ? "bg-neutral-900 ring-neutral-800"
                        : "bg-neutral-950 ring-neutral-900 hover:bg-neutral-900"
                    )}
                    title={`Q${q}`}
                  >
                    {q}
                  </button>
                ))}
              </div>
            </Card>
          </div>
        )}

        {/* Review */}
        {view === "review" && (
          <div className="space-y-6">
            <HeaderBlock title="Review & Mark" subtitle="Toggle notes (?), mark ✓/✗, flag guesses, tag mistakes. Score updates automatically." />
            <Card className="p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm text-neutral-400">Auto score</div>
                <div className="rounded-full bg-neutral-900 px-3 py-1 text-xs">
                  {correctCount}/{totalQuestions}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
                {questionNumbers.map((q, i) => (
                  <div key={q} className="rounded-xl bg-neutral-900/50 p-3">
                    <div className="flex items-center justify-between">
                      <div className="text-sm">
                        <span className="text-neutral-400">{q}.</span>{" "}
                        <span className="font-medium">{answers[i]?.choice ?? "—"}</span>
                        {guessedFlags[i] && (
                          <span className="ml-2 rounded-sm bg-amber-400/90 px-1.5 py-0.5 text-[10px] font-medium text-neutral-900">guess</span>
                        )}
                      </div>
                      <div className="text-xs text-neutral-500 tabular-nums">{fmtTime(perQSec[i] ?? 0)}</div>
                    </div>

                    <div className="mt-2 flex items-center justify-between gap-2">
                      <div className="flex overflow-hidden rounded-lg ring-1 ring-neutral-800">
                        {LETTERS.map((L) => (
                          <button
                            key={L}
                            className={cx("px-2 py-1 text-xs", answers[i]?.choice === L ? "bg-neutral-100 text-neutral-900" : "hover:bg-neutral-800")}
                            onClick={() => setChoice(i, L)}
                          >
                            {L}
                          </button>
                        ))}
                      </div>

                      <div className="flex gap-1">
                        <button
                          className={cx(
                            "px-2 py-1 text-xs rounded-md ring-1",
                            correctFlags[i] === true ? "bg-emerald-500/90 text-neutral-900 ring-emerald-400" : "bg-neutral-950 text-neutral-200 ring-neutral-800 hover:bg-neutral-900"
                          )}
                          title="Mark correct"
                          onClick={() => setCorrectFlags((prev) => { const a = prev.slice(); a[i] = true; return a; })}
                        >✓</button>
                        <button
                          className={cx(
                            "px-2 py-1 text-xs rounded-md ring-1",
                            correctFlags[i] === false ? "bg-rose-500/90 text-neutral-900 ring-rose-400" : "bg-neutral-950 text-neutral-200 ring-neutral-800 hover:bg-neutral-900"
                          )}
                          title="Mark wrong"
                          onClick={() => setCorrectFlags((prev) => { const a = prev.slice(); a[i] = false; return a; })}
                        >✗</button>
                        <button
                          className={cx(
                            "px-2 py-1 text-xs rounded-md ring-1",
                            guessedFlags[i] ? "bg-amber-400/90 text-neutral-900 ring-amber-300" : "bg-neutral-950 text-neutral-200 ring-neutral-800 hover:bg-neutral-900"
                          )}
                          title="Toggle guess"
                          onClick={() => toggleGuess(i)}
                        >?</button>
                        {answers[i]?.other && (
                          <button
                            className="px-2 py-1 text-xs rounded-md ring-1 bg-neutral-950 text-neutral-200 ring-neutral-800 hover:bg-neutral-900"
                            title="Show notes"
                            onClick={(e) => {
                              const el = e.currentTarget.parentElement?.parentElement?.nextElementSibling as HTMLDivElement | null;
                              if (el) el.classList.toggle("hidden");
                            }}
                          >note</button>
                        )}
                      </div>
                    </div>

                    {answers[i]?.other && (
                      <div className="hidden mt-2 rounded-lg bg-neutral-950/70 p-2 text-xs text-neutral-300 ring-1 ring-neutral-900">{answers[i]?.other}</div>
                    )}

                    <div className="mt-2">
                      <select
                        className="w-full rounded-lg bg-neutral-950 px-2 py-1 text-xs ring-1 ring-neutral-800 hover:bg-neutral-900"
                        value={mistakeTags[i] ?? "None"}
                        onChange={(e) => {
                          const v = e.target.value as MistakeTag;
                          setMistakeTags((prev) => { const a = prev.slice(); a[i] = v; return a; });
                        }}
                      >
                        {MISTAKE_OPTIONS.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                      </select>
                    </div>
                  </div>
                ))}
              </div>

              {/* Notes */}
              <Card className="p-4 mt-6">
                <div className="mb-2 text-sm text-neutral-400">Session Notes / what to improve</div>
                <textarea
                  rows={5}
                  placeholder="e.g., Review SUVAT; practice equation setup; double-check unit conversions."
                  value={sessionNotes}
                  onChange={(e) => setSessionNotes(e.target.value)}
                  className="w-full rounded-xl bg-neutral-900/60 px-3 py-2 outline-none ring-1 ring-neutral-800 focus:ring-2 focus:ring-neutral-600"
                />
                <div className="mt-2 text-xs text-neutral-500">Saved with the session on save/submit.</div>
              </Card>

              {/* Charts */}
              <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2">
                <MistakeChart tags={mistakeTags} />
                <TimeCorrectScatter
                  startNum={startNum}
                  perQSec={perQSec}
                  correctFlags={correctFlags}
                  guessedFlags={guessedFlags}
                  answers={answers}
                />
              </div>

              <div className="mt-4 text-right">
                <Button onClick={() => setView("setup")}>New session</Button>
                <Button
                  variant="primary"
                  className="ml-2"
                  onClick={() => {
                    if (!sessionId || startedAt == null) return;
                    upsertSession({
                      id: sessionId,
                      name: sessionName.trim() || `Session ${new Date(startedAt).toLocaleString()}`,
                      subject,
                      startNum,
                      endNum,
                      startedAt,
                      endedAt: endedAt ?? now(),
                      minutes,
                      perQuestionSec: perQSec,
                      answers,
                      correctFlags,
                      guessedFlags,
                      mistakeTags,
                      score: { correct: correctCount, total: totalQuestions },
                      notes: sessionNotes,
                      version: 1,
                    });
                    setView("history");
                  }}
                >
                  Save to history
                </Button>
              </div>
            </Card>
          </div>
        )}

        {/* History (rename kept + subject + progress charts) */}
        {view === "history" && (
          <>
            <ProgressPanel />
            <HistoryMistakeSummary />   {/* <- new pie chart section */}
            <HistoryView
              onOpen={(s) => openForMarking(s)}
              onDelete={(id) => {
                removeSession(id);
                window.dispatchEvent(new StorageEvent("storage", { key: LS_KEY }));
              }}
            />
          </>
        )}
      </main>

      {/* Confirm Submit Modal */}
      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div className="w-full max-w-md rounded-2xl border border-neutral-800 bg-neutral-950 p-5">
            <div className="text-lg font-semibold">Submit session?</div>
            <p className="mt-1 text-sm text-neutral-400">
              You can still edit answers and notes on the Review page after submitting.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button onClick={() => setConfirmOpen(false)}>Cancel</Button>
              <Button variant="primary" onClick={doSubmit}>Submit</Button>
            </div>
          </div>
        </div>
      )}

      <Footer />
    </div>
  );
}

/* ---------- UI components ---------- */
function TopBar({
  view,
  onNavigate,
  quizLocked,
  onSubmitClick,
}: {
  view: "setup" | "quiz" | "review" | "history";
  onNavigate: (v: "setup" | "quiz" | "review" | "history") => void;
  quizLocked?: boolean;
  onSubmitClick: () => void;
}) {
  const lock = quizLocked;
  const Nav = ({ label, to }: { label: string; to: typeof view }) => (
    <button
      disabled={lock && to !== "quiz"}
      onClick={() => onNavigate(to)}
      className={cx(
        "rounded-full px-3 py-1 text-sm transition",
        view === to ? "bg-neutral-100 text-neutral-900" : "text-neutral-300 hover:bg-neutral-900",
        lock && to !== "quiz" && "opacity-40 cursor-not-allowed hover:bg-transparent"
      )}
    >
      {label}
    </button>
  );
  return (
    <header className="sticky top-0 z-10 border-b border-neutral-900/80 bg-neutral-950/70 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 rounded-full bg-emerald-400" />
          <span className="text-sm font-medium tracking-wide text-neutral-300">MCQ Simulator</span>
        </div>
        <nav className="flex items-center gap-1">
          <Nav label="Setup" to="setup" />
          <Nav label="Quiz" to="quiz" />
          <Nav label="Review" to="review" />
          <Nav label="History" to="history" />
          {view === "quiz" && (
            <button
              onClick={onSubmitClick}
              className="ml-2 rounded-full border border-neutral-800 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-900"
              title="Submit (opens confirm)"
            >
              Submit
            </button>
          )}
        </nav>
      </div>
    </header>
  );
}

function Card({ className, children }: React.PropsWithChildren<{ className?: string }>) {
  return <div className={cx("rounded-2xl border border-neutral-900 bg-neutral-950", className)}>{children}</div>;
}
function Button({
  children,
  variant = "ghost",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "ghost" | "primary" }) {
  const base = "rounded-xl px-3 py-2 text-sm ring-1 ring-neutral-800 transition disabled:opacity-50";
  const styles = variant === "primary"
    ? "bg-neutral-100 text-neutral-900 hover:brightness-95 ring-neutral-200"
    : "bg-neutral-950 text-neutral-200 hover:bg-neutral-900";
  return <button className={cx(base, styles, className)} {...props}>{children}</button>;
}
function LabeledInput({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="block">
      <div className="text-sm text-neutral-400">{label}</div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full rounded-xl bg-neutral-900/60 px-3 py-2 outline-none ring-1 ring-neutral-800 focus:ring-2 focus:ring-neutral-600"
      />
    </label>
  );
}
function LabeledNumber({ label, value, onChange, min }: { label: string; value: number; onChange: (v: number) => void; min?: number }) {
  return (
    <label className="block">
      <div className="text-sm text-neutral-400">{label}</div>
      <input
        type="number"
        value={value}
        min={min}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full rounded-xl bg-neutral-900/60 px-3 py-2 outline-none ring-1 ring-neutral-800 focus:ring-2 focus:ring-neutral-600"
      />
    </label>
  );
}
function ChoicePill({ letter, selected, onClick }: { letter: Letter; selected?: boolean; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cx(
        "rounded-2xl px-4 py-3 text-center text-base font-medium ring-1 transition",
        selected ? "bg-neutral-100 text-neutral-900 ring-neutral-200" : "bg-neutral-950 text-neutral-100 ring-neutral-900 hover:bg-neutral-900"
      )}
    >
      {letter}
    </button>
  );
}
function HeaderBlock({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="px-1">
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      {subtitle && <p className="mt-1 text-sm text-neutral-400">{subtitle}</p>}
    </div>
  );
}
function Footer() {
  return (
    <footer className="border-t border-neutral-900/80 py-6 text-center text-xs text-neutral-500">
      Built for focused practice • Data saved locally in your browser
    </footer>
  );
}
function SubjectBadge({ subject }: { subject: Subject }) {
  const label = subject.toUpperCase();
  const cls =
    subject === "physics"
      ? "bg-sky-500/20 text-sky-300 ring-sky-700/40"
      : subject === "math2"
      ? "bg-violet-500/20 text-violet-300 ring-violet-700/40"
      : "bg-emerald-500/20 text-emerald-300 ring-emerald-700/40";
  return <span className={cx("rounded-md px-2 py-0.5 text-[11px] ring-1", cls)}>{label}</span>;
}

/* ------- Donut (mistake tags) ------- */
function MistakeChart({ tags }: { tags: MistakeTag[] }) {
  const counts: Record<string, number> = {};
  MISTAKE_OPTIONS.forEach((k) => (counts[k] = 0));
  tags.forEach((t) => { const k = t ?? "None"; counts[k] = (counts[k] ?? 0) + 1; });
  const entries = MISTAKE_OPTIONS.filter((k) => counts[k] > 0).map((k) => ({ key: k, value: counts[k] }));
  const total = entries.reduce((s, e) => s + e.value, 0) || 1;

  let acc = 0;
  const r = 36, C = 2 * Math.PI * r;
  const cx0 = 48, cy0 = 48, stroke = 16;

  return (
    <div className="flex items-center gap-4">
      <svg width="96" height="96" viewBox="0 0 96 96" className="shrink-0">
        <circle cx={cx0} cy={cy0} r={r} fill="none" stroke="#262626" strokeWidth={stroke} />
        {entries.map((e, i) => {
          const frac = e.value / total;
          const dash = frac * C;
          const gap = C - dash;
          const rot = (acc / total) * 360;
          acc += e.value;
          return (
            <circle
              key={e.key}
              cx={cx0}
              cy={cy0}
              r={r}
              fill="none"
              strokeWidth={stroke}
              strokeDasharray={`${dash} ${gap}`}
              transform={`rotate(${rot} ${cx0} ${cy0})`}
              stroke={i % 2 ? "#10b981" : "#f43f5e"}
            />
          );
        })}
        <circle cx={cx0} cy={cy0} r={r - stroke / 2} fill="#0a0a0a" />
      </svg>
      <div className="grid grid-cols-1 gap-1 text-xs">
        {entries.map((e, i) => (
          <div key={e.key} className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 rounded-sm" style={{ background: i % 2 ? "#10b981" : "#f43f5e" }} />
            <span className="text-neutral-300">{e.key}</span>
            <span className="text-neutral-500 tabular-nums">{e.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------- Scatter (time vs question) with progression line + unanswered + guessed ------- */
function TimeCorrectScatter({
  startNum,
  perQSec,
  correctFlags,
  guessedFlags,
  answers,
}: {
  startNum: number;
  perQSec: number[];
  correctFlags: (boolean | null)[];
  guessedFlags: boolean[];
  answers: Answer[];
}) {
  const W = 420, H = 180, PAD = 28;
  const N = perQSec.length;
  const maxX = startNum + N - 1;
  const maxY = Math.max(10, ...perQSec, 0);
  const xScale = (q: number) => PAD + ((q - startNum) / Math.max(1, maxX - startNum)) * (W - 2 * PAD);
  const yScale = (sec: number) => H - PAD - (sec / maxY) * (H - 2 * PAD);

  type P = { qn: number; sec: number; color: string; guessed: boolean; unanswered: boolean };
  const points: P[] = Array.from({ length: N }, (_, i) => {
    const qn = startNum + i;
    const sec = perQSec[i] ?? 0;
    const flag = correctFlags[i];
    const guessed = guessedFlags[i] ?? false;
    const unanswered = !answers[i]?.choice; // NEW
    const color = unanswered ? "#737373" : flag === true ? "#10b981" : flag === false ? "#f43f5e" : "#a3a3a3";
    return { qn, sec, color, guessed, unanswered };
  });

  // Create a simple progression polyline (x sorted natural order)
  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.qn)} ${yScale(p.sec)}`).join(" ");

  return (
    <div className="rounded-2xl border border-neutral-900 bg-neutral-950 p-3">
      <div className="mb-2 text-sm text-neutral-300">Time vs Question</div>
      <svg width={W} height={H}>
        {/* axes */}
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="#27272a" />
        <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} stroke="#27272a" />
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const y = yScale(t * maxY);
          return <line key={t} x1={PAD} y1={y} x2={W - PAD} y2={y} stroke="#111113" />;
        })}
        <text x={PAD} y={14} fill="#9ca3af" fontSize="10">sec</text>
        <text x={W - 50} y={H - 8} fill="#9ca3af" fontSize="10">question</text>

        {/* subtle progression line */}
        <path d={linePath} fill="none" stroke="#3f3f46" strokeWidth={1} />

        {/* points */}
        {points.map((p) => {
          const x = xScale(p.qn), y = yScale(p.sec);
          if (p.unanswered) {
            // unanswered: small square
            return <rect key={p.qn} x={x - 3} y={y - 3} width={6} height={6} fill={p.color} opacity={0.8} rx={1} ry={1} />;
          }
          return p.guessed ? (
            // guessed: hollow ring
            <g key={p.qn}>
              <circle cx={x} cy={y} r={5} fill="none" stroke={p.color} strokeWidth={2} />
              <circle cx={x} cy={y} r={2} fill={p.color} opacity={0.7} />
            </g>
          ) : (
            // not guessed: solid dot
            <circle key={p.qn} cx={x} cy={y} r={4} fill={p.color} opacity={p.color === "#a3a3a3" ? 0.6 : 0.95} />
          );
        })}
      </svg>

      {/* legend */}
      <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-neutral-400">
        <div className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full" style={{ background: "#10b981" }} /> correct</div>
        <div className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full" style={{ background: "#f43f5e" }} /> wrong</div>
        <div className="flex items-center gap-2"><span className="inline-block h-3 w-3 rounded-full border-2" style={{ borderColor: "#a3a3a3" }} /> guessed = hollow</div>
        <div className="flex items-center gap-2"><span className="inline-block h-2 w-2" style={{ background: "#737373" }} /> unanswered</div>
        <div className="flex items-center gap-2"><span className="inline-block h-2 w-4" style={{ background: "#3f3f46" }} /> time progression</div>
      </div>
    </div>
  );
}

/* ------- History progress panel (score% trend Math vs Physics) ------- */
function ProgressPanel() {
  const [sessions, setSessions] = useState<SessionMeta[]>(() => loadStore().sessions);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (!e.key || (e.key !== LS_KEY && e.key !== LS_BACKUP)) return;
      setSessions(loadStore().sessions);
    };
    window.addEventListener("storage", onStorage);
    setSessions(loadStore().sessions);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const mathSessions = sessions
    .filter(s => s.subject === "math1" || s.subject === "math2")
    .filter(s => s.score && s.score.total > 0)
    .sort((a,b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  const physicsSessions = sessions
    .filter(s => s.subject === "physics")
    .filter(s => s.score && s.score.total > 0)
    .sort((a,b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));

  return (
    <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2">
      <Card className="p-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm text-neutral-300">Progress — Math (M1+M2)</div>
          <TrendPill series={mathSessions.map(s => (100 * (s.score!.correct / s.score!.total)))} />
        </div>
        <Sparkline series={mathSessions.map(s => (100 * (s.score!.correct / s.score!.total)))} />
      </Card>
      <Card className="p-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm text-neutral-300">Progress — Physics</div>
          <TrendPill series={physicsSessions.map(s => (100 * (s.score!.correct / s.score!.total)))} />
        </div>
        <Sparkline series={physicsSessions.map(s => (100 * (s.score!.correct / s.score!.total)))} />
      </Card>
    </div>
  );
}
function HistoryMistakeSummary() {
  const [sessions, setSessions] = useState<SessionMeta[]>(() => loadStore().sessions);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (!e.key || (e.key !== LS_KEY && e.key !== LS_BACKUP)) return;
      setSessions(loadStore().sessions);
    };
    window.addEventListener("storage", onStorage);
    setSessions(loadStore().sessions);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Flatten all mistake tags across all sessions, excluding "None"
  const allTags = useMemo(() => {
    const acc: MistakeTag[] = [];
    for (const s of sessions) {
      const tags = s.mistakeTags ?? [];
      for (const t of tags) {
        if (t && t !== "None") acc.push(t as MistakeTag);
      }
    }
    return acc;
  }, [sessions]);

  return (
    <Card className="mb-6 p-4">
      <div className="mb-2 text-sm text-neutral-300">Mistake distribution — all sessions</div>
      {allTags.length === 0 ? (
        <div className="text-xs text-neutral-500">No tagged mistakes yet.</div>
      ) : (
        <MistakeChart tags={allTags} />
      )}
      <div className="mt-2 text-[11px] text-neutral-500">Excludes “None”.</div>
    </Card>
  );
}

function TrendPill({ series }: { series: number[] }) {
  if (!series.length) return <span className="rounded-full bg-neutral-900 px-2 py-0.5 text-xs text-neutral-400">no data</span>;
  const last = series[series.length - 1];
  const first = series[0];
  const up = last > first + 0.5;
  const down = last < first - 0.5;
  const label = up ? "improving" : down ? "declining" : "flat";
  const cls = up ? "bg-emerald-500/15 text-emerald-300 ring-emerald-700/30"
           : down ? "bg-rose-500/15 text-rose-300 ring-rose-700/30"
           : "bg-neutral-800 text-neutral-300 ring-neutral-700/30";
  return <span className={cx("rounded-full px-2 py-0.5 text-xs ring-1", cls)}>{label}</span>;
}
function Sparkline({ series }: { series: number[] }) {
  const W = 320, H = 80, PAD = 6;
  if (!series.length) return <div className="h-[80px] text-xs text-neutral-500 flex items-center">No scored sessions yet.</div>;
  const min = Math.min(...series, 0), max = Math.max(...series, 100);
  const x = (i: number) => PAD + (i / Math.max(1, series.length - 1)) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - ((v - min) / Math.max(1, max - min)) * (H - 2 * PAD);
  const path = series.map((v, i) => `${i ? "L" : "M"} ${x(i)} ${y(v)}`).join(" ");
  return (
    <svg width={W} height={H}>
      <rect x={0} y={0} width={W} height={H} rx={10} fill="#0a0a0a" />
      <path d={path} fill="none" stroke="#a3a3a3" strokeWidth={1.5} />
      {series.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r={2} fill="#a3a3a3" />)}
      <text x={W - 48} y={H - 10} fill="#9ca3af" fontSize="10">% score</text>
    </svg>
  );
}

/* ------- History (rename + subject badge + inline notes) ------- */
function HistoryView({
  onOpen,
  onDelete,
}: {
  onOpen: (s: SessionMeta) => void;
  onDelete: (id: string) => void;
}) {
  const [sessions, setSessions] = useState<SessionMeta[]>(() => loadStore().sessions);
  const [openNotesId, setOpenNotesId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [nameEdits, setNameEdits] = useState<Record<string, string>>({});

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (!e.key || (e.key !== LS_KEY && e.key !== LS_BACKUP)) return;
      setSessions(loadStore().sessions);
    };
    window.addEventListener("storage", onStorage);
    setSessions(loadStore().sessions);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  /* Rename controls (requested “function to rename sessions in history”) */
  function startRename(s: SessionMeta) { setNameEdits((m) => ({ ...m, [s.id]: s.name })); }
  function cancelRename(s: SessionMeta) {
    setNameEdits((m) => { const { [s.id]: _, ...rest } = m; return rest; });
  }
  function commitRename(s: SessionMeta) {
    const newName = (nameEdits[s.id] ?? s.name).trim();
    if (!newName) return;
    upsertSession({ ...s, name: newName });
    setSessions(loadStore().sessions);
    cancelRename(s);
  }

  function toggleNotes(s: SessionMeta) {
    const next = openNotesId === s.id ? null : s.id;
    setOpenNotesId(next);
    setDrafts((d) => ({ ...d, [s.id]: d[s.id] ?? (s.notes ?? "") }));
  }
  function saveNotes(s: SessionMeta) {
    const text = drafts[s.id] ?? "";
    upsertSession({ ...s, notes: text });
    setSessions(loadStore().sessions);
  }

  if (sessions.length === 0) {
    return (
      <Card className="p-8 text-center text-neutral-400">
        No sessions yet. Create one from <span className="text-neutral-200">Setup</span>.
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <HeaderBlock title="History" subtitle="Open to mark, rename titles inline, or edit notes directly." />
      {sessions.map((s) => {
        const renaming = Object.prototype.hasOwnProperty.call(nameEdits, s.id);
        return (
          <Card key={s.id} className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                {!renaming ? (
                  <>
                    <div className="flex items-center gap-2">
                      <div className="text-sm font-medium truncate">{s.name}</div>
                      <SubjectBadge subject={s.subject} />
                    </div>
                    <div className="text-xs text-neutral-500">
                      {new Date(s.startedAt).toLocaleString()} • Q{s.startNum}–{s.endNum} • {s.minutes} min
                    </div>
                  </>
                ) : (
                  <div className="flex items-end gap-2">
                    <input
                      className="w-64 rounded-lg bg-neutral-900/60 px-3 py-1 text-sm outline-none ring-1 ring-neutral-800 focus:ring-2 focus:ring-neutral-600"
                      value={nameEdits[s.id]}
                      onChange={(e) => setNameEdits((m) => ({ ...m, [s.id]: e.target.value }))}
                    />
                    <Button onClick={() => commitRename(s)} variant="primary">Save</Button>
                    <Button onClick={() => cancelRename(s)}>Cancel</Button>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <div className="rounded-full bg-neutral-900 px-3 py-1 text-xs">
                  {s.score ? `Score: ${s.score.correct}/${s.score.total}` : "No score"}
                </div>
                {!renaming ? <Button onClick={() => startRename(s)}><PenLine className="h-4 w-4" />
</Button> : null}
                <Button onClick={() => toggleNotes(s)}><Notebook className="h-4 w-4" />
</Button>
                <Button onClick={() => onOpen(s)}><ExternalLink className="h-4 w-4" />
</Button>
                <Button onClick={() => onDelete(s.id)}><Trash2 className="h-4 w-4" />
</Button>
                <select
                  className="rounded-md bg-neutral-950 px-2 py-1 text-xs ring-1 ring-neutral-800 hover:bg-neutral-900"
                  value={s.subject ?? "math1"}
                  onChange={(e) => {
                    const subj = e.target.value as Subject;
                    upsertSession({ ...s, subject: subj });
                    // refresh the list after write
                    const st = loadStore();
                    setSessions(st.sessions);
                  }}
                  title="Change subject"
                >
  <option value="math1">MATH1</option>
  <option value="math2">MATH2</option>
  <option value="physics">PHYSICS</option>
</select>
              </div>
            </div>

            {/* Inline notes editor */}
            {openNotesId === s.id && (
              <div className="mt-3 rounded-xl border border-neutral-900 bg-neutral-950 p-3">
                <div className="mb-2 text-xs text-neutral-400">Session Notes / what to improve</div>
                <textarea
                  rows={4}
                  value={drafts[s.id] ?? ""}
                  onChange={(e) => setDrafts((d) => ({ ...d, [s.id]: e.target.value }))}
                  className="w-full rounded-xl bg-neutral-900/60 px-3 py-2 outline-none ring-1 ring-neutral-800 focus:ring-2 focus:ring-neutral-600"
                  placeholder="Set actionable goals. E.g., 'slow algebra; more projectile setups; memorize capacitor formulas'."
                />
                <div className="mt-2 flex justify-end gap-2">
                  <Button onClick={() => setOpenNotesId(null)}>Close</Button>
                  <Button variant="primary" onClick={() => saveNotes(s)}>Save Notes</Button>
                </div>
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}
