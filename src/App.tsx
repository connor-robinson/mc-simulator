import React, { useEffect, useMemo, useRef, useState, } from "react";

import { PenLine, Notebook, ExternalLink, Trash2, Pin, PinOff } from "lucide-react";

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
const LS_PINNED_NOTE = "mcqPinnedNoteV1";

/* ---------- Types ---------- */
type Answer = {
  choice: Letter | null;
  other: string;
  correctChoice: Letter | null;
  explanation: string;
  pinned: boolean;
};

function normalizeAnswer(raw?: Partial<Answer>): Answer {
  return {
    choice: raw?.choice ?? null,
    other: raw?.other ?? "",
    correctChoice: raw?.correctChoice ?? null,
    explanation: raw?.explanation ?? "",
    pinned: raw?.pinned ?? false,
  };
}

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
  const answers = Array.isArray(s.answers) ? s.answers.map((ans: any) => normalizeAnswer(ans)) : [];
  return { subject, version, ...s, answers };
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
  const [pinnedNote, setPinnedNote] = useState<string>("");
  const pinnedHydratedRef = useRef(false);


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

  useEffect(() => {
    const stored = readRaw(LS_PINNED_NOTE);
    if (typeof stored === "string") {
      setPinnedNote(stored);
    }
    pinnedHydratedRef.current = true;
  }, []);

  useEffect(() => {
    if (!pinnedHydratedRef.current) return;
    writeRaw(LS_PINNED_NOTE, pinnedNote);
  }, [pinnedNote]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== LS_PINNED_NOTE) return;
      setPinnedNote(e.newValue ?? "");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

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
    const initAnswers: Answer[] = Array.from({ length: N }, () => normalizeAnswer());
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
    setAnswers(s.answers.map((ans) => normalizeAnswer(ans)));
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
    setAnswers((prev) => {
      const a = prev.slice();
      a[idx] = { ...a[idx], other: text };
      return a;
    });
  }
  function setCorrectChoice(idx: number, letter: Letter | null) {
    setAnswers((prev) => {
      const a = prev.slice();
      const current = a[idx];
      if (!current) return prev;
      const next = letter && current.correctChoice === letter ? null : letter;
      a[idx] = { ...current, correctChoice: next ?? null };
      return a;
    });
  }
  function setExplanation(idx: number, text: string) {
    setAnswers((prev) => {
      const a = prev.slice();
      const current = a[idx];
      if (!current) return prev;
      const shouldUnpin = !text.trim();
      a[idx] = { ...current, explanation: text, pinned: shouldUnpin ? false : current.pinned };
      return a;
    });
  }
  function togglePinnedInsight(idx: number) {
    setAnswers((prev) => {
      const a = prev.slice();
      const current = a[idx];
      if (!current) return prev;
      const hasText = current.explanation.trim().length > 0;
      if (!hasText && !current.pinned) return prev;
      a[idx] = { ...current, pinned: hasText ? !current.pinned : false };
      return a;
    });
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

  const pinnedInsights = useMemo(() => {
    return answers
      .map((ans, idx) => {
        const text = ans?.explanation?.trim();
        const question = questionNumbers[idx];
        if (!ans?.pinned || !text || question == null) return null;
        return { question, text };
      })
      .filter((item): item is { question: number; text: string } => item !== null);
  }, [answers, questionNumbers]);

  /* Setup: surfaced notes for the active subject */
  const subjectNotes = useMemo(() => {
    const { sessions } = loadStore();
    return sessions
      .filter((s) => {
        if (subject === "physics") return s.subject === "physics";
        return s.subject === subject;
      })
      .filter((s) => (s.notes ?? "").trim().length > 0)
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  }, [subject, view]); // re-eval when you open Setup or change subject
  const subjectNotesLabel = useMemo(() => {
    switch (subject) {
      case "math1":
        return "Math 1";
      case "math2":
        return "Math 2";
      case "physics":
        return "Physics";
      default:
        return "Notes";
    }
  }, [subject]);


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

            {/* Notes and pinned reminders */}
            <Card className="mt-6 p-4 space-y-4">
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-sm text-neutral-400">Pinned note</div>
                  <div className="text-xs text-neutral-500">Shared for Math (M1/M2) and Physics.</div>
                </div>
                <textarea
                  value={pinnedNote}
                  onChange={(e) => setPinnedNote(e.target.value)}
                  className="w-full rounded-xl bg-neutral-900/60 px-3 py-2 text-sm outline-none ring-1 ring-neutral-800 focus:ring-2 focus:ring-neutral-600"
                  placeholder="Use this space for quick reminders to keep in view during setup."
                  rows={3}
                />
              </div>
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-sm text-neutral-400">Previous notes for {subjectNotesLabel}</div>
                  <div className="text-xs text-neutral-500">{subjectNotes.length} saved</div>
                </div>
                {subjectNotes.length === 0 ? (
                  <div className="text-xs text-neutral-500">No previous notes for this subject yet.</div>
                ) : (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {subjectNotes.map((s) => {
                      const pinned = (s.answers ?? []).map((ans, idx) => {
                        const text = (ans.explanation ?? "").trim();
                        if (!ans.pinned || !text) return null;
                        return { question: (s.startNum ?? 0) + idx, text };
                      }).filter((item): item is { question: number; text: string } => item !== null);
                      return (
                        <div key={s.id} className="rounded-xl bg-neutral-900/50 p-3 ring-1 ring-neutral-900">
                          <div className="mb-1 flex items-center justify-between">
                            <div className="text-xs text-neutral-400">{new Date(s.startedAt).toLocaleString()}</div>
                            <SubjectBadge subject={s.subject} />
                          </div>
                          <div className="text-xs text-neutral-300 whitespace-pre-wrap">{s.notes}</div>
                          {pinned.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-2">
                              {pinned.map((pin, idx2) => (
                                <span
                                  key={`${pin.question}-${idx2}`}
                                  className="rounded-full bg-neutral-950 px-2 py-1 text-[11px] text-neutral-300 ring-1 ring-neutral-800"
                                >
                                  Q{pin.question}: {pin.text}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
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
            <HeaderBlock title="Review & Mark" subtitle="Toggle notes (?), mark OK/X, flag guesses, tag mistakes. Score updates automatically." />
            <Card className="p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm text-neutral-400">Auto score</div>
                <div className="rounded-full bg-neutral-900 px-3 py-1 text-xs">
                  {correctCount}/{totalQuestions}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
                {questionNumbers.map((q, i) => {
                  const answer = answers[i];
                  const explanation = answer?.explanation ?? "";
                  const canTogglePin = explanation.trim().length > 0 || !!answer?.pinned;
                  return (
                    <div key={q} className="rounded-xl bg-neutral-900/50 p-3">
                      <div className="flex items-center justify-between">
                        <div className="text-sm">
                          <span className="text-neutral-400">{q}.</span>{" "}
                          <span className="font-medium">{answer?.choice ?? "-"}</span>
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
                              className={cx(
                                "px-2 py-1 text-xs transition",
                                correctFlags[i] === false && answer?.correctChoice === L
                                  ? "bg-emerald-500/80 text-neutral-900 ring-1 ring-emerald-400"
                                  : answer?.choice === L
                                  ? "bg-neutral-100 text-neutral-900"
                                  : "hover:bg-neutral-800"
                              )}
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
                            onClick={() => {
                              setCorrectFlags((prev) => { const a = prev.slice(); a[i] = true; return a; });
                              setAnswers((prev) => {
                                const a = prev.slice();
                                const current = a[i];
                                if (!current) return prev;
                                a[i] = { ...current, correctChoice: null, explanation: "", pinned: false };
                                return a;
                              });
                            }}
                          >✓</button>
                          <button
                            className={cx(
                              "px-2 py-1 text-xs rounded-md ring-1",
                              correctFlags[i] === false ? "bg-rose-500/90 text-neutral-900 ring-rose-400" : "bg-neutral-950 text-neutral-200 ring-neutral-800 hover:bg-neutral-900"
                            )}
                            title="Mark wrong"
                            onClick={() => setCorrectFlags((prev) => { const a = prev.slice(); a[i] = false; return a; })}
                          >X</button>
                          <button
                            className={cx(
                              "px-2 py-1 text-xs rounded-md ring-1",
                              guessedFlags[i] ? "bg-amber-400/90 text-neutral-900 ring-amber-300" : "bg-neutral-950 text-neutral-200 ring-neutral-800 hover:bg-neutral-900"
                            )}
                            title="Toggle guess"
                            onClick={() => toggleGuess(i)}
                          >?</button>
                          {answer?.other && (
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

                      {correctFlags[i] === false && (
                        <div className="mt-3 space-y-2 rounded-lg border border-neutral-900 bg-neutral-950/60 p-3">
                          <div>
                            <div className="text-[11px] uppercase tracking-wide text-neutral-600">Correct answer</div>
                            <div className="mt-2 flex flex-wrap gap-1">
                              {LETTERS.map((L) => (
                                <button
                                  key={`correct-${q}-${L}`}
                                  className={cx(
                                    "rounded-md px-2 py-1 text-xs ring-1 transition",
                                    answer?.correctChoice === L
                                      ? "bg-emerald-500/90 text-neutral-900 ring-emerald-400"
                                      : "bg-neutral-950 text-neutral-200 ring-neutral-800 hover:bg-neutral-900"
                                  )}
                                  onClick={() => setCorrectChoice(i, L)}
                                >
                                  {L}
                                </button>
                              ))}
                            </div>
                          </div>
                          <div>
                            <div className="mb-1 flex items-center justify-between text-xs text-neutral-500">
                              <span>Why was it wrong?</span>
                              <button
                                onClick={() => togglePinnedInsight(i)}
                                disabled={!canTogglePin}
                                className={cx(
                                  "rounded-md p-1 ring-1 transition",
                                  answer?.pinned
                                    ? "bg-emerald-500/20 text-emerald-300 ring-emerald-400/40"
                                    : "bg-neutral-950 text-neutral-400 ring-neutral-800 hover:bg-neutral-900 disabled:opacity-40"
                                )}
                                title={answer?.pinned ? "Unpin from setup notes" : "Pin to setup notes"}
                              >
                                {answer?.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                              </button>
                            </div>
                            <textarea
                              rows={3}
                              value={explanation}
                              onChange={(e) => setExplanation(i, e.target.value)}
                              className="w-full rounded-lg bg-neutral-900/60 px-3 py-2 text-xs outline-none ring-1 ring-neutral-800 focus:ring-2 focus:ring-neutral-600"
                              placeholder="e.g., Misread the axle direction; forgot to convert units."
                            />
                            <div className="mt-1 text-[11px] text-neutral-600">Pinned explanations surface in Setup notes.</div>
                          </div>
                        </div>
                      )}

                      {answer?.other && (
                        <div className="hidden mt-2 rounded-lg bg-neutral-950/70 p-2 text-xs text-neutral-300 ring-1 ring-neutral-900">{answer?.other}</div>
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
                  );
                })}
              </div>

              {pinnedInsights.length > 0 && (
                <Card className="p-4 mt-6">
                  <div className="text-sm text-neutral-400">Pinned insights</div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {pinnedInsights.map((item, idx) => (
                      <span
                        key={`${item.question}-${idx}`}
                        className="rounded-full bg-neutral-900 px-2 py-1 text-xs text-neutral-300 ring-1 ring-neutral-800"
                      >
                        Q{item.question}: {item.text}
                      </span>
                    ))}
                  </div>
                </Card>
              )}

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
            <HistoryAnalysisRow />
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

/* ------- History analysis row (subject trends + mistakes) ------- */
function HistoryAnalysisRow() {
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

  const subjectMeta: Array<{ subject: Subject; label: string; blurb: string }> = [
    { subject: "math1", label: "Math 1", blurb: "Mechanics" },
    { subject: "math2", label: "Math 2", blurb: "Statistics" },
    { subject: "physics", label: "Physics", blurb: "Concepts" },
  ];

  const cards = subjectMeta.map(({ subject, label, blurb }) => {
    const subjectSessions = sessions
      .filter((s) => s.subject === subject)
      .filter((s) => s.score && s.score.total > 0)
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));

    const scoreSeries = subjectSessions.map((s) => Math.round((100 * s.score!.correct) / s.score!.total));
    const labels = subjectSessions.map((s, idx) => (s.startedAt ? new Date(s.startedAt).toLocaleDateString() : `Session ${idx + 1}`));
    const avgScore = scoreSeries.length ? Math.round(scoreSeries.reduce((sum, v) => sum + v, 0) / scoreSeries.length) : null;
    const lastSession = subjectSessions[subjectSessions.length - 1];
    const lastLabel = lastSession?.startedAt ? new Date(lastSession.startedAt).toLocaleDateString() : null;

    const mistakeCounts: Record<string, number> = {};
    subjectSessions.forEach((s) => {
      (s.mistakeTags ?? []).forEach((tag) => {
        if (!tag || tag === "None") return;
        mistakeCounts[tag] = (mistakeCounts[tag] ?? 0) + 1;
      });
    });
    const totalMistakes = Object.values(mistakeCounts).reduce((sum, v) => sum + v, 0);
    const topMistakes = Object.entries(mistakeCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([key, value]) => ({ key, value, percent: totalMistakes ? Math.round((value / totalMistakes) * 100) : 0 }));

    return { subject, label, blurb, scoreSeries, labels, avgScore, lastLabel, topMistakes };
  });

  return (
    <div className="mb-6">
      <div className="mb-3">
        <div className="text-sm font-medium text-neutral-200">Subject overview</div>
        <div className="text-xs text-neutral-500">Score trends and recent mistake patterns</div>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {cards.map((card) => (
          <Card key={card.subject} className="p-4 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <SubjectBadge subject={card.subject} />
                  <span className="text-sm font-semibold text-neutral-200">{card.label}</span>
                </div>
                <div className="text-xs text-neutral-500">
                  {card.scoreSeries.length ? (
                    <>
                      <span>{card.avgScore}% avg</span>
                      <span className="mx-1 text-neutral-700">•</span>
                      <span>{card.lastLabel ?? "n/a"}</span>
                    </>
                  ) : (
                    <span>No scored sessions yet.</span>
                  )}
                </div>
                <div className="text-[11px] uppercase tracking-wide text-neutral-600">{card.blurb}</div>
              </div>
              <TrendPill series={card.scoreSeries} />
            </div>
            <TrendChart series={card.scoreSeries} labels={card.labels} />
            <div className="border-t border-neutral-900 pt-3">
              <div className="text-[11px] uppercase tracking-wide text-neutral-600">Top mistakes</div>
              {card.topMistakes.length ? (
                <div className="mt-2 space-y-1 text-xs text-neutral-300">
                  {card.topMistakes.map((m) => (
                    <div key={m.key} className="flex items-center justify-between gap-2">
                      <span className="truncate">{m.key}</span>
                      <span className="text-neutral-500">{m.percent}%</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-2 text-xs text-neutral-600">No mistakes tagged yet.</div>
              )}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function TrendChart({ series, labels }: { series: number[]; labels: string[] }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  if (!series.length) {
    return <div className="h-[220px] rounded-xl border border-neutral-900 bg-neutral-950/50 text-xs text-neutral-500 flex items-center justify-center">No scored sessions yet.</div>;
  }

  const width = 720;
  const height = 220;
  const margin = { top: 20, right: 24, bottom: 32, left: 44 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const min = 0;
  const max = 100;

  const points = series.map((value, index) => {
    const x = margin.left + (series.length > 1 ? (index / Math.max(1, series.length - 1)) * innerWidth : innerWidth / 2);
    const clamped = Math.max(min, Math.min(max, value));
    const ratio = (clamped - min) / Math.max(1, max - min);
    const y = margin.top + (1 - ratio) * innerHeight;
    return {
      x,
      y,
      value: Math.round(value * 10) / 10,
      label: labels[index] ?? `Session ${index + 1}`,
      index,
    };
  });

  const path = points.map((p, idx) => `${idx === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  const yTicks = [0, 25, 50, 75, 100];
  const xTickIndexes = series.length <= 1
    ? [0]
    : series.length <= 4
      ? Array.from({ length: series.length }, (_, idx) => idx)
      : Array.from(new Set([0, Math.floor((series.length - 1) / 2), series.length - 1]));

  const hoveredPoint = hoverIndex != null ? points[hoverIndex] : null;
  const tooltipX = hoveredPoint ? Math.min(hoveredPoint.x + 12, width - 150) : 0;
  const tooltipY = hoveredPoint ? Math.max(hoveredPoint.y - 12, 40) : 0;

  return (
    <svg className="w-full" viewBox={`0 0 ${width} ${height}`} role="img">
      <rect x={0} y={0} width={width} height={height} rx={16} fill="#0a0a0a" />
      <line x1={margin.left} y1={height - margin.bottom} x2={width - margin.right} y2={height - margin.bottom} stroke="#27272a" strokeWidth={1} />
      <line x1={margin.left} y1={margin.top} x2={margin.left} y2={height - margin.bottom} stroke="#27272a" strokeWidth={1} />
      {yTicks.map((tick) => {
        const ratio = (tick - min) / Math.max(1, max - min);
        const y = margin.top + (1 - ratio) * innerHeight;
        return (
          <g key={`y-${tick}`}>
            <line x1={margin.left} y1={y} x2={width - margin.right} y2={y} stroke="#1f1f23" strokeWidth={0.5} />
            <text x={margin.left - 8} y={y + 4} fill="#6b7280" fontSize={10} textAnchor="end">
              {tick}%
            </text>
          </g>
        );
      })}
      {xTickIndexes.map((idx) => {
        const point = points[idx];
        return (
          <text key={`x-${idx}`} x={point.x} y={height - margin.bottom + 20} fill="#6b7280" fontSize={10} textAnchor="middle">
            {labels[idx] ?? `#${idx + 1}`}
          </text>
        );
      })}
      <path d={path} fill="none" stroke="#38bdf8" strokeWidth={2} />
      {points.map((p, idx) => (
        <circle
          key={`pt-${idx}`}
          cx={p.x}
          cy={p.y}
          r={hoverIndex === idx ? 5 : 4}
          fill={hoverIndex === idx ? "#38bdf8" : "#f8fafc"}
          stroke="#0f172a"
          strokeWidth={1}
          onMouseEnter={() => setHoverIndex(idx)}
          onMouseLeave={() => setHoverIndex(null)}
        />
      ))}
      {hoveredPoint && (
        <g transform={`translate(${tooltipX} ${tooltipY})`}>
          <rect x={0} y={-28} width={140} height={32} rx={8} fill="#111827" stroke="#1f2937" strokeWidth={1} />
          <text x={8} y={-12} fill="#e5e7eb" fontSize={11}>
            Score: {hoveredPoint.value}%
          </text>
          <text x={8} y={2} fill="#9ca3af" fontSize={10}>
            {hoveredPoint.label}
          </text>
        </g>
      )}
    </svg>
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














