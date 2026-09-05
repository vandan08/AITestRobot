import type { Role, Status, User } from "../shared/schema.js";

export interface StoredUser extends User {
  password: string;
}

type Fixture = "users.basic" | "users.permissions" | "users.paging";

export const FIXTURES: Fixture[] = [
  "users.basic",
  "users.permissions",
  "users.paging",
];

const DEFAULT_PASSWORD = "password123";

function mk(
  id: number,
  fullName: string,
  email: string,
  role: Role,
  department: string | undefined,
  overrides: Partial<StoredUser> = {},
): StoredUser {
  return {
    id,
    fullName,
    email,
    role,
    department,
    phone: undefined,
    dateOfBirth: undefined,
    bio: undefined,
    notificationsEnabled: true,
    status: "active" as Status,
    password: DEFAULT_PASSWORD,
    ...overrides,
  };
}

function basic(): StoredUser[] {
  return [
    mk(1, "Ada Admin", "ada@clinic.test", "admin", "Operations", {
      phone: "5551230001",
      dateOfBirth: "1985-04-12",
      bio: "Runs the directory.",
    }),
    mk(2, "Manny Manager", "manny@clinic.test", "manager", "Cardiology", {
      phone: "5551230002",
    }),
    mk(3, "Cleo Clinician", "cleo@clinic.test", "clinician", "Cardiology", {
      phone: "5551230003",
      dateOfBirth: "1990-09-30",
    }),
    mk(4, "Vic Viewer", "vic@clinic.test", "viewer", undefined),
    mk(5, "Sam Suspended", "sam@clinic.test", "clinician", "Neurology", {
      status: "suspended",
      phone: "5551230005",
    }),
  ];
}

function permissions(): StoredUser[] {
  return basic();
}

function paging(): StoredUser[] {
  const seed = basic();
  const extra: StoredUser[] = [];
  for (let i = 0; i < 20; i += 1) {
    const n = i + 6;
    extra.push(
      mk(n, `Staff Member ${String(n).padStart(2, "0")}`, `staff${n}@clinic.test`,
        i % 2 === 0 ? "clinician" : "manager",
        i % 2 === 0 ? "Cardiology" : "Radiology",
        { phone: `555123${String(1000 + n).slice(-4)}` }),
    );
  }
  return [...seed, ...extra];
}

const BUILDERS: Record<Fixture, () => StoredUser[]> = {
  "users.basic": basic,
  "users.permissions": permissions,
  "users.paging": paging,
};

let users: StoredUser[] = basic();

export function reset(fixture: Fixture = "users.basic"): void {
  const build = BUILDERS[fixture];
  if (!build) throw new Error(`Unknown fixture: ${fixture}`);
  users = build();
}

export function all(): StoredUser[] {
  return users;
}

export function find(id: number): StoredUser | undefined {
  return users.find((u) => u.id === id);
}

export function findByEmail(email: string): StoredUser | undefined {
  const needle = email.trim().toLowerCase();
  return users.find((u) => u.email.toLowerCase() === needle);
}

/** Another record already holds this email. REQ-2.4. */
export function emailTakenByOther(email: string, selfId: number): boolean {
  const owner = findByEmail(email);
  return Boolean(owner && owner.id !== selfId);
}

export function replace(id: number, next: Partial<StoredUser>): StoredUser {
  const index = users.findIndex((u) => u.id === id);
  if (index === -1) throw new Error(`No user ${id}`);
  users[index] = { ...users[index], ...next };
  return users[index];
}

export function publicView(user: StoredUser): User {
  const { password: _password, ...rest } = user;
  return rest;
}
