import express from "express";
import type { Request, Response, NextFunction } from "express";
import { userFormSchema, normalizeForm } from "../shared/schema.js";
import type { Role } from "../shared/schema.js";
import * as store from "./store.js";
import {
  MUTATIONS,
  filterIssues,
  getActiveMutations,
  hasBehavior,
  setActiveMutations,
} from "./mutations.js";

const app = express();
app.use(express.json());

const PORT = Number(process.env.DEMO_PORT ?? 4000);

interface Principal {
  id: number;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      principal?: Principal;
    }
  }
}

function encodeToken(p: Principal): string {
  return Buffer.from(JSON.stringify(p)).toString("base64url");
}

function decodeToken(token: string): Principal | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (typeof parsed?.id === "number" && typeof parsed?.role === "string") {
      return parsed as Principal;
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.header("authorization");
  if (header?.startsWith("Bearer ")) {
    req.principal = decodeToken(header.slice("Bearer ".length));
  }
  next();
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.principal) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  next();
}

app.use(authenticate);

/** Field-keyed errors, the shape the form renders directly. */
function fieldErrors(issues: { path: (string | number)[]; message: string }[]) {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? "_");
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}

// --- Auth ------------------------------------------------------------------

app.post("/api/login", (req, res) => {
  const email = String(req.body?.email ?? "");
  const password = String(req.body?.password ?? "");

  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }

  const user = store.findByEmail(email);
  // REQ-6.2 — the message must not reveal whether the email exists.
  if (!user || user.password !== password) {
    res.status(401).json({ error: "Email or password is incorrect" });
    return;
  }
  // REQ-3.3 — a suspended account cannot sign in.
  if (user.status === "suspended") {
    res.status(403).json({ error: "This account is suspended" });
    return;
  }

  res.json({
    token: encodeToken({ id: user.id, role: user.role }),
    user: store.publicView(user),
  });
});

// --- Directory -------------------------------------------------------------

app.get("/api/users", requireAuth, (req, res) => {
  const search = String(req.query.search ?? "").trim().toLowerCase();
  const role = String(req.query.role ?? "").trim();
  const page = Math.max(1, Number(req.query.page ?? 1) || 1);
  const perPage = 10; // REQ-5.4

  let rows = store.all().map(store.publicView);

  if (search) {
    // REQ-5.2 — case-insensitive partial match on name or email.
    rows = rows.filter(
      (u) =>
        u.fullName.toLowerCase().includes(search) ||
        u.email.toLowerCase().includes(search),
    );
  }
  if (role) {
    rows = rows.filter((u) => u.role === role); // REQ-5.3
  }

  const total = rows.length;
  const start = (page - 1) * perPage;

  res.json({
    users: rows.slice(start, start + perPage),
    total,
    page,
    perPage,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
  });
});

app.get("/api/users/:id", requireAuth, (req, res) => {
  const user = store.find(Number(req.params.id));
  if (!user) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(store.publicView(user));
});

app.patch("/api/users/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const existing = store.find(id);
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const input = normalizeForm(req.body ?? {});

  // REQ-4.4 — every rule is enforced here, whatever the browser did.
  const parsed = userFormSchema.safeParse(input);
  if (!parsed.success) {
    const issues = filterIssues(parsed.error.issues, input);
    if (issues.length > 0) {
      res.status(422).json({ errors: fieldErrors(issues) });
      return;
    }
  }

  // REQ-2.4 — email uniqueness.
  const email = String(input.email ?? "");
  if (!hasBehavior("skip-email-unique") && store.emailTakenByOther(email, id)) {
    res.status(409).json({
      errors: { email: "That email is already in use" },
    });
    return;
  }

  // REQ-3.2 — only an administrator may change account status.
  const statusChanged = input.status !== undefined && input.status !== existing.status;
  if (
    statusChanged &&
    !hasBehavior("skip-status-permission") &&
    req.principal?.role !== "admin"
  ) {
    res.status(403).json({
      errors: { status: "Only an administrator can change account status" },
    });
    return;
  }

  const next: Record<string, unknown> = {
    ...(parsed.success ? parsed.data : input),
  };
  // Absent optional fields are cleared, not left stale.
  for (const key of ["phone", "department", "dateOfBirth", "bio"]) {
    if (!(key in input)) next[key] = undefined;
  }

  if (hasBehavior("drop-phone-on-save")) {
    delete next.phone; // 200 OK, nothing saved. REQ-4.1.
  }

  const saved = store.replace(id, next);
  res.json(store.publicView(saved));
});

// --- Test control plane ----------------------------------------------------
// Present only so the harness can establish known state. See PLAN.md § State management.

app.post("/__test__/reset", (req, res) => {
  const fixture = String(req.body?.fixture ?? "users.basic");
  try {
    store.reset(fixture as never);
    setActiveMutations([]);
    res.json({ ok: true, fixture });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

app.get("/__test__/mutations", (_req, res) => {
  res.json({
    active: getActiveMutations(),
    available: MUTATIONS.map((m) => ({
      id: m.id,
      description: m.description,
      specRef: m.specRef,
      class: m.class,
    })),
  });
});

app.post("/__test__/mutations", (req, res) => {
  const ids: string[] = Array.isArray(req.body?.active) ? req.body.active : [];
  try {
    res.json({ active: setActiveMutations(ids) });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

app.post("/__test__/token", (req, res) => {
  const user = store.find(Number(req.body?.id));
  if (!user) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ token: encodeToken({ id: user.id, role: user.role }) });
});

app.listen(PORT, () => {
  console.log(`[demo] API listening on http://localhost:${PORT}`);
});
