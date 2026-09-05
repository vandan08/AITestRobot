import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { ROLES } from "../../../shared/schema";

export default function UsersPage() {
  const [users, setUsers] = useState<Array<Record<string, unknown>>>([]);
  const [search, setSearch] = useState("");
  const [role, setRole] = useState("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (role) params.set("role", role);
    params.set("page", String(page));

    let cancelled = false;
    api.listUsers(params).then((result) => {
      if (cancelled) return;
      setUsers(result.users);
      setTotalPages(result.totalPages);
      setTotal(result.total);
    });
    return () => {
      cancelled = true;
    };
  }, [search, role, page]);

  return (
    <main className="page">
      <h1>Staff directory</h1>

      <div className="filters">
        <label htmlFor="search">Search</label>
        <input
          id="search"
          data-testid="search"
          placeholder="Name or email"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />

        <label htmlFor="role-filter">Role</label>
        <select
          id="role-filter"
          data-testid="role-filter"
          value={role}
          onChange={(e) => {
            setRole(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All roles</option>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>

      {users.length === 0 ? (
        // REQ-5.5 — say so, rather than showing an empty table.
        <p data-testid="empty-state">No staff match that search.</p>
      ) : (
        <table data-testid="users-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Department</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={String(user.id)} data-testid={`user-row-${user.id}`}>
                <td>{String(user.fullName ?? "")}</td>
                <td>{String(user.email ?? "")}</td>
                <td>{String(user.role ?? "")}</td>
                <td>{String(user.department ?? "")}</td>
                <td>{String(user.status ?? "")}</td>
                <td>
                  <Link
                    to={`/users/${user.id}/edit`}
                    data-testid={`edit-${user.id}`}
                  >
                    Edit
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="pager">
        <button
          type="button"
          data-testid="prev-page"
          disabled={page <= 1}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
        >
          Previous
        </button>
        <span data-testid="page-indicator">
          Page {page} of {totalPages}
        </span>
        <button
          type="button"
          data-testid="next-page"
          disabled={page >= totalPages}
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
        >
          Next
        </button>
        <span data-testid="total-count">{total} staff</span>
      </div>
    </main>
  );
}
