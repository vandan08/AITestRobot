# Demo Application — Requirements

**This document is the assertion oracle.** It is written independently of the
implementation, and it is the *only* source Stage 2 may draw an assertion from when tagging
a test `assertionSource: "spec"`.

It is deliberately written the way a real requirements document is written: in prose, by a
person, with some ambiguity and at least one statement the implementation does not honour.
Finding that mismatch is the point.

---

## 1. Product

An internal staff directory for a healthcare provider. Administrators maintain staff
records; other roles have progressively narrower access.

### Roles

| Role | Description |
|---|---|
| `admin` | Full access. The only role permitted to change account status. |
| `manager` | May edit staff in their own department. |
| `clinician` | Practising clinical staff. May view the directory and edit their own record. |
| `viewer` | Read-only. Not attached to a department. |

---

## 2. User record

- **REQ-2.1** — Every staff member has a full name. It is mandatory and must be between
  2 and 60 characters.
- **REQ-2.2** — Every staff member has an email address. It is mandatory.
- **REQ-2.3** — The email address must be a valid email address. A value that is not a
  well-formed email must be rejected with a visible message, and no save request may be
  sent.
- **REQ-2.4** — Email addresses are unique across the directory. Attempting to save a
  record with an email already belonging to another staff member must be rejected and the
  reason shown to the user.
- **REQ-2.5** — A phone number may be recorded. When present it must be exactly 10 digits.
- **REQ-2.6** — **Clinical staff must have a contactable phone number on file at all
  times.** A clinician record without a phone number is not valid.
- **REQ-2.7** — Every staff member holds exactly one role, from the four roles listed in
  §1. No other value is acceptable.
- **REQ-2.8** — Staff who are not `viewer` belong to a department, and it is mandatory for
  them. Viewers have no department, and the field should not be required of them.
- **REQ-2.9** — A date of birth may be recorded. It must be in the past, and the staff
  member must be at least 18 years old.
- **REQ-2.10** — A short biography may be recorded, up to 500 characters.
- **REQ-2.11** — Each staff member has a notification preference, on or off. It defaults
  to on for new records.

---

## 3. Account status

- **REQ-3.1** — A staff member's account is either `active` or `suspended`.
- **REQ-3.2** — **Only an administrator may change account status.** For every other role
  the control must not be operable, and a status change submitted by a non-administrator
  must be rejected by the server regardless of what the interface allowed.
- **REQ-3.3** — A suspended staff member cannot sign in.

---

## 4. Editing

- **REQ-4.1** — Saving a valid record persists every changed field. After a successful
  save, re-opening the record shows the saved values.
- **REQ-4.2** — Validation messages appear against the field they concern, and identify
  what is wrong.
- **REQ-4.3** — When a record fails validation in the browser, no save request is sent to
  the server.
- **REQ-4.4** — Every rule in §2 and §3 is enforced by the server, whether or not the
  browser enforced it first. The interface is a convenience, not the boundary.
- **REQ-4.5** — A successful save confirms visibly to the user.
- **REQ-4.6** — Leaving the form without saving discards changes; nothing is persisted.

---

## 5. Directory listing

- **REQ-5.1** — The directory lists staff with name, email, role, department and status.
- **REQ-5.2** — The list can be searched by name or email. Search is case-insensitive and
  matches partial values.
- **REQ-5.3** — The list can be filtered by role.
- **REQ-5.4** — The list is paginated at 10 records per page.
- **REQ-5.5** — When a search returns nothing, the interface says so rather than showing an
  empty table.

---

## 6. Sign-in

- **REQ-6.1** — Signing in requires an email address and a password.
- **REQ-6.2** — Invalid credentials are rejected with a message that does not reveal
  whether the email exists.
- **REQ-6.3** — Signing in successfully lands the user on the directory.

---

## Note on REQ-2.6

REQ-2.6 is **not** implemented — the schema marks `phone` optional for every role. This is
deliberate. It is a realistic instance of a requirement that exists in the document and
never reached the code, and it is the reference case for the `DIVERGENCE` verdict: Stage 1
reads `.optional()` off the schema, the spec says clinicians must have one, and the
divergence is reported without a browser ever opening.

Do not "fix" it. It is a fixture.
