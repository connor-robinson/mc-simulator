import React, { useEffect, useMemo, useRef, useState } from "react";

// Minimalist MCQ Simulator — single-file React component
// Styling: TailwindCSS (neutral/dark minimalist), no external state libs
// Storage: localStorage (sessions, answers, timings)
// Letters: A–G, inclusive question range
// Phases: setup → quiz → review; plus history & detail views

const LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;
type Letter = typeof LETTERS[number];

// ---------- Storage helpers ----------
const LS_KEY = "mcqSessionsV1";

type Answer = { choice: Letter | null; other: string };

type SessionMeta = {
  id: string;
  name: string;
  startNum: number;
  endNum: number;
  startedAt: number; // epoch ms
  endedAt?: number; // epoch ms (when submitted/timeout)
  minutes: number; // planned duration
  perQuestionSec: number[]; // length N
  answers: Answer[]; // length N
  score?: { correct: number; total: number };
  notes?: string;
  version: 1;
};

type Store = {
  sessions: SessionMeta[];
};

function loadStore(): Store {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { sessions: [] };
    const parsed = JSON.parse(raw) as Store;
    if (!Array.isArray(parsed.sessions)) return { sessions: [] };
    return parsed;
  } catch {
    return { sessions: [] };
  }
}

function saveStore(store: Store) {
  localStorage.setItem(LS_KEY, JSON.stringify(store));
}

function upsertSession(session: SessionMeta) {
  const store = loadStore();
  const idx = store.sessions.findIndex((s) => s.id === session.id);
  if (idx >= 0) store.sessions[idx] = session; else store.sessions.unshift(session);
  saveStore(store);
}


function removeSession(id: string) {
  const store = loadStore();
  store.sessions = store.sessions.filter((s) => s.id !== id);
  saveStore(store);
}

