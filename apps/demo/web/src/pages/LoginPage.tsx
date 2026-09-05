import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const { signIn } = useAuth();
  const navigate = useNavigate();

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const { token } = await api.login(email, password);
      signIn(token);
      navigate("/users"); // REQ-6.3
    } catch (caught) {
      const body = (caught as { body?: { error?: string } }).body;
      setError(body?.error ?? "Email or password is incorrect");
    }
  }

  return (
    <main className="page page--narrow">
      <h1>Sign in</h1>
      <form onSubmit={onSubmit} noValidate data-testid="login-form">
        <div className="field">
          <label htmlFor="login-email">Email</label>
          <input
            id="login-email"
            data-testid="login-email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            type="password"
            data-testid="login-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error ? (
          <p className="error" data-testid="login-error">
            {error}
          </p>
        ) : null}
        <button type="submit" data-testid="login-submit">
          Sign in
        </button>
      </form>
    </main>
  );
}
