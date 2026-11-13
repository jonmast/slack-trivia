// Grade a sample of Trivia API questions by hand, to check screening against.
// Progress is saved after every answer; run it again to pick up where you left
// off. Data lives in .grading/ (gitignored).
//
//   pnpm grade                 -> grade the pool, fetching 50 questions first if empty
//   pnpm grade --more 25       -> add 25 fresh questions to the pool, then grade
//   pnpm grade --review        -> step through already-graded questions again
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Schema } from "effect";

const TRIVIA_API_URL = "https://the-trivia-api.com/v2/questions";
const DEFAULT_POOL_SIZE = 50;

const dataDir = join(__dirname, "..", ".grading");
const poolPath = join(dataDir, "questions.json");
const gradesPath = join(dataDir, "grades.json");

const PoolQuestion = Schema.Struct({
  id: Schema.String,
  category: Schema.String,
  difficulty: Schema.String,
  correctAnswer: Schema.String,
  incorrectAnswers: Schema.Array(Schema.String),
  question: Schema.Struct({ text: Schema.String }),
});

type PoolQuestion = typeof PoolQuestion.Type;

const Verdict = Schema.Literals(["good", "misleading", "garbled", "stale", "giveaway", "other"]);

type Verdict = typeof Verdict.Type;

const Grade = Schema.Struct({
  verdict: Verdict,
  note: Schema.optional(Schema.String),
  gradedAt: Schema.String,
});

type Grade = typeof Grade.Type;

const decodePool = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(PoolQuestion)));

const decodeGrades = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Grade)),
);

const KEYS: ReadonlyArray<[string, Verdict, string]> = [
  ["1", "good", "fine as is"],
  ["2", "misleading", "points to a wrong option, wrong/debatable answer, or several defensible"],
  ["3", "garbled", "broken text or encoding, options that don't fit"],
  ["4", "stale", "answer depends on the current date"],
  ["5", "giveaway", "only one option is plausible"],
  ["6", "other", "bad for another reason (add a note)"],
];

/** Write via a temp file so a crash mid-write never loses earlier grades. */
function save(path: string, json: string): void {
  writeFileSync(`${path}.tmp`, `${json}\n`);
  renameSync(`${path}.tmp`, path);
}

function loadPool(): PoolQuestion[] {
  return existsSync(poolPath) ? [...decodePool(readFileSync(poolPath, "utf8"))] : [];
}

function loadGrades(): Record<string, Grade> {
  return existsSync(gradesPath) ? { ...decodeGrades(readFileSync(gradesPath, "utf8")) } : {};
}

async function fetchQuestions(count: number): Promise<readonly PoolQuestion[]> {
  const response = await fetch(`${TRIVIA_API_URL}?limit=${count}`);

  if (!response.ok) throw new Error(`Trivia API answered ${response.status}`);

  return Schema.decodeUnknownSync(Schema.Array(PoolQuestion))(await response.json());
}

async function growPool(pool: PoolQuestion[], count: number): Promise<void> {
  const known = new Set(pool.map((question) => question.id));
  const fresh = (await fetchQuestions(count)).filter((question) => !known.has(question.id));

  pool.push(...fresh);
  save(poolPath, JSON.stringify(pool, null, 2));
  console.log(`Added ${fresh.length} questions; the pool has ${pool.length}.`);
}

function show(question: PoolQuestion, position: string, previous: Grade | undefined): void {
  console.log(`\n────────── ${position} · ${question.category} / ${question.difficulty} · ${question.id}`);
  console.log(`\n${question.question.text}\n`);
  console.log(`  ✅ ${question.correctAnswer}`);

  for (const answer of question.incorrectAnswers) console.log(`  ·  ${answer}`);

  if (previous) {
    console.log(`\n  (graded ${previous.verdict}${previous.note ? `: ${previous.note}` : ""})`);
  }
}

function summary(pool: PoolQuestion[], grades: Record<string, Grade>): string {
  const counts = new Map<string, number>();

  for (const question of pool) {
    const verdict = grades[question.id]?.verdict ?? "ungraded";
    counts.set(verdict, (counts.get(verdict) ?? 0) + 1);
  }

  return Array.from(counts, ([verdict, n]) => `${verdict} ${n}`).join(" · ");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const moreIndex = args.indexOf("--more");
  const review = args.includes("--review");

  mkdirSync(dataDir, { recursive: true });
  const pool = loadPool();
  const grades = loadGrades();

  if (moreIndex >= 0) {
    await growPool(pool, Number(args[moreIndex + 1] ?? DEFAULT_POOL_SIZE));
  } else if (pool.length === 0) {
    await growPool(pool, DEFAULT_POOL_SIZE);
  }

  const queue = review ? pool.filter((q) => grades[q.id]) : pool.filter((q) => !grades[q.id]);

  if (queue.length === 0) {
    console.log(`Nothing to grade. ${summary(pool, grades)}`);
    console.log("Run with --more N to add questions, or --review to revisit grades.");

    return;
  }

  const rl = createInterface({ input: stdin, output: stdout });
  const help = KEYS.map(([key, verdict, meaning]) => `  ${key} ${verdict.padEnd(10)} ${meaning}`).join("\n");

  console.log(`${queue.length} to ${review ? "review" : "grade"}. ${summary(pool, grades)}`);
  console.log(`${help}\n  s skip · b back · q quit (progress is saved after every answer)`);

  let index = 0;

  while (index < queue.length) {
    const question = queue[index];
    show(question, `${index + 1}/${queue.length}`, grades[question.id]);

    const input = (await rl.question("\ngrade> ")).trim().toLowerCase();

    if (input === "q") break;

    if (input === "s") {
      index += 1;
      continue;
    }

    if (input === "b") {
      index = Math.max(0, index - 1);
      continue;
    }

    const key = KEYS.find(([k]) => k === input);

    if (!key) {
      console.log(`Unknown input "${input}".\n${help}`);
      continue;
    }

    const verdict = key[1];
    const note = verdict === "good" ? "" : (await rl.question("note (optional)> ")).trim();

    const gradedAt = new Date().toISOString();
    grades[question.id] = note ? { verdict, note, gradedAt } : { verdict, gradedAt };

    save(gradesPath, JSON.stringify(grades, null, 2));
    index += 1;
  }

  rl.close();
  console.log(`\nSaved to ${gradesPath}. ${summary(pool, grades)}`);
}

void main();