// ---------- Utilities ----------
const fmtTime = (sec: number) => {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

const now = () => Date.now();

function classNames(...xs: (string | false | null | undefined)[]) {
  return xs.filter(Boolean).join(" ");
}

// ---------- Core Component ----------
export default function MCQSimulator() {
  const [view, setView] = useState<"setup" | "quiz" | "review" | "history" | "detail">("setup");
  const [sessionName, setSessionName] = useState("");
  const [startNum, setStartNum] = useState<number>(1);
  const [endNum, setEndNum] = useState<number>(20);
  const [minutes, setMinutes] = useState<number>(30);

  // Live quiz state
  const [sessionId, setSessionId] = useState<string>("");
  const [currentIdx, setCurrentIdx] = useState(0);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [perQSec, setPerQSec] = useState<number[]>([]);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [endedAt, setEndedAt] = useState<number | null>(null);
  const [deadline, setDeadline] = useState<number | null>(null);
  
  const totalQuestions = Math.max(0, endNum - startNum + 1);

  // Track time on the active question
  const tickRef = useRef<number | null>(null);
  useEffect(() => {
    if (view !== "quiz") return;
    if (!deadline) return;
    const i = window.setInterval(() => {
      const leftMs = Math.max(0, deadline - now());
      if (leftMs <= 0) {
        window.clearInterval(i);
        // auto submit
        handleSubmit();
        return;
      }
      setPerQSec((prev) => {
        const copy = prev.slice();
        copy[currentIdx] = (copy[currentIdx] ?? 0) + 1; // add 1s to current question
        return copy;
      });
    }, 1000);
    tickRef.current = i;
    return () => { if (tickRef.current) window.clearInterval(tickRef.current); };
  }, [view, deadline, currentIdx]);

  

  const remainingSec = Math.max(0, deadline ? Math.ceil((deadline - now()) / 1000) : minutes * 60);

  // ---------- Handlers ----------
  function startQuiz() {
    if (Number.isNaN(startNum) || Number.isNaN(endNum) || startNum > endNum) return alert("Check your question range.");
    if (minutes <= 0) return alert("Timer must be positive.");

    const N = endNum - startNum + 1;
    const initAnswers: Answer[] = Array.from({ length: N }, () => ({ choice: null, other: "" }));
    const initPerQ = Array.from({ length: N }, () => 0);

    const id = crypto.randomUUID();
    setSessionId(id);
    setAnswers(initAnswers);
    setPerQSec(initPerQ);
    setCurrentIdx(0);
    const t0 = now();
    setStartedAt(t0);
    setEndedAt(null);
    setDeadline(t0 + minutes * 60 * 1000);
    setView("quiz");

    // Create placeholder session immediately (so it's in history even if timeout closes page)
    const meta: SessionMeta = {
      id,
      name: sessionName.trim() || `Session ${new Date(t0).toLocaleString()}`,
      startNum,
      endNum,
      startedAt: t0,
      minutes,
      perQuestionSec: initPerQ,
      answers: initAnswers,
      version: 1,
    };
    upsertSession(meta);
  }

  function setChoice(idx: number, letter: Letter) {
    setAnswers((prev) => {
      const next = prev.slice();
      next[idx] = { ...next[idx], choice: letter };
      return next;
    });
  }

  function setOther(idx: number, text: string) {
    setAnswers((prev) => {
      const next = prev.slice();
      next[idx] = { ...next[idx], other: text };
      return next;
    });
  }

  function nav(delta: number) {
    setCurrentIdx((i) => Math.min(Math.max(0, i + delta), totalQuestions - 1));
  }

  function jumpTo(idx: number) { setCurrentIdx(idx); }

  function handleSubmit() {
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
      version: 1,
    };
    upsertSession(meta);
    setEndedAt(t1);
    setDeadline(null);
    setView("review");
  }

  function updateScore(session: SessionMeta, correct: number) {
    const updated = { ...session, score: { correct, total: session.endNum - session.startNum + 1 } };
    upsertSession(updated);
    if (detail && detail.id === session.id) setDetail(updated);
  }

  // History & detail
  const [detail, setDetail] = useState<SessionMeta | null>(null);
  
  // ---------- Derived ----------
  const questionNumbers = useMemo(() => Array.from({ length: totalQuestions }, (_, i) => startNum + i), [startNum, totalQuestions]);

  // ---------- UI ----------
  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 antialiased selection:bg-neutral-800">
      <TopBar view={view} onNavigate={setView} />

      <main className="mx-auto max-w-5xl px-4 pb-24 pt-8">
        {view === "setup" && (
          <Card className="p-6">
            <h1 className="text-2xl font-semibold tracking-tight">MCQ Session Setup</h1>
            <p className="mt-1 text-sm text-neutral-400">Minimalist, keyboard-friendly, and fast.</p>
            <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <LabeledInput label="Session name (optional)" placeholder="e.g. ESAT M1 Set A" value={sessionName} onChange={setSessionName} />
              <LabeledNumber label="Timer (minutes)" min={1} value={minutes} onChange={setMinutes} />
              <LabeledNumber label="Start question #" min={-9999} value={startNum} onChange={setStartNum} />
              <LabeledNumber label="End question # (inclusive)" min={-9999} value={endNum} onChange={setEndNum} />
            </div>
            <div className="mt-6 flex items-center justify-between gap-3">
              <div className="text-xs text-neutral-400">Range size: <span className="text-neutral-200 font-medium">{totalQuestions}</span></div>
              <div className="flex gap-2">
                <Button onClick={() => { setView("history"); }}>View history</Button>
                <Button variant="primary" onClick={startQuiz}>Start</Button>
              </div>
            </div>
          </Card>
        )}

        {view === "quiz" && (
          <div className="space-y-6">
            <Card className="p-5 flex items-center justify-between">
              <div className="text-sm text-neutral-400">Time left</div>
              <div className="text-4xl font-bold tabular-nums tracking-tight">{fmtTime(remainingSec)}</div>
              <div className="text-sm text-neutral-400">Session {sessionName || "(unnamed)"}</div>
            </Card>

            <Card className="p-6">
              <div className="mb-4 flex items-center gap-4">
                <div className="rounded bg-indigo-900 px-5 py-2 text-2xl font-extrabold text-white shadow">
                  Question {questionNumbers[currentIdx]}
                </div>
              </div>

             <div className="grid grid-flow-col auto-cols-fr gap-3 overflow-x-auto">
                {LETTERS.map((L) => (
                  <ChoicePill key={L}
                    letter={L}
                    selected={answers[currentIdx]?.choice === L}
                    onClick={() => setChoice(currentIdx, L)}
                  />
                ))}
              </div>

              <div className="mt-5">
                <label className="text-sm text-neutral-400">Other / notes</label>
                <input
                  value={answers[currentIdx]?.other ?? ""}
                  onChange={(e) => setOther(currentIdx, e.target.value)}
                  placeholder="Type anything (e.g., 'unsure between C/D')"
                  className="mt-1 w-full rounded-xl bg-neutral-900/60 px-3 py-2 outline-none ring-1 ring-neutral-800 focus:ring-2 focus:ring-neutral-600"
                />
              </div>

              <div className="mt-6 flex items-center justify-between gap-3">
                <div className="text-xs text-neutral-500">Time on this question: <span className="text-neutral-300 tabular-nums">{fmtTime(perQSec[currentIdx] ?? 0)}</span></div>
                <div className="flex gap-2">
                  <Button variant="primary" onClick={() => handleSubmit()}>Submit</Button>
                  <Button onClick={() => nav(-1)} disabled={currentIdx === 0}>Prev</Button>
                  <Button onClick={() => nav(+1)} disabled={currentIdx === totalQuestions - 1}>Next</Button>
                </div>
              </div>
            </Card>

            <Card className="p-5">
              <div className="mb-3 text-sm text-neutral-400">Quick jump</div>
              <div className="grid grid-cols-6 gap-2 sm:grid-cols-10 md:grid-cols-14">
                {questionNumbers.map((q, i) => (
                  <button key={q}
                    onClick={() => jumpTo(i)}
                    className={classNames(
                      "rounded-lg px-2 py-2 text-sm tabular-nums ring-1",
                      currentIdx === i ? "bg-neutral-100 text-neutral-900 ring-neutral-200" : answers[i]?.choice ? "bg-neutral-900 ring-neutral-800" : "bg-neutral-950 ring-neutral-900 hover:bg-neutral-900"
                    )}
                    title={`Q${q}`}
                  >{q}</button>
                ))}
              </div>
            </Card>
          </div>
        )}

        {view === "review" && (
          <div className="space-y-6">
            <HeaderBlock title="Review & Edit" subtitle="Compact summary. Click to change any answer." />
            <Card className="p-4">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
                {questionNumbers.map((q, i) => (
                  <div key={q} className="flex items-center justify-between rounded-xl bg-neutral-900/50 p-3">
                    <div className="text-sm"><span className="text-neutral-400">{q}.</span> <span className="font-medium">{answers[i]?.choice ?? "—"}</span></div>
                    <div className="flex items-center gap-2">
                      <div className="text-xs text-neutral-500 tabular-nums">{fmtTime(perQSec[i] ?? 0)}</div>
                      <div className="flex overflow-hidden rounded-lg ring-1 ring-neutral-800">
                        {LETTERS.map((L) => (
                          <button key={L}
                            className={classNames(
                              "px-2 py-1 text-xs",
                              answers[i]?.choice === L ? "bg-neutral-100 text-neutral-900" : "hover:bg-neutral-800"
                            )}
                            onClick={() => setChoice(i, L)}
                          >{L}</button>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-4 text-right">
                <Button onClick={() => setView("setup")}>New session</Button>
                <Button variant="primary" className="ml-2" onClick={() => {
                  // persist the latest edits
                  if (!sessionId || startedAt == null) return;
                  const meta: SessionMeta = {
                    id: sessionId,
                    name: sessionName.trim() || `Session ${new Date(startedAt).toLocaleString()}`,
                    startNum,
                    endNum,
                    startedAt,
                    endedAt: endedAt ?? now(),
                    minutes,
                    perQuestionSec: perQSec,
                    answers,
                    version: 1,
                  };
                  upsertSession(meta);
                  setView("history");
                }}>Save to history</Button>
              </div>
            </Card>
          </div>
        )}

        {view === "history" && (
          <HistoryView onOpen={(s) => { setDetail(s); setView("detail"); }} />
        )}

        {view === "detail" && detail && (
          <SessionDetail
            session={detail}
            onBack={() => setView("history")}
            onDelete={(id) => { removeSession(id); setDetail(null); setView("history"); }}
            onSave={(s) => { upsertSession(s); setDetail(s); }}
            onUpdateScore={updateScore}
          />
        )}
      </main>

      <Footer />
    </div>
  );
}

// ---------- UI Building Blocks ----------
function TopBar({ view, onNavigate }: { view: string; onNavigate: (v: any) => void; }) {
  return (
    <header className="sticky top-0 z-10 border-b border-neutral-900/80 bg-neutral-950/70 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 rounded-full bg-emerald-400"></div>
          <span className="text-sm font-medium tracking-wide text-neutral-300">MCQ Simulator</span>
        </div>
        <nav className="flex gap-1">
          <NavBtn active={view === "setup"} onClick={() => onNavigate("setup")}>Setup</NavBtn>
          <NavBtn active={view === "quiz"} onClick={() => onNavigate("quiz")}>Quiz</NavBtn>
          <NavBtn active={view === "review"} onClick={() => onNavigate("review")}>Review</NavBtn>
          <NavBtn active={view === "history"} onClick={() => onNavigate("history")}>History</NavBtn>
        </nav>
      </div>
    </header>
  );
}

function NavBtn({ active, children, onClick }: React.PropsWithChildren<{ active?: boolean; onClick?: () => void }>) {
  return (
    <button onClick={onClick}
      className={classNames(
        "rounded-full px-3 py-1 text-sm transition",
        active ? "bg-neutral-100 text-neutral-900" : "text-neutral-300 hover:bg-neutral-900"
      )}
    >{children}</button>
  );
}

function Card({ className, children }: React.PropsWithChildren<{ className?: string }>) {
  return (
    <div className={classNames("rounded-2xl border border-neutral-900 bg-neutral-950", className)}>{children}</div>
  );
}

function Button({ children, variant = "ghost", className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "ghost" | "primary" }) {
  const base = "rounded-xl px-3 py-2 text-sm ring-1 ring-neutral-800 transition disabled:opacity-50";
  const styles = variant === "primary"
    ? "bg-neutral-100 text-neutral-900 hover:brightness-95 ring-neutral-200"
    : "bg-neutral-950 text-neutral-200 hover:bg-neutral-900";
  return (
    <button className={classNames(base, styles, className)} {...props}>{children}</button>
  );
}

function LabeledInput({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="block">
      <div className="text-sm text-neutral-400">{label}</div>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        className="mt-1 w-full rounded-xl bg-neutral-900/60 px-3 py-2 outline-none ring-1 ring-neutral-800 focus:ring-2 focus:ring-neutral-600" />
    </label>
  );
}

function LabeledNumber({ label, value, onChange, min }: { label: string; value: number; onChange: (v: number) => void; min?: number }) {
  return (
    <label className="block">
      <div className="text-sm text-neutral-400">{label}</div>
      <input type="number" value={value} min={min} onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full rounded-xl bg-neutral-900/60 px-3 py-2 outline-none ring-1 ring-neutral-800 focus:ring-2 focus:ring-neutral-600" />
    </label>
  );
}

function ChoicePill({ letter, selected, onClick }: { letter: Letter; selected?: boolean; onClick?: () => void }) {
  return (
    <button onClick={onClick}
      className={classNames(
        "rounded-2xl px-4 py-3 text-center text-base font-medium ring-1 transition",
        selected ? "bg-neutral-100 text-neutral-900 ring-neutral-200" : "bg-neutral-950 text-neutral-100 ring-neutral-900 hover:bg-neutral-900"
      )}
    >{letter}</button>
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

// ---------- History ----------
function HistoryView({ onOpen }: { onOpen: (s: SessionMeta) => void }) {
  const sessions = loadStore().sessions;
  if (sessions.length === 0) {
    return (
      <Card className="p-8 text-center text-neutral-400">No sessions yet. Create one from <span className="text-neutral-200">Setup</span>.</Card>
    );
  }
  return (
    <div className="space-y-4">
      <HeaderBlock title="History" subtitle="Compact list of past sessions. Click to open." />
      {sessions.map((s) => (
        <Card key={s.id} className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium">{s.name}</div>
              <div className="text-xs text-neutral-500">{new Date(s.startedAt).toLocaleString()} • Q{s.startNum}–{s.endNum} • {s.minutes} min</div>
            </div>
            <div className="flex items-center gap-3">
              {s.score ? (
                <div className="rounded-full bg-neutral-900 px-3 py-1 text-xs">Score: {s.score.correct}/{s.score.total}</div>
              ) : (
                <div className="rounded-full bg-neutral-900 px-3 py-1 text-xs text-neutral-400">No score saved</div>
              )}
              <Button onClick={() => onOpen(s)}>Open</Button>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

function SessionDetail({ session, onBack, onDelete, onSave, onUpdateScore }: {
  session: SessionMeta;
  onBack: () => void;
  onDelete: (id: string) => void;
  onSave: (s: SessionMeta) => void;
  onUpdateScore: (s: SessionMeta, correct: number) => void;
}) {
  const [local, setLocal] = useState<SessionMeta>(session);
  useEffect(() => setLocal(session), [session]);

  const total = local.endNum - local.startNum + 1;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <HeaderBlock title={local.name} subtitle={`Q${local.startNum}–${local.endNum} • ${local.minutes} min • ${new Date(local.startedAt).toLocaleString()}`} />
        <div className="flex gap-2">
          <Button onClick={onBack}>Back</Button>
          <Button onClick={() => onDelete(local.id)}>Delete</Button>
          <Button variant="primary" onClick={() => onSave(local)}>Save</Button>
        </div>
      </div>

      <Card className="p-4">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
          {Array.from({ length: total }, (_, i) => i).map((i) => {
            const qn = local.startNum + i;
            const ans = local.answers[i];
            return (
              <div key={i} className="flex items-center justify-between rounded-xl bg-neutral-900/50 p-3">
                <div className="text-sm"><span className="text-neutral-400">{qn}.</span> <span className="font-medium">{ans?.choice ?? "—"}</span></div>
                <div className="flex items-center gap-2">
                  <div className="text-xs text-neutral-500 tabular-nums">{fmtTime(local.perQuestionSec[i] ?? 0)}</div>
                  <div className="flex overflow-hidden rounded-lg ring-1 ring-neutral-800">
                    {LETTERS.map((L) => (
                      <button key={L}
                        className={classNames("px-2 py-1 text-xs", ans?.choice === L ? "bg-neutral-100 text-neutral-900" : "hover:bg-neutral-800")}
                        onClick={() => {
                          const copy = { ...local };
                          const arr = copy.answers.slice();
                          arr[i] = { ...arr[i], choice: L };
                          copy.answers = arr;
                          setLocal(copy);
                        }}
                      >{L}</button>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <Card className="p-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block">
            <div className="text-sm text-neutral-400">Rename session</div>
            <input value={local.name} onChange={(e) => setLocal({ ...local, name: e.target.value })}
              className="mt-1 w-full rounded-xl bg-neutral-900/60 px-3 py-2 outline-none ring-1 ring-neutral-800 focus:ring-2 focus:ring-neutral-600" />
          </label>

          <div className="flex items-end gap-2">
            <label className="block w-full">
              <div className="text-sm text-neutral-400">Score (correct)</div>
              <input type="number" min={0} max={total}
                value={local.score?.correct ?? ""}
                onChange={(e) => setLocal({ ...local, score: { correct: Number(e.target.value || 0), total } })}
                className="mt-1 w-full rounded-xl bg-neutral-900/60 px-3 py-2 outline-none ring-1 ring-neutral-800 focus:ring-2 focus:ring-neutral-600" />
            </label>
            <div className="text-sm text-neutral-500">/ {total}</div>
            <Button onClick={() => onUpdateScore(local, local.score?.correct ?? 0)}>Save score</Button>
          </div>
        </div>

        <label className="mt-4 block">
          <div className="text-sm text-neutral-400">Notes</div>
          <textarea rows={4}
            value={local.notes ?? ""}
            onChange={(e) => setLocal({ ...local, notes: e.target.value })}
            className="mt-1 w-full rounded-xl bg-neutral-900/60 px-3 py-2 outline-none ring-1 ring-neutral-800 focus:ring-2 focus:ring-neutral-600" />
        </label>
      </Card>
    </div>
  );
}
