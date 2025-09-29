import React, { useEffect, useMemo, useRef, useState } from "react";

/* MCQ Simulator — TSX, Tailwind (dark, minimalist)
   Fixes & upgrades:
   - Robust storage with transactional writes, backup, validation, and recovery
   - History stays in sync (storage event)
   - Rename sessions inline in History
   - Quiz UI: NEXT is primary highlight; SUBMIT moved to top bar with confirm modal
   - Session Notes on Review + inline notes edit in History (kept)
   - Guess flags, ✓/✗ marking, mistake tags, donut + scatter charts (kept)
*/

const LETTERS = ["A", "B", "C", "D", "E", "F", "G"] as const;
type Letter = typeof LETTERS[number];

const MISTAKE_OPTIONS = [
  "None",
  "Calc / algebra mistakes",
  "Failed to spot setup",
  "Understanding",
  "Formula recall",
  "Diagrams",
  "Poor Time management",
  "Other",
] as const;
type MistakeTag = typeof MISTAKE_OPTIONS[number];

const LS_KEY = "mcqSessionsV1";
const LS_BACKUP = "mcqSessionsV1__backup";

/* ---------- Types ---------- */
type Answer = { choice: Letter | null; other: string };

type SessionMeta = {
  id: string;
  name: string;
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

/* ---------- Storage helpers (robust) ---------- */
const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(" ");

function isSession(s: any): s is SessionMeta {
  return s && typeof s.id === "string" && Array.isArray(s.answers) && Array.isArray(s.perQuestionSec);
}
function sanitize(store: any): Store | null {
  if (!store || typeof store !== "object") return null;
  if (!Array.isArray(store.sessions)) return null;
  const ok = store.sessions.every(isSession);
  return ok ? (store as Store) : null;
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
    // try backup
    const b = readRaw(LS_BACKUP);
    if (b) {
      const parsedB = JSON.parse(b);
      const cleanB = sanitize(parsedB);
      if (cleanB) {
        writeRaw(LS_KEY, JSON.stringify(cleanB)); // restore
        return cleanB;
      }
    }
  } catch {
    // fallthrough to backup
    const b = readRaw(LS_BACKUP);
    if (b) {
      try {
        const parsedB = JSON.parse(b);
        const cleanB = sanitize(parsedB);
        if (cleanB) {
          writeRaw(LS_KEY, JSON.stringify(cleanB));
          return cleanB;
        }
      } catch {}
    }
  }
  const empty: Store = { sessions: [] };
  writeRaw(LS_KEY, JSON.stringify(empty));
  writeRaw(LS_BACKUP, JSON.stringify(empty));
  return empty;
}

/** Transactional update:
 *  - re-read fresh store
 *  - apply fn
 *  - validate
 *  - backup old value
 *  - write new value
 */
function mutateStore(fn: (store: Store) => Store): Store {
  const current = loadStore(); // validated
  const updated = fn(structuredClone(current));
  const clean = sanitize(updated);
  if (!clean) return current; // refuse to write invalid shape
  const old = readRaw(LS_KEY);
  if (old) writeRaw(LS_BACKUP, old); // backup
  writeRaw(LS_KEY, JSON.stringify(clean));
  return clean;
}

function upsertSession(s: SessionMeta) {
  mutateStore((st) => {
    const i = st.sessions.findIndex((x) => x.id === s.id);
    if (i >= 0) st.sessions[i] = s;
    else st.sessions.unshift(s);
    return st;
  });
}
function removeSession(id: string) {
  mutateStore((st) => {
    st.sessions = st.sessions.filter((s) => s.id !== id);
    return st;
  });
}

/* ---------- Utils ---------- */
const fmtTime = (sec: number) => {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};
const now = () => Date.now();

