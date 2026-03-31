import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";

const ProtectedRoute = ({ children }) => {
    const { token, loading } = useAuth();

    if (loading) {
        return <div className="loading-screen">Loading...</div>;
    }

    if (!token) {
        return <Navigate to="/login" replace />;
    }

    return children;
};

export default ProtectedRoute;

/*
 * simple route guard. checks if theres a valid token in auth context,
 * if not it redirects to login. shows a loading screen while auth is
 * still initializing. App.jsx wraps all the protected pages with this.
 */
