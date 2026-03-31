import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { motion } from "framer-motion";
import { UserPlus } from "lucide-react";

const Signup = () => {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    const { signup } = useAuth();
    const navigate = useNavigate();

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError("");

        if (password !== confirmPassword) {
            setError("Passwords do not match");
            return;
        }

        if (password.length < 6) {
            setError("Password must be at least 6 characters");
            return;
        }

        setLoading(true);
        try {
            await signup(email, password);
            navigate("/");
        } catch (err) {
            setError(err.response?.data?.error || "Signup failed");
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
                    <h2>Create Account</h2>
                    <p className="signup-bonus">Get ₹10,00,000 virtual balance to start trading!</p>
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
                            placeholder="Create a password"
                            required
                        />
                    </div>
                    <div className="form-group">
                        <label htmlFor="confirmPassword">Confirm Password</label>
                        <input
                            id="confirmPassword"
                            type="password"
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            placeholder="Confirm your password"
                            required
                        />
                    </div>
                    <button type="submit" className="btn-primary flex justify-center items-center gap-2" disabled={loading}>
                        <UserPlus size={18} /> {loading ? "Creating Account..." : "Create Account"}
                    </button>
                    <p className="auth-switch">
                        Already have an account? <Link to="/login">Sign In</Link>
                    </p>
                </form>
            </motion.div>
        </div>
    );
};

export default Signup;

/*
 * signup page. has fields for email, password, confirm password.
 * shows the ten lakh virtual balance bonus message. on submit it
 * creates the account via auth context and redirects to dashboard.
 * animated card entrance with framer-motion. route is /signup.
 */
