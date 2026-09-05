import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { readToken } from "../auth";
import {
  ROLES,
  STATUSES,
  normalizeForm,
  userFormSchema,
} from "../../../shared/schema";
import { activeMutations, filterIssues, loadActiveMutations } from "../mutations";

type Values = {
  fullName: string;
  email: string;
  phone: string;
  role: string;
  department: string;
  dateOfBirth: string;
  bio: string;
  notificationsEnabled: boolean;
  status: string;
};

const EMPTY: Values = {
  fullName: "",
  email: "",
  phone: "",
  role: "viewer",
  department: "",
  dateOfBirth: "",
  bio: "",
  notificationsEnabled: true,
  status: "active",
};

function currentRole(): string {
  const token = readToken();
  if (!token) return "viewer";
  try {
    return JSON.parse(atob(token.replace(/-/g, "+").replace(/_/g, "/"))).role;
  } catch {
    return "viewer";
  }
}

export default function EditUserPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [values, setValues] = useState<Values>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const isAdmin = currentRole() === "admin";

  useEffect(() => {
    let cancelled = false;
    void loadActiveMutations();
    api
      .getUser(id)
      .then((user) => {
        if (cancelled) return;
        setValues({
          fullName: String(user.fullName ?? ""),
          email: String(user.email ?? ""),
          phone: String(user.phone ?? ""),
          role: String(user.role ?? "viewer"),
          department: String(user.department ?? ""),
          dateOfBirth: String(user.dateOfBirth ?? ""),
          bio: String(user.bio ?? ""),
          notificationsEnabled: Boolean(user.notificationsEnabled),
          status: String(user.status ?? "active"),
        });
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [id]);

  function set<K extends keyof Values>(key: K, value: Values[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSaved(false);

    const payload = normalizeForm({ ...values });
    const parsed = userFormSchema.safeParse(payload);

    // REQ-4.3 — nothing is sent when the browser has already found a problem.
    if (!parsed.success) {
      const issues = filterIssues(parsed.error.issues, payload, activeMutations());
      if (issues.length > 0) {
        const next: Record<string, string> = {};
        for (const issue of issues) {
          const key = String(issue.path[0] ?? "_");
          if (!next[key]) next[key] = issue.message;
        }
        setErrors(next);
        return;
      }
    }

    setErrors({});
    try {
      await api.saveUser(id, payload);
      setSaved(true); // REQ-4.5
    } catch (error) {
      const body = (error as { body?: { errors?: Record<string, string>; error?: string } })
        .body;
      setErrors(body?.errors ?? { _: body?.error ?? "Could not save" });
    }
  }

  if (loading) return <main className="page">Loading…</main>;

  return (
    <main className="page">
      <h1>Edit staff record</h1>

      <form onSubmit={onSubmit} noValidate data-testid="edit-user-form">
        <Field label="Full name" name="fullName" error={errors.fullName}>
          <input
            id="fullName"
            data-testid="fullName"
            value={values.fullName}
            onChange={(e) => set("fullName", e.target.value)}
          />
        </Field>

        <Field label="Email" name="email" error={errors.email}>
          <input
            id="email"
            data-testid="email"
            value={values.email}
            onChange={(e) => set("email", e.target.value)}
          />
        </Field>

        <Field label="Phone" name="phone" error={errors.phone}>
          <input
            id="phone"
            data-testid="phone"
            value={values.phone}
            onChange={(e) => set("phone", e.target.value)}
          />
        </Field>

        <Field label="Role" name="role" error={errors.role}>
          <select
            id="role"
            data-testid="role"
            value={values.role}
            onChange={(e) => set("role", e.target.value)}
          >
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Department" name="department" error={errors.department}>
          <input
            id="department"
            data-testid="department"
            value={values.department}
            onChange={(e) => set("department", e.target.value)}
          />
        </Field>

        <Field label="Date of birth" name="dateOfBirth" error={errors.dateOfBirth}>
          <input
            id="dateOfBirth"
            data-testid="dateOfBirth"
            placeholder="YYYY-MM-DD"
            value={values.dateOfBirth}
            onChange={(e) => set("dateOfBirth", e.target.value)}
          />
        </Field>

        <Field label="Bio" name="bio" error={errors.bio}>
          <textarea
            id="bio"
            data-testid="bio"
            rows={3}
            value={values.bio}
            onChange={(e) => set("bio", e.target.value)}
          />
        </Field>

        <Field label="Status" name="status" error={errors.status}>
          <select
            id="status"
            data-testid="status"
            value={values.status}
            /* REQ-3.2 — not operable for anyone but an administrator. */
            disabled={!isAdmin}
            onChange={(e) => set("status", e.target.value)}
          >
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </Field>

        <div className="field field--inline">
          <input
            id="notificationsEnabled"
            type="checkbox"
            data-testid="notificationsEnabled"
            checked={values.notificationsEnabled}
            onChange={(e) => set("notificationsEnabled", e.target.checked)}
          />
          <label htmlFor="notificationsEnabled">Notifications enabled</label>
        </div>

        {errors._ ? (
          <p className="error" data-testid="error-form">
            {errors._}
          </p>
        ) : null}

        {saved ? (
          <p className="success" data-testid="save-success">
            Changes saved
          </p>
        ) : null}

        <div className="actions">
          <button type="submit" data-testid="save">
            Save changes
          </button>
          <button
            type="button"
            data-testid="cancel"
            onClick={() => navigate("/users")}
          >
            Cancel
          </button>
        </div>
      </form>
    </main>
  );
}

function Field({
  label,
  name,
  error,
  children,
}: {
  label: string;
  name: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={name}>{label}</label>
      {children}
      {error ? (
        // REQ-4.2 — the message sits against the field it concerns.
        <p className="error" data-testid={`error-${name}`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
