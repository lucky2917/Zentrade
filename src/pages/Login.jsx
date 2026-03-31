import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { motion } from "framer-motion";
import { LogIn } from "lucide-react";

const Login = () => {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    const { login } = useAuth();
    const navigate = useNavigate();

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError("");
        setLoading(true);
        try {
            await login(email, password);
            navigate("/");
        } catch (err) {
            setError(err.response?.data?.error || "Login failed");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="auth-container">
            <motion.div
                className="auth-card"
                initial={{ opacity: 0, scale: 0.95, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                transition={{ duration: 0.5, type: "spring", stiffness: 200, damping: 20 }}
            >
                <div className="auth-header">
                    <motion.h1
                        className="auth-logo"
                        initial={{ opacity: 0, y: -10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.2 }}
                    >
                        <span className="logo-zen">Zen</span>
                        <span className="logo-trade">Trade</span>
                    </motion.h1>
                    <p className="auth-subtitle">Paper Trading Platform</p>
                </div>
                <form onSubmit={handleSubmit} className="auth-form">
                    <h2>Welcome Back</h2>
                    {error && <div className="auth-error">{error}</div>}
                    <div className="form-group">
                        <label htmlFor="email">Email</label>
                        <input
                            id="email"
                            type="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            placeholder="Enter your email"
                            required
                        />
                    </div>
                    <div className="form-group">
                        <label htmlFor="password">Password</label>
                        <input
                            id="password"
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder="Enter your password"
                            required
                        />
                    </div>
                    <button type="submit" className="btn-primary flex justify-center items-center gap-2" disabled={loading}>
                        <LogIn size={18} /> {loading ? "Signing in..." : "Sign In"}
                    </button>
                    <p className="auth-switch">
                        Don't have an account? <Link to="/signup">Sign Up</Link>
                    </p>
                </form>
            </motion.div>
        </div>
    );
};

export default Login;

/*
 * login page. email and password form, calls the auth context
 * login function and redirects to dashboard on success. has
 * framer-motion animations for the card entrance and a link
 * to signup at the bottom. route is /login in App.jsx.
 */