/* ---------- App ---------- */
export default function App() {
  type View = "setup" | "quiz" | "review" | "history";
  const [view, setView] = useState<View>("setup");

  // Setup state
  const [sessionName, setSessionName] = useState("");
  const [startNum, setStartNum] = useState<number>(1);
  const [endNum, setEndNum] = useState<number>(20);
  const [minutes, setMinutes] = useState<number>(30);

  // Notes
  const [sessionNotes, setSessionNotes] = useState<string>("");

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

  // Submit modal (to prevent accidental submit)
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

    // Seed session immediately (robust write)
    upsertSession({
      id,
      name: sessionName.trim() || `Session ${new Date(t0).toLocaleString()}`,
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

  /* Safe submit via modal */
  function doSubmit() {
    if (!sessionId || startedAt == null) return;
    const t1 = now();
    const meta: SessionMeta = {
      id: sessionId,
      name: sessionName.trim() || `Session ${new Date(startedAt).toLocaleString()}`,
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

  function handleSubmit() {
    setConfirmOpen(true);
  }

  /* Open from History */
  function openForMarking(s: SessionMeta) {
    setSessionId(s.id);
    setSessionName(s.name);
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

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 antialiased selection:bg-neutral-800">
      <TopBar
        view={view}
        onNavigate={(v) => setView(v)}
        quizLocked={view === "quiz"}
        onSubmitClick={handleSubmit} // moved submit here
        onNew={() => setView("setup")}
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
                  {/* NEXT is highlighted */}
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
                <TimeCorrectScatter startNum={startNum} perQSec={perQSec} correctFlags={correctFlags} guessedFlags={guessedFlags} />
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

        {/* History (with rename + inline notes) */}
        {view === "history" && (
          <HistoryView
            onOpen={(s) => openForMarking(s)}
            onDelete={(id) => {
              removeSession(id);
              // refresh list
              window.dispatchEvent(new StorageEvent("storage", { key: LS_KEY }));
            }}
          />
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
  onNew,
}: {
  view: "setup" | "quiz" | "review" | "history";
  onNavigate: (v: "setup" | "quiz" | "review" | "history") => void;
  quizLocked?: boolean;
  onSubmitClick: () => void;
  onNew: () => void;
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
          {/* SUBMIT moved up here, smaller + confirm modal */}
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

/* ------- Scatter (time vs question, color by correctness, hollow = guessed) ------- */
function TimeCorrectScatter({
  startNum,
  perQSec,
  correctFlags,
  guessedFlags,
}: {
  startNum: number;
  perQSec: number[];
  correctFlags: (boolean | null)[];
  guessedFlags: boolean[];
}) {
  const W = 420, H = 180, PAD = 28;
  const N = perQSec.length;
  const maxX = startNum + N - 1;
  const maxY = Math.max(10, ...perQSec, 0);
  const xScale = (q: number) => PAD + ((q - startNum) / Math.max(1, maxX - startNum)) * (W - 2 * PAD);
  const yScale = (sec: number) => H - PAD - (sec / maxY) * (H - 2 * PAD);

  const points = Array.from({ length: N }, (_, i) => {
    const qn = startNum + i;
    const sec = perQSec[i] ?? 0;
    const flag = correctFlags[i];
    const guessed = guessedFlags[i] ?? false;
    const color = flag === true ? "#10b981" : flag === false ? "#f43f5e" : "#a3a3a3";
    return { qn, sec, color, guessed };
  });

  return (
    <div className="rounded-2xl border border-neutral-900 bg-neutral-950 p-3">
      <div className="mb-2 text-sm text-neutral-300">Time vs Question</div>
      <svg width={W} height={H}>
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="#27272a" />
        <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} stroke="#27272a" />
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const y = yScale(t * maxY);
          return <line key={t} x1={PAD} y1={y} x2={W - PAD} y2={y} stroke="#111113" />;
        })}
        <text x={PAD} y={14} fill="#9ca3af" fontSize="10">sec</text>
        <text x={W - 50} y={H - 8} fill="#9ca3af" fontSize="10">question</text>

        {points.map((p) =>
          p.guessed ? (
            <g key={p.qn}>
              <circle cx={xScale(p.qn)} cy={yScale(p.sec)} r={5} fill="none" stroke={p.color} strokeWidth={2} />
              <circle cx={xScale(p.qn)} cy={yScale(p.sec)} r={2} fill={p.color} opacity={0.7} />
            </g>
          ) : (
            <circle key={p.qn} cx={xScale(p.qn)} cy={yScale(p.sec)} r={4} fill={p.color} opacity={p.color === "#a3a3a3" ? 0.6 : 0.95} />
          )
        )}
      </svg>

      <div className="mt-2 flex items-center gap-4 text-xs text-neutral-400">
        <div className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full" style={{ background: "#10b981" }} /> correct</div>
        <div className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full" style={{ background: "#f43f5e" }} /> wrong</div>
        <div className="flex items-center gap-2"><span className="inline-block h-3 w-3 rounded-full border-2" style={{ borderColor: "#a3a3a3" }} /> guessed = hollow</div>
      </div>
    </div>
  );
}

/* ------- History (rename + inline notes, synced with storage) ------- */
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

  // Keep list in sync with any storage changes
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (!e.key || (e.key !== LS_KEY && e.key !== LS_BACKUP)) return;
      const st = loadStore();
      setSessions(st.sessions);
    };
    window.addEventListener("storage", onStorage);
    // also initial pull to be safe
    const st = loadStore();
    setSessions(st.sessions);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  function toggleNotes(s: SessionMeta) {
    const nextOpen = openNotesId === s.id ? null : s.id;
    setOpenNotesId(nextOpen);
    setDrafts((d) => ({ ...d, [s.id]: d[s.id] ?? (s.notes ?? "") }));
  }
  function saveNotes(s: SessionMeta) {
    const text = drafts[s.id] ?? "";
    const updated = { ...s, notes: text };
    upsertSession(updated);
    setSessions(loadStore().sessions);
  }

  function startRename(s: SessionMeta) {
    setNameEdits((m) => ({ ...m, [s.id]: s.name }));
  }
  function cancelRename(s: SessionMeta) {
    setNameEdits((m) => {
      const { [s.id]: _, ...rest } = m;
      return rest;
    });
  }
  function commitRename(s: SessionMeta) {
    const newName = (nameEdits[s.id] ?? s.name).trim();
    if (!newName) return;
    upsertSession({ ...s, name: newName });
    const st = loadStore();
    setSessions(st.sessions);
    cancelRename(s);
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
                    <div className="text-sm font-medium truncate">{s.name}</div>
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
                {s.notes && <span className="rounded-full bg-neutral-900 px-2 py-0.5 text-[11px] text-neutral-300">📝</span>}
                {!renaming ? (
                  <Button onClick={() => startRename(s)}>Rename</Button>
                ) : null}
                <Button onClick={() => toggleNotes(s)}>Notes</Button>
                <Button onClick={() => onOpen(s)}>Open</Button>
                <Button onClick={() => onDelete(s.id)}>Delete</Button>
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
