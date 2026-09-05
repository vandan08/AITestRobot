import { Navigate, Route, Routes } from "react-router-dom";
import LoginPage from "./pages/LoginPage";
import UsersPage from "./pages/UsersPage";
import EditUserPage from "./pages/EditUserPage";
import { useAuth } from "./auth";

/**
 * Stage 1's route extractor parses this element. Keep the routes as literal
 * `<Route path="…" element={<X />} />` pairs — the shape a real app has.
 */
export default function App() {
  const { token } = useAuth();

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/users"
        element={token ? <UsersPage /> : <Navigate to="/login" replace />}
      />
      <Route
        path="/users/:id/edit"
        element={token ? <EditUserPage /> : <Navigate to="/login" replace />}
      />
      <Route path="/" element={<Navigate to="/users" replace />} />
    </Routes>
  );
}
